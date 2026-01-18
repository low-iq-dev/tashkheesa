const { db } = require('./db');
const {
  CASE_STATUS,
  markSlaBreach,
  reassignCase,
  logCaseEvent
} = require('./case_lifecycle');
const { major: logMajor, fatal: logFatal } = require('./logger');

// SLA breach scanning should only apply once the case is in active review.
// Keep this resilient even if older code uses a string literal for rejected_files.
const SCAN_STATUSES = [CASE_STATUS.IN_REVIEW, (CASE_STATUS.REJECTED_FILES || 'rejected_files')];
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
// Doctor must accept within N hours after assignment, otherwise auto-reassign.
// Configurable via env; defaults to 24 hours.
const DOCTOR_RESPONSE_TIMEOUT_HOURS = Number(process.env.DOCTOR_RESPONSE_TIMEOUT_HOURS || 24);
let workerStarted = false;

function selectAlternateDoctor({ specialtyId, excludeDoctorId } = {}) {
  const clauses = ["role = 'doctor'", 'is_active = 1'];
  const params = [];
  if (excludeDoctorId) {
    clauses.push('id != ?');
    params.push(excludeDoctorId);
  }
  if (specialtyId) {
    clauses.push('specialty_id = ?');
    params.push(specialtyId);
  }
  const query = `
    SELECT id
    FROM users
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return db.prepare(query).get(...params);
}

function fetchSlaCandidates(nowSql) {
  const statuses = SCAN_STATUSES.map((s) => String(s).toLowerCase());
  return db
    .prepare(
      `SELECT o.id AS case_id,
              o.doctor_id,
              o.specialty_id
       FROM orders o
       WHERE LOWER(COALESCE(o.status, '')) IN (?, ?)
         AND o.deadline_at IS NOT NULL
         AND o.breached_at IS NULL
         AND datetime(o.deadline_at) <= datetime(?)`
    )
    .all(...statuses, nowSql);
}

function fetchDoctorTimeouts(cutoffSql) {
  const assigned = String(CASE_STATUS.ASSIGNED || 'assigned').toLowerCase();
  return db
    .prepare(
      `SELECT o.id AS case_id,
              o.doctor_id,
              o.specialty_id
       FROM orders o
       WHERE LOWER(COALESCE(o.status, '')) = ?
         AND o.doctor_id IS NOT NULL
         AND o.accepted_at IS NULL
         AND datetime(COALESCE(o.updated_at, o.created_at)) <= datetime(?)`
    )
    .all(assigned, cutoffSql);
}

function handleBreach(candidate) {
  markSlaBreach(candidate.case_id);
  const nextDoctor = selectAlternateDoctor({
    specialtyId: candidate.specialty_id,
    excludeDoctorId: candidate.doctor_id
  });
  if (!nextDoctor) {
    logCaseEvent(candidate.case_id, 'CASE_REASSIGNMENT_FAILED', {
      reason: 'no_doctor_available',
      trigger: 'sla_breach'
    });
    logCaseEvent(candidate.case_id, 'ADMIN_NOTIFIED', {
      reason: 'no_doctor_available',
      context: 'sla_breach'
    });
    return 1;
  }
  reassignCase(candidate.case_id, nextDoctor.id, { reason: 'sla_breach' });
  logCaseEvent(candidate.case_id, 'DOCTOR_NOTIFIED', {
    doctorId: nextDoctor.id,
    reason: 'sla_breach'
  });
  logCaseEvent(candidate.case_id, 'ADMIN_NOTIFIED', {
    reason: 'sla_breach',
    to: nextDoctor.id
  });
  return 1;
}

function handleDoctorTimeout(candidate) {
  logCaseEvent(candidate.case_id, 'DOCTOR_TIMEOUT_REASSIGNMENT', {
    doctorId: candidate.doctor_id
  });
  const nextDoctor = selectAlternateDoctor({
    specialtyId: candidate.specialty_id,
    excludeDoctorId: candidate.doctor_id
  });
  if (!nextDoctor) {
    logCaseEvent(candidate.case_id, 'CASE_REASSIGNMENT_FAILED', {
      reason: 'no_doctor_available',
      trigger: 'doctor_timeout'
    });
    logCaseEvent(candidate.case_id, 'ADMIN_NOTIFIED', {
      reason: 'no_doctor_available',
      context: 'doctor_timeout'
    });
    return 0;
  }
  reassignCase(candidate.case_id, nextDoctor.id, { reason: 'doctor_timeout' });
  logCaseEvent(candidate.case_id, 'DOCTOR_NOTIFIED', {
    doctorId: nextDoctor.id,
    reason: 'doctor_timeout'
  });
  logCaseEvent(candidate.case_id, 'ADMIN_NOTIFIED', {
    reason: 'doctor_timeout',
    to: nextDoctor.id
  });
  return 1;
}

function runCaseSlaSweep(runAt = new Date()) {
  const now = runAt instanceof Date ? runAt : new Date(runAt);
  // SQLite datetime() comparisons are most reliable with `YYYY-MM-DD HH:MM:SS` strings.
  const nowSql = now.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
  const cutoffSql = new Date(now.getTime() - DOCTOR_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '')
    .slice(0, 19);

  const breaches = fetchSlaCandidates(nowSql);
  const timeouts = fetchDoctorTimeouts(cutoffSql);

  let breachCount = 0;
  let timeoutCount = 0;

  breaches.forEach((candidate) => {
    try {
      breachCount += handleBreach(candidate);
    } catch (err) {
      logFatal('Case SLA breach handling failed', candidate.case_id, err);
    }
  });

  timeouts.forEach((candidate) => {
    try {
      timeoutCount += handleDoctorTimeout(candidate);
    } catch (err) {
      logFatal('Doctor timeout handling failed', candidate.case_id, err);
    }
  });

  if (breachCount || timeoutCount) {
    logMajor(`[case-sla] breaches=${breachCount}, timeouts=${timeoutCount}`);
  }

  return { breaches: breachCount, timeouts: timeoutCount };
}

function startCaseSlaWorker(intervalMs = SCAN_INTERVAL_MS) {
  if (workerStarted) return;
  workerStarted = true;
  runCaseSlaSweep();
  setInterval(() => {
    try {
      runCaseSlaSweep();
    } catch (err) {
      logFatal('Case SLA sweep failed', err);
    }
  }, intervalMs);
}

module.exports = {
  startCaseSlaWorker,
  runCaseSlaSweep
};
