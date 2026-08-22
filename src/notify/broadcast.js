// src/notify/broadcast.js
// Broadcasts a paid order to eligible doctors in the matching specialty.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('./templates');

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
  // The SELECT-side check is the cheap exit; the `doctor_id IS NULL` predicate
  // on the UPDATE is the one that actually closes the race, because the assign
  // can land between this read and that write.
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
       AND doctor_id IS NULL`,
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
  let eligibleDoctors;
  if (tier === 'urgent') {
    // Urgent: notify ALL available doctors regardless of cap
    // GROUP BY dedupes any duplicate (doctor_id, specialty_id) rows in
    // doctor_specialties — there is no unique constraint on that table
    // today (only PK on id; checked pg_constraint on 2026-06-01). Postgres
    // forbids SELECT DISTINCT with an ORDER BY expression that isn't in
    // the projection, so DISTINCT + ORDER BY (subquery) was always invalid;
    // GROUP BY accepts the same expression because u.id is in the grouping
    // set.
    eligibleDoctors = await queryAll(`
      SELECT u.id, u.name, u.phone
      FROM users u
      JOIN doctor_specialties ds ON ds.doctor_id = u.id
      WHERE ds.specialty_id = $1
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_available, true) = true
        AND COALESCE(u.notify_whatsapp, false) = true
        AND u.phone IS NOT NULL AND u.phone != ''
      GROUP BY u.id, u.name, u.phone
      ORDER BY (
        SELECT COUNT(*) FROM orders_active o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) NOT IN ('completed', 'cancelled')
      ) ASC
    `, [specialtyId]);
  } else {
    // Standard / VIP: enforce cap
    var capColumn = tier === 'vip' ? 'max_active_cases_urgent' : 'max_active_cases';
    var defaultCap = tier === 'vip' ? 8 : 5;
    eligibleDoctors = await queryAll(`
      SELECT u.id, u.name, u.phone
      FROM users u
      JOIN doctor_specialties ds ON ds.doctor_id = u.id
      WHERE ds.specialty_id = $1
        AND u.role = 'doctor'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(u.is_available, true) = true
        AND COALESCE(u.notify_whatsapp, false) = true
        AND u.phone IS NOT NULL AND u.phone != ''
        AND (
          SELECT COUNT(*) FROM orders_active o
          WHERE o.doctor_id = u.id
            AND LOWER(o.status) NOT IN ('completed', 'cancelled')
        ) < COALESCE(u.` + capColumn + `, ` + defaultCap + `)
      GROUP BY u.id, u.name, u.phone
      ORDER BY (
        SELECT COUNT(*) FROM orders_active o
        WHERE o.doctor_id = u.id
          AND LOWER(o.status) NOT IN ('completed', 'cancelled')
      ) ASC
    `, [specialtyId]);
  }

  // 7. Send notifications with deduplication
  var sentCount = 0;
  for (const doctor of eligibleDoctors) {
    const result = await queueNotification({
      orderId: orderId,
      toUserId: doctor.id,
      channel: 'whatsapp',
      template: config.template,
      response: {
        case_ref: order.reference_id || String(orderId).slice(0, 12).toUpperCase(),
        specialty: specialtyId,
        tier: tier,
        sla_hours: order.sla_hours || 48,
      },
      dedupe_key: 'broadcast:' + orderId + ':' + doctor.id,
    });
    if (result && result.ok && !result.skipped) {
      sentCount++;
    }
  }

  console.log('[broadcast] order ' + orderId + ' tier=' + tier + ' specialty=' + specialtyId + ' eligible=' + eligibleDoctors.length + ' sent=' + sentCount);
  return { ok: true, tier: tier, eligible: eligibleDoctors.length, sent: sentCount };
}

module.exports = { broadcastOrderToSpecialty, determineTier, TIER_CONFIG };
