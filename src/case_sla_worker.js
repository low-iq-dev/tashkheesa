const { db } = require('./db');
const {
  CASE_STATUS,
  markSlaBreach,
  reassignCase,
  logCaseEvent
} = require('./case_lifecycle');
const { major: logMajor, fatal: logFatal } = require('./logger');

const DOCTOR_RESPONSE_TIMEOUT_HOURS = Number(process.env.DOCTOR_RESPONSE_TIMEOUT_HOURS || 6);
const SCAN_STATUSES = [CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW];
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
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

function fetchSlaCandidates(nowIso) {
  return db
    .prepare(
      `SELECT c.id AS case_id,
              da.doctor_id,
              u.specialty_id
       FROM cases c
       JOIN doctor_assignments da ON da.case_id = c.id
         AND da.id = (
           SELECT id
           FROM doctor_assignments
           WHERE case_id = c.id
           ORDER BY datetime(assigned_at) DESC
           LIMIT 1
         )
       LEFT JOIN users u ON u.id = da.doctor_id
       WHERE c.status IN (?, ?)
         AND c.sla_deadline IS NOT NULL
         AND c.sla_paused_at IS NULL
         AND c.breached_at IS NULL
         AND datetime(c.sla_deadline) <= datetime(?)`
    )
    .all(...SCAN_STATUSES, nowIso);
}

function fetchDoctorTimeouts(cutoffIso) {
  return db
    .prepare(
      `SELECT c.id AS case_id,
              da.doctor_id,
              u.specialty_id
       FROM cases c
       JOIN doctor_assignments da ON da.case_id = c.id
         AND da.id = (
           SELECT id
           FROM doctor_assignments
           WHERE case_id = c.id
           ORDER BY datetime(assigned_at) DESC
           LIMIT 1
         )
       LEFT JOIN users u ON u.id = da.doctor_id
       WHERE c.status = ?
         AND da.accepted_at IS NULL
         AND datetime(da.assigned_at) <= datetime(?)`
    )
    .all(CASE_STATUS.ASSIGNED, cutoffIso);
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
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - DOCTOR_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000).toISOString();

  const breaches = fetchSlaCandidates(nowIso);
  const timeouts = fetchDoctorTimeouts(cutoffIso);

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
