// src/services/doctor_pause.js
//
// P1-FIN-2: auto-pause doctors who breach SLA repeatedly.
//
// Source of truth = doctor_earnings rows with status='reassigned'
// (written by markPartialPayOnReassignment). Counts those rows per
// doctor in the lookback window; if >= threshold, flips
// users.is_paused = true.
//
// Env config:
//   SLA_AUTO_PAUSE_BREACHES      — default 3   (set to 0 to disable)
//   SLA_AUTO_PAUSE_WINDOW_DAYS   — default 30
//
// `is_paused = true` means: account is still active (login works,
// existing cases continue), but the doctor is excluded from
// findAlternateDoctor / open-pool broadcasts. Distinct from is_active.
//
// Visible to admin via:
//   - status badge "Paused (auto)" on /superadmin/doctors
//   - 'paused' filter chip on the doctors list
//   - admin_audit log entry (error_logs category='admin_audit',
//     action='auto_paused_doctor')
//   - notification to the doctor explaining the pause

'use strict';

const { randomUUID } = require('crypto');
const { queryOne, execute } = require('../pg');

function _getThreshold() {
  var n = Number(process.env.SLA_AUTO_PAUSE_BREACHES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}
function _getWindowDays() {
  var n = Number(process.env.SLA_AUTO_PAUSE_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// Returns { paused: true, breaches, threshold, windowDays } when the
// doctor was just paused by this call; { paused: false, breaches,
// threshold, alreadyPaused?: true } otherwise.
async function checkAndAutoPauseDoctor(doctorId) {
  if (!doctorId) return { paused: false, skipped: 'missing_doctor_id' };

  var threshold = _getThreshold();
  var windowDays = _getWindowDays();
  if (threshold === 0) {
    return { paused: false, skipped: 'auto_pause_disabled' };
  }

  // Already paused — no-op (don't re-paused).
  var u = await queryOne(
    `SELECT id, is_paused, role FROM users WHERE id = $1`,
    [doctorId]
  );
  if (!u || u.role !== 'doctor') {
    return { paused: false, skipped: 'not_a_doctor' };
  }
  if (u.is_paused === true) {
    return { paused: false, alreadyPaused: true };
  }

  // Count reassigned-out rows for this doctor in the lookback window.
  // The new index idx_doctor_earnings_doctor_status_created powers this.
  var cnt = await queryOne(
    `SELECT COUNT(*)::int AS n
       FROM doctor_earnings
      WHERE doctor_id = $1
        AND status = 'reassigned'
        AND id LIKE 'earn-reassign-%'
        AND created_at >= NOW() - ($2 * INTERVAL '1 day')`,
    [doctorId, windowDays]
  );
  var breaches = (cnt && Number(cnt.n)) || 0;

  if (breaches < threshold) {
    return { paused: false, breaches: breaches, threshold: threshold, windowDays: windowDays };
  }

  // Trip the pause.
  await execute(
    `UPDATE users
        SET is_paused = true,
            paused_at = NOW(),
            pause_reason = $1
      WHERE id = $2`,
    ['auto:sla_breach_threshold:' + breaches + '_in_' + windowDays + 'd', doctorId]
  );

  // Audit log (best-effort). Uses error_logs directly to avoid the req
  // dependency in logAdminAudit (this is system-initiated, no req).
  try {
    await execute(
      `INSERT INTO error_logs
         (id, level, category, message, user_id, context)
       VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [
        randomUUID(),
        'auto_paused_doctor: ' + doctorId,
        doctorId,
        JSON.stringify({
          action: 'auto_paused_doctor',
          target: doctorId,
          breaches: breaches,
          threshold: threshold,
          windowDays: windowDays
        })
      ]
    );
  } catch (e) { /* best-effort */ }

  return { paused: true, breaches: breaches, threshold: threshold, windowDays: windowDays };
}

module.exports = {
  checkAndAutoPauseDoctor: checkAndAutoPauseDoctor,
  _getThreshold: _getThreshold,
  _getWindowDays: _getWindowDays
};
