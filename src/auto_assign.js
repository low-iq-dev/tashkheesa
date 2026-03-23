// src/auto_assign.js
// Auto-assign a doctor to an order based on specialty match and lowest active caseload.

var { queryOne, queryAll, execute } = require('./pg');
var { queueMultiChannelNotification } = require('./notify');
var { logOrderEvent } = require('./audit');
var { major: logMajor } = require('./logger');

var TERMINAL_STATUSES = ['completed', 'cancelled', 'canceled', 'rejected', 'refunded'];

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
    'SELECT COUNT(*) as c FROM orders WHERE doctor_id = $1 AND LOWER(COALESCE(status, \'\')) NOT IN (' + placeholders + ')',
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
  var order = await queryOne('SELECT id, specialty_id, doctor_id, status FROM orders WHERE id = $1', [orderId]);
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

  // Find all active doctors with matching specialty
  var candidates = await queryAll(
    "SELECT id, name FROM users WHERE role = 'doctor' AND COALESCE(is_active, true) = true AND specialty_id = $1 ORDER BY name ASC",
    [order.specialty_id]
  );

  if (!candidates || candidates.length === 0) {
    logMajor('[auto-assign] No active doctors for specialty ' + order.specialty_id + ' (order ' + orderId + ')');
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

  // Assign the doctor
  var nowIso = new Date().toISOString();
  await execute(
    'UPDATE orders SET doctor_id = $1, updated_at = $2 WHERE id = $3',
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
  isAutoAssignEnabled: isAutoAssignEnabled
};
