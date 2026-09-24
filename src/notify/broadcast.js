// src/notify/broadcast.js
// Broadcasts a paid order to eligible doctors in the matching specialty.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { TEMPLATES } = require('./templates');
// A2 (2026-09-21) — eligibility comes from the canonical helpers, never from
// SQL this file writes on its own: tierSpellings is auto_assign's tier
// predicate vocabulary (X5), capFor is the one definition of a doctor's cap
// (X4), and doctorLoadSql is the load expression the accept gate and every
// admin picker count against that cap.
const { tierSpellings } = require('../auto_assign');
const { capFor } = require('../services/doctor_eligibility');
const { doctorLoadSql } = require('../routes/api/_assign_helpers');

// Tier → notification template. The acceptance WINDOW no longer lives here:
// it moved to src/acceptance_window.js, which is now the only place that
// answers "how long does a doctor have to accept?". This file had 10/60/240
// minutes while case_lifecycle.js had 30/240/1440 for the same three tiers, so
// a case carried two different acceptance deadlines at once and whichever
// worker swept first decided which one applied.
//
// TEMPLATES keeps its NEW_CASE_FASTTRACK identifier — that's a WhatsApp Cloud
// API template id registered separately, independent of the tier rename.
const { acceptanceMinutesForTier, acceptanceDeadlineIso } = require('../acceptance_window');

const TIER_CONFIG = {
  urgent:   { template: TEMPLATES.NEW_CASE_URGENT },
  vip:      { template: TEMPLATES.NEW_CASE_FASTTRACK },
  standard: { template: TEMPLATES.NEW_CASE_STANDARD },
};

function determineTier(order) {
  // AUDIT-P0: `urgency_flag` used to short-circuit to 'urgent' here. It does
  // NOT mean urgent -- every writer sets it to `tier !== 'standard'`
  // (services/wizard_pricing.js:118, routes/api/cases.js), so it is true for
  // VIP too. Two consequences, both live: a VIP case was broadcast on the
  // uncapped urgent fan-out with the urgent template, and the derived value is
  // written back to orders.tier below, which acceptance_window prefers -- so
  // every VIP case got the 15-minute urgent accept window instead of 45.
  // Read the stored tier first; treat the flag only as a weak "not standard".
  // AUDIT-2026-08-22 — .trim() added. Every other reader of this column trims
  // (acceptance_window.normalizeTier, case_lifecycle.markCasePaid,
  // _assign_helpers.normalizeTier); this one did not. A stored 'urgent ' —
  // one trailing space — missed both tier tests, fell through to the
  // urgency_flag branch, and returned 'vip'. That value is then written back to
  // orders.tier by the UPDATE below, and acceptance_window prefers `tier` over
  // `urgency_tier`, so the whitespace durably converted an urgent 4h case into
  // a VIP one: a 45-minute acceptance window instead of 15, on the tier that
  // pays the largest premium for speed.
  var stored = String(order.urgency_tier || '').trim().toLowerCase();
  if (stored === 'urgent') return 'urgent';
  // Legacy alias: orders.urgency_tier may carry 'fast_track' on un-migrated
  // rows (migration 031 backfills); read both, write only 'vip' going forward.
  if (stored === 'vip' || stored === 'fast_track') return 'vip';

  // AUDIT-2026-08-22 — consult sla_hours before the weak flags. sla_hours is
  // the PRICED promise, locked at order creation by the wizard's Step 4 or the
  // mobile API, and it is the only tier signal on an order that reached
  // payment without a tier column set. An order with sla_hours=4 and no tier
  // resolved to standard (or vip via urgency_flag) here, and that wrong value
  // was persisted to orders.tier below — turning a 4-hour urgent case into an
  // 18-hour VIP or a 48-hour standard for every later reader.
  //
  // Buckets are the canonical ones (urgent 4h / vip 18h / standard 48h,
  // docs/PAYOUT_AND_URGENCY_POLICY.md §2) and match
  // acceptance_window.acceptanceMinutesForSlaHours exactly. It may only
  // UPGRADE: a 48h sla_hours does not fall through to 'standard' here, because
  // an order carrying urgency_flag with sla_hours unset or stale should keep
  // the benefit of the doubt rather than be silently downgraded.
  var slaHours = Number(order.sla_hours);
  if (Number.isFinite(slaHours) && slaHours > 0) {
    if (slaHours <= 4) return 'urgent';
    if (slaHours <= 24) return 'vip';
  }

  if (order.sla_24hr_selected) return 'vip';
  if (order.urgency_flag) return 'vip';
  return 'standard';
}

async function broadcastOrderToSpecialty(orderId) {
  // 1. Load order
  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) {
    console.warn('[broadcast] order not found:', orderId);
    return { ok: false, reason: 'order_not_found' };
  }

  // AUDIT-2026-08-22 — do not broadcast a case that already has a doctor.
  //
  // markCasePaid fires enqueueAutoAssign() and broadcastOrderToSpecialty()
  // together, unawaited. When auto-assign wins that race two things went wrong
  // at once: (a) every doctor in the specialty was fanned a "new case
  // available" WhatsApp for a case they cannot take, and (b) the UPDATE below
  // overwrote orders.acceptance_deadline_at with a broadcast-shaped deadline,
  // clobbering the per-assignment one assignDoctor had just written — which is
  // the column acceptance_watcher's expiry sweep reads. Gated today only by
  // auto_assign_enabled being off by default; it arms the moment that flips.
  //
  // The SELECT-side check is the cheap exit; the unassigned predicate on the
  // UPDATE is the one that actually closes the race, because the assign can
  // land between this read and that write.
  //
  // Launch gate 2026-09-15 — that predicate is NULLIF(doctor_id, '') IS NULL.
  // doctor_id is TEXT; '' means nobody holds the case (this JS check already
  // treats it as falsy), but `doctor_id IS NULL` refused the claim, so a paid
  // case with doctor_id = '' was never broadcast.
  if (order.doctor_id) {
    console.warn('[broadcast] order already assigned, skipping:', orderId, order.doctor_id);
    return { ok: false, reason: 'already_assigned' };
  }

  // 2. Confirm paid
  const paymentStatus = String(order.payment_status || '').toLowerCase();
  if (paymentStatus !== 'paid' && paymentStatus !== 'captured') {
    console.warn('[broadcast] order not paid, skipping:', orderId, paymentStatus);
    return { ok: false, reason: 'not_paid' };
  }

  // Theme 14 Phase 5 — orders parked in the superadmin manual queue must
  // not be broadcast to doctors. The patient-picked specialty may be wrong
  // (classifier confidence < minimum) and admin needs to set the correct
  // routing before any doctor sees the case. Admin approval flips the
  // status back to 'auto' and the post-approve flow re-broadcasts.
  if (order.assignment_status === 'manual_queue') {
    console.warn('[broadcast] order in manual_queue, skipping:', orderId);
    return { ok: false, reason: 'manual_queue_pending' };
  }

  // 3. Determine tier
  const tier = determineTier(order);
  const config = TIER_CONFIG[tier];

  // 4. Save tier + broadcast metadata
  const now = new Date();
  const acceptanceMinutes = acceptanceMinutesForTier(tier);
  const acceptanceDeadline = acceptanceDeadlineIso(acceptanceMinutes, now.getTime());

  const claimed = await execute(
    `UPDATE orders
     SET tier = $1,
         broadcast_sent_at = $2,
         broadcast_count = COALESCE(broadcast_count, 0) + 1,
         acceptance_deadline_at = $3,
         updated_at = $2
     WHERE id = $4
       AND NULLIF(doctor_id, '') IS NULL`,
    [tier, now.toISOString(), acceptanceDeadline, orderId]
  );
  // A doctor was assigned between the SELECT above and this UPDATE. Bail
  // BEFORE the fan-out: acceptance_deadline_at now belongs to that assignment
  // and the notification would advertise a case nobody can take.
  if (!claimed || claimed.rowCount === 0) {
    console.warn('[broadcast] order assigned mid-broadcast, skipping fan-out:', orderId);
    return { ok: false, reason: 'already_assigned' };
  }

  // 5. Resolve specialty
  let specialtyId = order.specialty_id;
  if (!specialtyId && order.service_id) {
    const svc = await queryOne('SELECT specialty_id FROM services WHERE id = $1', [order.service_id]);
    specialtyId = svc ? svc.specialty_id : null;
  }
  if (!specialtyId) {
    console.warn('[broadcast] no specialty for order:', orderId);
    return { ok: false, reason: 'no_specialty' };
  }

  // 6. Query eligible doctors
  //
  // A2 (2026-09-21) — ONE query for every tier, and the two answers this file
  // used to hand-roll now come from the canonical helpers:
  //
  //   * Tier (X5): a doctor's sla_tiers_supported switches gate the fan-out
  //     with auto_assign's exact predicate — ?| over tierSpellings(tier),
  //     NULL reading as ["standard"]. Before this, a doctor who turned a
  //     tier OFF in the app still got the WhatsApp/email for it, and the
  //     accept gate (Guardrail 3d) then refused the case the notification
  //     had just invited them to.
  //   * Capacity (X4): capFor, applied in JS below — VIP caps on
  //     max_active_cases exactly as the accept gate, the view rule and every
  //     admin assign gate cap it. The local column-picking (VIP on
  //     max_active_cases_urgent, with its own 5/8 defaults) is DELETED, not
  //     corrected: one definition. That also adopts capFor's fail direction —
  //     NULL/0 means "no cap configured", not "default 5/8". The load is
  //     doctorLoadSql, the same expression the accept gate counts (the old
  //     NOT IN ('completed','cancelled') exclusion counted refunded and
  //     abandoned-draft rows against the cap).
  //
  // GROUP BY u.id dedupes any duplicate (doctor_id, specialty_id) rows in
  // doctor_specialties (no unique constraint on that table; PK grouping makes
  // the other u.* columns legal in the projection).
  const tierAny = tierSpellings(tier);
  const candidates = await queryAll(`
      SELECT u.id, u.name, u.phone, u.notify_whatsapp,
             u.max_active_cases, u.max_active_cases_urgent, u.doctor_max_active_override,
             (
               SELECT COUNT(*) FROM orders_active o
               WHERE o.doctor_id = u.id
                 AND ${doctorLoadSql('o.')}
             ) AS active_load
      FROM users u
      -- 2026-08-25: match on doctor_specialties OR users.specialty_id.
      --
      -- doctor_specialties is written in exactly two places — self-signup
      -- (routes/auth.js) and create_test_doctor.js. Superadmin doctor create,
      -- superadmin doctor edit and the doctor's own services form all write
      -- doctor_services and never mirror into it. 18 of 31 doctors therefore
      -- had a specialty_id with no matching row, and an INNER JOIN on that
      -- table alone meant a paid case in their specialty broadcast to nobody.
      --
      -- Migration 091 backfills the missing rows. This clause is the durable
      -- half: the next writer that forgets the mirror degrades to "we still
      -- find the doctor" instead of "the case reaches no one".
      WHERE (
              u.specialty_id = $1
              OR EXISTS (SELECT 1 FROM doctor_specialties ds
                          WHERE ds.doctor_id = u.id AND ds.specialty_id = $1)
            )
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_available, true) = true
        -- A5 (AUDIT 2026-09-09) — paused doctors are excluded from the open pool
        -- (migration 040: is_paused is routing-only, set automatically on SLA
        -- breach). A3 — onboarding-incomplete doctors cannot take cases yet.
        AND COALESCE(u.is_paused, false) = false
        AND COALESCE(u.onboarding_complete, false) = true
        -- A3 (AUDIT 2026-09-09) — eligibility no longer requires notify_whatsapp
        -- or a phone: email + the in-app bell reach EVERY eligible doctor
        -- (WhatsApp is still sent additionally, per-doctor, in the loop below).
        -- A2-2 (X5): auto_assign's tier predicate, verbatim semantics.
        AND COALESCE(u.sla_tiers_supported, '["standard"]'::jsonb) ?| $2
      GROUP BY u.id
      ORDER BY active_load ASC
    `, [specialtyId, tierAny]);

  // Capacity — capFor in JS, POOL semantics. Urgent fan-out stays deliberately
  // UNCAPPED (maximum reach on a 4-hour case, pre-existing and possibly
  // intended) — reported to Ziad as an open question, NOT decided here.
  let eligibleDoctors;
  if (tier === 'urgent') {
    eligibleDoctors = candidates;
  } else {
    eligibleDoctors = candidates.filter((d) => {
      const cap = capFor(d, tier);
      return cap === 0 || Number(d.active_load) < cap;
    });
  }

  // 7. Send notifications with deduplication.
  //
  // A3 (AUDIT 2026-09-09) — the broadcast used to queue channel:'whatsapp' ONLY,
  // filtered on notify_whatsapp. WhatsApp is not yet wired to the portal
  // (OPENCLAW_* unset), so a new paid case was announced to NOBODY. Now every
  // eligible doctor gets email + the in-app bell through the shared multi-channel
  // helper, and WhatsApp is sent ADDITIONALLY to doctors who have it — same
  // dedupe key per doctor per case, so the A2 routing-retry cannot double-send.
  var refId = order.reference_id || String(orderId).slice(0, 12).toUpperCase();
  var sentCount = 0;
  for (const doctor of eligibleDoctors) {
    // Email + in-app bell for EVERY eligible doctor.
    const multi = await queueMultiChannelNotification({
      orderId: orderId,
      toUserId: doctor.id,
      channels: ['internal', 'email'],
      template: 'new_case_available',
      response: {
        case_id: orderId,
        caseReference: refId,
        doctorName: doctor.name || '',
        specialty: specialtyId,
        tier: tier,
        sla_hours: order.sla_hours || 48,
        acceptWindowMinutes: acceptanceMinutes,
      },
      dedupe_key: 'broadcast:' + orderId + ':' + doctor.id,
    });
    if (multi && multi.ok !== false) {
      sentCount++;
    }

    // WhatsApp ADDITIONALLY, only for doctors who actually have it — keeps the
    // tier-specific HSM templates (NEW_CASE_URGENT / FASTTRACK / STANDARD) that
    // whatsappTemplateMap knows how to send.
    const hasWhatsApp = (doctor.notify_whatsapp === true || doctor.notify_whatsapp === 1)
      && doctor.phone && String(doctor.phone).trim() !== '';
    if (hasWhatsApp) {
      await queueNotification({
        orderId: orderId,
        toUserId: doctor.id,
        channel: 'whatsapp',
        template: config.template,
        response: {
          case_ref: refId,
          specialty: specialtyId,
          tier: tier,
          sla_hours: order.sla_hours || 48,
        },
        dedupe_key: 'broadcast:' + orderId + ':' + doctor.id,
      });
    }
  }

  console.log('[broadcast] order ' + orderId + ' tier=' + tier + ' specialty=' + specialtyId + ' eligible=' + eligibleDoctors.length + ' sent=' + sentCount);
  return { ok: true, tier: tier, eligible: eligibleDoctors.length, sent: sentCount };
}

module.exports = { broadcastOrderToSpecialty, determineTier, TIER_CONFIG };
