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
// eligibleDoctorsFor({ specialtyId, tier })
// Returns active doctors who match the specialty AND opt into the given SLA
// tier via users.sla_tiers_supported (JSONB array). NULL is treated as
// ["standard"] so legacy rows can still take Standard cases.
// ---------------------------------------------------------------------------
async function eligibleDoctorsFor(opts) {
  var specialtyId = opts && opts.specialtyId;
  var tier = (opts && opts.tier) || DEFAULT_TIER;
  var tierJson = JSON.stringify([tier]);
  return await queryAll(
    "SELECT id, name FROM users " +
    "WHERE role = 'doctor' " +
    "  AND COALESCE(is_active, true) = true " +
    "  AND specialty_id = $1 " +
    "  AND COALESCE(sla_tiers_supported, '[\"standard\"]'::jsonb) @> $2::jsonb " +
    "ORDER BY name ASC",
    [specialtyId, tierJson]
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
    'SELECT id, specialty_id, doctor_id, status, urgency_tier FROM orders_active WHERE id = $1',
    [orderId]
  );
  if (!order) {
    return { assigned: false, reason: 'order_not_found' };
  }

  // Don't re-assign if already assigned
  if (order.doctor_id) {
    return { assigned: false, reason: 'already_assigned' };
  }

  if (!order.specialty_id) {
    return { assigned: false, reason: 'no_specialty' };
  }

  var tier = (order.urgency_tier && String(order.urgency_tier).trim()) || DEFAULT_TIER;

  // Tier-aware candidate pool (specialty + sla_tiers_supported @> [tier]).
  var candidates = await eligibleDoctorsFor({ specialtyId: order.specialty_id, tier: tier });

  if (!candidates || candidates.length === 0) {
    // Distinguish "no doctor for specialty" from "tier filter eliminated the pool".
    // The latter is a routing/under-capacity signal ops needs to see.
    var specialtyPool = await queryOne(
      "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND COALESCE(is_active, true) = true AND specialty_id = $1",
      [order.specialty_id]
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

  // Assign the doctor.
  // Theme 14 — also flip assignment_status to 'assigned' (terminal state)
  // so the superadmin manual queue (Phase 5) correctly distinguishes
  // assigned-via-auto from manual_pending / manual_claimed.
  var nowIso = new Date().toISOString();
  await execute(
    "UPDATE orders SET doctor_id = $1, assignment_status = 'assigned', updated_at = $2 WHERE id = $3",
    [best.id, nowIso, orderId]
  );

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
