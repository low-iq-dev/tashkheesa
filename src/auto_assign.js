// src/auto_assign.js
// Auto-assign a doctor to an order based on specialty match, SLA tier capability,
// and lowest active caseload.

var { queryOne, queryAll, execute } = require('./pg');
var { queueMultiChannelNotification } = require('./notify');
var { logOrderEvent } = require('./audit');
var { major: logMajor, makeId } = require('./logger');

var TERMINAL_STATUSES = ['completed', 'cancelled', 'canceled', 'rejected', 'refunded'];

// Tier defaults to 'standard' for orders missing urgency_tier and for doctors
// whose sla_tiers_supported is still NULL (pre-migration-033 rows).
var DEFAULT_TIER = 'standard';

// ---------------------------------------------------------------------------
// eligibleDoctorsFor({ specialtyId, tier, serviceId })
// Returns active doctors who match the specialty AND opt into the given SLA
// tier via users.sla_tiers_supported (JSONB array). NULL is treated as
// ["standard"] so legacy rows can still take Standard cases.
// §4.6: when serviceId is provided, also gates on onboarding_complete=true and
// an EXISTS row in doctor_services. A NULL serviceId falls back to the legacy
// specialty-only path so callers that cannot resolve a service_id still work.
// ---------------------------------------------------------------------------
async function eligibleDoctorsFor(opts) {
  var specialtyId = opts && opts.specialtyId;
  var serviceId   = opts && opts.serviceId;
  var tier = (opts && opts.tier) || DEFAULT_TIER;
  var tierJson = JSON.stringify([tier]);
  // §4.6: onboarding gate + service-level matching. A NULL serviceId means the
  // caller couldn't resolve the order's service — fall back to specialty-only
  // (legacy) rather than matching zero doctors.
  var serviceClause = serviceId
    ? "  AND COALESCE(onboarding_complete, false) = true " +
      "  AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = users.id AND ds.service_id = $3) "
    : "";
  var params = serviceId ? [specialtyId, tierJson, serviceId] : [specialtyId, tierJson];
  return await queryAll(
    "SELECT id, name FROM users " +
    "WHERE role = 'doctor' " +
    "  AND COALESCE(is_active, true) = true " +
    "  AND COALESCE(is_paused, false) = false " +
    "  AND COALESCE(pending_approval, false) = false " +
    "  AND specialty_id = $1 " +
    "  AND COALESCE(sla_tiers_supported, '[\"standard\"]'::jsonb) @> $2::jsonb " +
    serviceClause +
    "ORDER BY name ASC",
    params
  );
}

// ---------------------------------------------------------------------------
// Log an under-capacity event when tier filtering eliminated the entire pool
// for a specialty that DID have doctors. category='sla_routing' so ops can
// query the partial index on error_logs(category).
// Fire-and-forget — never throws.
// ---------------------------------------------------------------------------
async function logSlaRoutingShortage(ctx) {
  try {
    var id = makeId('elog');
    var errorId = makeId('sla');
    var msg = 'No tier-eligible doctor for order ' + ctx.orderId +
              ' (tier=' + ctx.tier + ', specialty=' + ctx.specialtyId +
              ', specialty_pool=' + ctx.specialtyPool + ')';
    await execute(
      "INSERT INTO error_logs (id, error_id, level, category, message, context) " +
      "VALUES ($1, $2, 'warn', 'sla_routing', $3, $4)",
      [id, errorId, msg, JSON.stringify(ctx)]
    );
  } catch (e) {
    logMajor('[sla_routing] failed to write error_logs row: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Check if auto-assign is enabled in admin_settings
// ---------------------------------------------------------------------------
async function isAutoAssignEnabled() {
  try {
    var row = await queryOne(
      "SELECT value FROM admin_settings WHERE key = 'auto_assign_enabled'"
    );
    if (!row) return false;
    var val = String(row.value || '').toLowerCase().trim();
    return val === 'true' || val === '1' || val === 'yes';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Count active (non-terminal) cases for a doctor
// ---------------------------------------------------------------------------
async function countActiveCases(doctorId) {
  var placeholders = TERMINAL_STATUSES.map(function(_, i) { return '$' + (i + 2); }).join(', ');
  var row = await queryOne(
    'SELECT COUNT(*) as c FROM orders_active WHERE doctor_id = $1 AND LOWER(COALESCE(status, \'\')) NOT IN (' + placeholders + ')',
    [doctorId].concat(TERMINAL_STATUSES)
  );
  return row ? Number(row.c || 0) : 0;
}

// ---------------------------------------------------------------------------
// autoAssignDoctor(orderId)
// Main entry point. Finds the best doctor and assigns them.
// Returns { assigned: true, doctorId, doctorName } or { assigned: false, reason }.
// ---------------------------------------------------------------------------
async function autoAssignDoctor(orderId) {
  var order = await queryOne(
    // assignment_status is not projected by the orders_active view (per
    // pg_get_viewdef on 2026-06-01 — column dropped during view recreation
    // but kept on the base table). Read from orders directly with the same
    // soft-deletion filter the view applies.
    'SELECT id, specialty_id, service_id, doctor_id, status, urgency_tier, assignment_status, updated_at ' +
    'FROM orders WHERE id = $1 AND deleted_at IS NULL',
    [orderId]
  );
  if (!order) {
    return { assigned: false, reason: 'order_not_found' };
  }

  // Don't re-assign if already assigned
  if (order.doctor_id) {
    // ...unless this is an ABANDONED CLAIM. The claim UPDATE further down
    // writes doctor_id before calling assignDoctor; if the process dies in
    // between (Render redeploy mid-assign), the row is left with a doctor_id
    // but status still PAID — and no sweep selects that shape:
    // acceptance_watcher needs doctor_id IS NULL, fetchDoctorTimeouts needs
    // status='assigned', fetchSlaCandidates needs IN_REVIEW. It would sit
    // there paid and silent forever.
    //
    // status='paid' is the proof the lifecycle never ran (assignDoctor's first
    // write is transitionCase -> ASSIGNED). The 5-minute age check is the
    // proof it is not a claim in flight right now: PG_STATEMENT_TIMEOUT_MS
    // caps any single statement at 30s, so no live assignDoctor is 5 minutes
    // old. Both must hold before we take the row back.
    var claimAgeMs = order.updated_at ? (Date.now() - new Date(order.updated_at).getTime()) : 0;
    var abandonedClaim = String(order.status || '').trim().toLowerCase() === 'paid' &&
                         Number.isFinite(claimAgeMs) && claimAgeMs > 5 * 60 * 1000;
    if (!abandonedClaim) {
      return { assigned: false, reason: 'already_assigned' };
    }
    logMajor('[auto-assign] Order ' + orderId + ' holds an abandoned claim on doctor ' + order.doctor_id +
             ' (status=paid, age=' + Math.round(claimAgeMs / 1000) + 's) — releasing and re-assigning');
    var reclaimed = await execute(
      "UPDATE orders SET doctor_id = NULL, updated_at = $1 " +
      " WHERE id = $2 AND doctor_id = $3 AND LOWER(COALESCE(status, '')) = 'paid'",
      [new Date().toISOString(), orderId, order.doctor_id]
    );
    if (!reclaimed || reclaimed.rowCount === 0) {
      return { assigned: false, reason: 'already_assigned' };
    }
    order.doctor_id = null;
  }

  // Theme 14 Phase 5 — orders parked for manual ops review (classifier
  // confidence below the live `minimum` threshold) must not auto-route.
  // Admin clears this state via /superadmin/manual-queue, which flips
  // assignment_status back to 'auto' before invoking auto-assign again.
  if (order.assignment_status === 'manual_queue') {
    return { assigned: false, reason: 'manual_queue_pending' };
  }

  if (!order.specialty_id) {
    return { assigned: false, reason: 'no_specialty' };
  }

  var tier = (order.urgency_tier && String(order.urgency_tier).trim()) || DEFAULT_TIER;

  // Tier-aware candidate pool (specialty + sla_tiers_supported @> [tier]).
  var candidates = await eligibleDoctorsFor({ specialtyId: order.specialty_id, tier: tier, serviceId: order.service_id });

  if (!candidates || candidates.length === 0) {
    // Distinguish "no doctor for specialty" from "tier filter eliminated the pool".
    // The latter is a routing/under-capacity signal ops needs to see.
    // §4.6: COUNT now mirrors the eligibleDoctorsFor gate — onboarding_complete +
    // service-level match — so the "specialty has doctors but tier filtered them"
    // signal stays honest. If service_id is NULL this returns 0 and we log
    // "no active doctors for specialty", matching the legacy no-service path.
    var specialtyPool = await queryOne(
      "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND COALESCE(is_active, true) = true AND COALESCE(is_paused, false) = false AND COALESCE(pending_approval, false) = false AND COALESCE(onboarding_complete, false) = true AND specialty_id = $1 AND EXISTS (SELECT 1 FROM doctor_services ds WHERE ds.doctor_id = users.id AND ds.service_id = $2)",
      [order.specialty_id, order.service_id]
    );
    var specialtyCount = specialtyPool ? Number(specialtyPool.c || 0) : 0;

    if (specialtyCount > 0) {
      logMajor('[auto-assign] No tier-eligible doctor for order ' + orderId + ' (tier=' + tier + ', specialty=' + order.specialty_id + ', specialty_pool=' + specialtyCount + ')');
      await logSlaRoutingShortage({
        orderId: orderId,
        specialtyId: order.specialty_id,
        tier: tier,
        specialtyPool: specialtyCount
      });
    } else {
      logMajor('[auto-assign] No active doctors for specialty ' + order.specialty_id + ' (order ' + orderId + ')');
    }
    // Theme 14 — transition to the superadmin manual queue (Phase 5).
    // Non-fatal on failure: the order can still be assigned via the
    // (legacy) /superadmin/orders/:id detail page if the column is
    // somehow missing or the UPDATE fails.
    try {
      await execute(
        "UPDATE orders SET assignment_status = 'manual_pending', updated_at = $1 WHERE id = $2",
        [new Date().toISOString(), orderId]
      );
    } catch (_) { /* non-fatal */ }
    return { assigned: false, reason: 'no_doctors_available' };
  }

  // Score each candidate by active caseload
  var best = null;
  for (var i = 0; i < candidates.length; i++) {
    var doc = candidates[i];
    var caseCount = await countActiveCases(doc.id);

    // Pick lowest caseload; on tie, the first in alphabetical order wins (round-robin tiebreaker)
    if (!best || caseCount < best.caseCount) {
      best = { id: doc.id, name: doc.name, caseCount: caseCount };
    }
  }

  if (!best) {
    return { assigned: false, reason: 'no_doctors_available' };
  }

  // AUDIT-P0-2 — assign through the case lifecycle, not a raw UPDATE.
  //
  // This used to be:
  //   UPDATE orders SET doctor_id = $1, assignment_status = 'assigned' ...
  // which left `status` on PAID. The consequences were total:
  //   * doctor.js's "new cases" queue is a UNION of (doctor_id = me AND status
  //     IN ('assigned','accepted')) and (doctor_id IS NULL). A row with a
  //     doctor_id but status='paid' matches NEITHER — invisible to the assigned
  //     doctor AND removed from every other doctor's broadcast pool.
  //   * No doctor_assignments row and no accept_by_at, so
  //     case_sla_worker.fetchDoctorTimeouts (needs status='assigned' + an
  //     assignment row) could never recover it.
  //   * markCasePaid sets deadline_at = NULL, so fetchSlaCandidates (needs
  //     deadline_at IS NOT NULL) could never recover it either.
  // Net: a paid, orphaned, permanently silent case.
  //
  // assignDoctor writes status=ASSIGNED, assigned_at, the doctor_assignments
  // row with a tier-proportional accept_by_at, the CASE_ASSIGNED event, the
  // case conversation, and the patient email — all the things the raw UPDATE
  // skipped. Required lazily to avoid the
  // auto_assign -> case_lifecycle -> job_queue -> auto_assign require cycle.
  var nowIso = new Date().toISOString();
  var caseLifecycle = require('./case_lifecycle');

  // Atomic claim: only one writer may move this order out of "unassigned".
  // Guards the TOCTOU window between the order.doctor_id check at the top of
  // this function and the write, which the auto-assign worker and a manual
  // admin assign can both be inside at once.
  //
  // AUDIT-P0-2c — this UPDATE guarded on `doctor_id IS NULL` but only wrote
  // assignment_status, i.e. it never took the lock it was testing. Each
  // execute() autocommits on its own pool connection, so two concurrent writers
  // both matched `doctor_id IS NULL`, both got rowCount=1, and both proceeded
  // into assignDoctor — the "already claimed" branch below was unreachable, and
  // the loser's assignDoctor overwrote the winner's doctor_id, wrote a second
  // doctor_assignments row and a second CASE_ASSIGNED event, and emailed the
  // patient a doctor name that no longer owned the case.
  //
  // Writing doctor_id in the same statement makes the row its own lock: the
  // loser matches zero rows because the winner already filled the column the
  // predicate tests. assignDoctor then writes the same doctor_id again via
  // transitionCase — same value, not a divergent write.
  var claim = await execute(
    "UPDATE orders SET doctor_id = $1, assignment_status = 'assigned', updated_at = $2 " +
    " WHERE id = $3 AND doctor_id IS NULL AND deleted_at IS NULL",
    [best.id, nowIso, orderId]
  );
  if (!claim || claim.rowCount === 0) {
    logMajor('[auto-assign] Order ' + orderId + ' was claimed by another writer — skipping');
    return { assigned: false, reason: 'already_assigned' };
  }

  try {
    await caseLifecycle.assignDoctor(orderId, best.id);
  } catch (e) {
    // Release the claim so a later sweep or a human can still assign it, and
    // surface the reason rather than leaving a half-assigned row behind.
    //
    // The release now has to clear doctor_id too (the claim above writes it),
    // and its old `AND doctor_id IS NULL` guard would never match again. Two
    // guards replace it:
    //   * doctor_id = best.id — never clear a claim another writer owns.
    //   * status still 'paid' — every throw assignDoctor raises itself (case
    //     missing / unpaid / wrong status) fires BEFORE its transitionCase, so
    //     a row that already reached ASSIGNED is genuinely assigned and a later
    //     incidental throw must not strip its doctor. ASSIGNED-with-a-doctor is
    //     recoverable (the acceptance/timeout sweeps see it);
    //     ASSIGNED-with-doctor_id-NULL is not — no sweep selects that shape.
    var released = null;
    try {
      released = await execute(
        "UPDATE orders SET doctor_id = NULL, assignment_status = 'manual_pending', updated_at = $1 " +
        " WHERE id = $2 AND doctor_id = $3 AND LOWER(COALESCE(status, '')) = 'paid'",
        [new Date().toISOString(), orderId, best.id]
      );
    } catch (_) { /* non-fatal */ }
    if (!released || released.rowCount === 0) {
      logMajor('[auto-assign] Order ' + orderId + ' claim NOT released after assignDoctor failure ' +
               '(row moved past PAID or was reclaimed) — doctor_id left in place deliberately');
    }
    logMajor('[auto-assign] assignDoctor rejected order ' + orderId + ': ' + (e && e.message));
    return { assigned: false, reason: 'lifecycle_rejected', error: e && e.message };
  }

  // Audit trail
  await logOrderEvent({
    orderId: orderId,
    label: 'Order auto-assigned to doctor ' + best.name + ' (caseload: ' + best.caseCount + ')',
    meta: { doctorId: best.id, doctorName: best.name, caseCount: best.caseCount },
    actorRole: 'system'
  });

  // Notify the assigned doctor
  queueMultiChannelNotification({
    orderId: orderId,
    toUserId: best.id,
    channels: ['internal', 'email', 'whatsapp'],
    template: 'order_auto_assigned_doctor',
    response: {
      case_id: orderId,
      caseReference: String(orderId).slice(0, 12).toUpperCase(),
      doctorName: best.name
    },
    dedupe_key: 'auto_assign:' + orderId + ':' + best.id
  });

  logMajor('[auto-assign] Assigned order ' + orderId + ' to ' + best.name + ' (' + best.id + ') — caseload: ' + best.caseCount);

  return { assigned: true, doctorId: best.id, doctorName: best.name };
}

module.exports = {
  autoAssignDoctor: autoAssignDoctor,
  isAutoAssignEnabled: isAutoAssignEnabled,
  eligibleDoctorsFor: eligibleDoctorsFor
};
