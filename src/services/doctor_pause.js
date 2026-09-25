// src/services/doctor_pause.js
//
// P1-FIN-2: auto-pause doctors who breach SLA repeatedly.
//
// Source of truth = doctor_sla_events (migration 109), one row per
// reassignment-away event, written by
// earnings_writer.markReassignedOnReassignment in the same transaction that
// zeroes the doctor's earnings row. Counts those events per doctor in the
// lookback window; if >= threshold, flips users.is_paused = true.
//
// BATCH B (fix plan 2026-09-15): this counter used to live on the
// 'earn-reassign-%' 10% token rows in doctor_earnings. The token's payout
// amount was wrong (a reassigned case earns the outgoing doctor zero) and
// Batch B removed the writer — but the count was load-bearing, so it moved
// to its own table instead of dying with the money row. Migration 109
// backfills events from the token rows that existed at cutover, so the
// 3-in-30 count is identical across the change.
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
// Module reference (not destructured) for the away-period sweep below, so a
// hermetic test can stub pg.execute by assignment on the real module object.
const pg = require('../pg');

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
    `SELECT id, name, is_paused, role FROM users WHERE id = $1`,
    [doctorId]
  );
  if (!u || u.role !== 'doctor') {
    return { paused: false, skipped: 'not_a_doctor' };
  }
  if (u.is_paused === true) {
    return { paused: false, alreadyPaused: true };
  }

  // Count reassignment-away events for this doctor in the lookback window.
  // idx_doctor_sla_events_doctor_created (migration 109) powers this.
  //
  // AUDIT-2026-08-22 — NON-FAULT REASSIGNMENTS DO NOT COUNT.
  //
  // The old token-row count included EVERY reassignment with no notion of
  // why, and at 3 it flips is_paused with
  // pause_reason='auto:sla_breach_threshold:3_in_30d'. That was defensible
  // while the only writer was case_sla_worker (breach / acceptance timeout).
  // Routing the Command app's reassign through case_lifecycle.reassignCase
  // added a class of reassignment that is nobody's fault — doctor on leave,
  // patient asked for a different reader, wrong subspecialty — and three of
  // those in a month silently removed a good doctor from findAlternateDoctor
  // and every broadcast, labelled an SLA offender.
  //
  // markReassignedOnReassignment stores the caller's reason on the event.
  // reassignCase also suppresses this check outright for operator-initiated
  // reassignment — this filter is the backstop for any caller that forgets the
  // flag, and it retro-corrects backfilled events from the Command app era.
  // C3 (Batch C, 2026-09-22) — EXCUSED HAND-BACKS DO NOT COUNT EITHER.
  //
  // The doctor hand-back action (routes/doctor.js) routes through
  // case_lifecycle.reassignCase like every other reassignment, so it writes a
  // doctor_sla_events row. A hand-back for a legitimate reason — on leave,
  // wrong subspecialty, conflict of interest — is the doctor doing the RIGHT
  // thing early instead of letting the window burn, and counting it would
  // auto-pause exactly the consultants who behave well. Those reasons are
  // stamped 'doctor_handback:excused:<category>' and excluded here, the same
  // mechanism as admin_manual. A hand-back with no legitimate reason
  // ('doctor_handback:workload', ':other') still counts: repeatedly taking
  // cases and returning them IS the pattern the pause exists to catch.
  var cnt = await queryOne(
    `SELECT COUNT(*)::int AS n
       FROM doctor_sla_events
      WHERE doctor_id = $1
        AND COALESCE(reason, '') NOT LIKE 'admin\\_manual%'
        AND COALESCE(reason, '') NOT LIKE 'doctor\\_handback:excused%'
        -- A pre-accept DECLINE never legitimately writes an event at all
        -- (earnings_writer returns no_main_row first), so any
        -- 'doctor_declined:%' row that exists is a race artefact or repair
        -- residue — structural backstop (Batch C adversarial X3): the spec
        -- says declining costs nothing, so it must never count here either.
        AND COALESCE(reason, '') NOT LIKE 'doctor\\_declined%'
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

  // AUDIT 2026-08-17 — losing a doctor happened without anyone being told.
  // The pause has real consequences (excluded from findAlternateDoctor and
  // from open-pool broadcasts, so specialty capacity drops the moment it
  // trips) and until now it announced itself only on the doctors list, an
  // error_logs audit row, and a notification to the doctor himself — i.e.
  // the doctor knew before the founder did. The count and window are in the
  // body because 3-in-30 is the difference between a bad month and a doctor
  // to stop sending work to. Swallowed: the pause is already committed and
  // must stand whatever happens here.
  try {
    var { pushOpsEvent } = require('./ops_push');
    await pushOpsEvent({
      kind: 'doctor_auto_paused',
      dedupeKey: doctorId,
      title: 'Doctor auto-paused — ' + ((u && u.name) || doctorId),
      body: breaches + ' SLA breaches in ' + windowDays + ' days (limit ' + threshold +
            '). Removed from assignment and broadcasts until you unpause.',
      data: { doctorId: doctorId, breaches: breaches, windowDays: windowDays },
    });
  } catch (e) { /* best-effort — never unwind the pause */ }

  return { paused: true, breaches: breaches, threshold: threshold, windowDays: windowDays };
}

// ── Scheduled self-pause: doctor_away_periods (migration 120) ───────────────
//
// Away dates are NOT a second availability concept. The platform has ONE
// mechanism every routing path already respects — users.is_paused /
// paused_at / pause_reason (doctorNewCaseBlockReason at accept,
// eligibleDoctorClause in the pool and broadcast SQL, auto_assign) — and an
// away period simply drives that flag on a calendar. This sweep is what
// turns the dates into the flag; the doctor app writes the rows.
//
// pause_reason='doctor_away' is the whole contract: (a) only a doctor with
// NO pause at all is paused here (a platform pause or the doctor's own manual
// pause is never overwritten, so the next lift cannot undo it), and (b) only
// a pause carrying this reason is lifted here, so an admin / auto pause that
// happens to coincide with leave stands until ops lift it.
//
// The day is the Cairo calendar day (Africa/Cairo, as every business date in
// this codebase — earnings_reader BUSINESS_TZ). Computed in JS via Intl
// rather than a fixed offset because Egypt observes DST, and passed as a
// date so the comparison against the date columns is exact and the function
// is testable at any instant. Both statements are idempotent: running the
// sweep twice in the same minute changes nothing the second time.

const DOCTOR_AWAY_REASON = 'doctor_away';

// 'en-CA' is the locale whose short date format IS ISO (same trick as
// services/ai_usage.js cairoDayKey).
const _cairoDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
function cairoDateString(d) {
  return _cairoDayFmt.format(d instanceof Date ? d : new Date(d));
}

// Returns { paused: n, lifted: n } — the number of doctors whose flag changed
// in each direction on this run. Called by the SLA sweep every 5 minutes and
// by the doctor app right after a period is added / cancelled / ended early.
async function applyDoctorAwayPeriods(now = new Date()) {
  const today = cairoDateString(now);

  // (a) A live, uncancelled period contains today and the doctor is not
  //     paused for any reason → pause as 'doctor_away'.
  const paused = await pg.execute(
    `UPDATE users u
        SET is_paused = true, paused_at = NOW(), pause_reason = $2
      WHERE u.role = 'doctor'
        AND COALESCE(u.is_paused, false) = false
        AND EXISTS (SELECT 1 FROM doctor_away_periods p
                     WHERE p.doctor_id = u.id
                       AND p.cancelled_at IS NULL
                       AND p.from_date <= $1::date
                       AND p.to_date   >= $1::date)`,
    [today, DOCTOR_AWAY_REASON]
  );

  // (b) Paused as 'doctor_away' but no live period contains today (it ended,
  //     or was cancelled) → lift. Only this reason, never another.
  const lifted = await pg.execute(
    `UPDATE users u
        SET is_paused = false, paused_at = NULL, pause_reason = NULL
      WHERE u.role = 'doctor'
        AND u.is_paused = true
        AND u.pause_reason = $2
        AND NOT EXISTS (SELECT 1 FROM doctor_away_periods p
                         WHERE p.doctor_id = u.id
                           AND p.cancelled_at IS NULL
                           AND p.from_date <= $1::date
                           AND p.to_date   >= $1::date)`,
    [today, DOCTOR_AWAY_REASON]
  );

  const out = {
    paused: (paused && Number(paused.rowCount)) || 0,
    lifted: (lifted && Number(lifted.rowCount)) || 0,
  };
  if (out.paused || out.lifted) {
    console.log('[doctor-away] ' + today + ' paused=' + out.paused + ' lifted=' + out.lifted);
  }
  return out;
}

module.exports = {
  checkAndAutoPauseDoctor: checkAndAutoPauseDoctor,
  applyDoctorAwayPeriods: applyDoctorAwayPeriods,
  cairoDateString: cairoDateString,
  DOCTOR_AWAY_REASON: DOCTOR_AWAY_REASON,
  _getThreshold: _getThreshold,
  _getWindowDays: _getWindowDays
};
