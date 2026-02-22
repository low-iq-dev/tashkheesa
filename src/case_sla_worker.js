const { queryOne, queryAll, execute } = require('./pg');
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
// Cap how many active (non-terminal) cases a doctor can hold.
// Configurable via env; defaults to 4.
const MAX_ACTIVE_CASES_PER_DOCTOR = Number(process.env.MAX_ACTIVE_CASES_PER_DOCTOR || 4);
let workerStarted = false;

// Pick the least-loaded eligible doctor, excluding doctors at/over capacity.
// Note: we treat these statuses as "active workload".
const ACTIVE_STATUSES = ['assigned', 'in_review', 'awaiting_files', 'rejected_files', 'sla_breach'];

function normalizeSpecialtyId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized ? normalized : null;
}

function buildAlternateDoctorQuery({ specialtyId, excludeDoctorId, countOnly }) {
  const clauses = ["u.role = 'doctor'", 'u.is_active = true'];
  const statusParams = [...ACTIVE_STATUSES];
  let paramIdx = statusParams.length + 1; // $1..$N are status params

  if (excludeDoctorId) {
    clauses.push(`u.id != $${paramIdx}`);
    statusParams.push(excludeDoctorId);
    paramIdx++;
  }
  if (specialtyId) {
    clauses.push(`LOWER(TRIM(COALESCE(u.specialty_id, ''))) = $${paramIdx}`);
    statusParams.push(specialtyId);
    paramIdx++;
  }

  // capacity param
  clauses.push(`COALESCE(a.active_count, 0) < $${paramIdx}`);
  statusParams.push(MAX_ACTIVE_CASES_PER_DOCTOR);

  const statusPlaceholders = ACTIVE_STATUSES.map((_, i) => `$${i + 1}`).join(', ');

  const query = `
    SELECT ${countOnly ? 'COUNT(*) AS eligible_count' : 'u.id'}
    FROM users u
    LEFT JOIN (
      SELECT doctor_id, COUNT(*) AS active_count
      FROM orders
      WHERE doctor_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(status, ''))) IN (${statusPlaceholders})
      GROUP BY doctor_id
    ) a ON a.doctor_id = u.id
    WHERE ${clauses.join(' AND ')}
    ${countOnly ? '' : 'ORDER BY COALESCE(a.active_count, 0) ASC, u.created_at ASC LIMIT 1'}
  `;

  return { query, allParams: statusParams };
}

async function selectAlternateDoctor({ specialtyId, excludeDoctorId } = {}) {
  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId,
    excludeDoctorId,
    countOnly: false
  });
  return await queryOne(query, allParams);
}

async function countEligibleDoctors({ specialtyId, excludeDoctorId } = {}) {
  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId,
    excludeDoctorId,
    countOnly: true
  });
  const row = await queryOne(query, allParams);
  return row ? Number(row.eligible_count) : 0;
}

async function findAlternateDoctor({ specialtyId, excludeDoctorId } = {}) {
  const normalizedSpecialtyId = normalizeSpecialtyId(specialtyId);
  const hasSpecialtyFilter = Boolean(normalizedSpecialtyId);

  let doctor = await selectAlternateDoctor({
    specialtyId: hasSpecialtyFilter ? normalizedSpecialtyId : null,
    excludeDoctorId
  });

  if (doctor) {
    return {
      doctor,
      normalizedSpecialtyId,
      fallbackAttempted: false,
      eligibleCounts: null
    };
  }

  let fallbackAttempted = false;
  if (hasSpecialtyFilter) {
    fallbackAttempted = true;
    doctor = await selectAlternateDoctor({
      specialtyId: null,
      excludeDoctorId
    });
    if (doctor) {
      return {
        doctor,
        normalizedSpecialtyId,
        fallbackAttempted,
        eligibleCounts: null
      };
    }
  }

  let eligibleCounts = null;
  try {
    eligibleCounts = {
      withSpecialty: hasSpecialtyFilter
        ? await countEligibleDoctors({ specialtyId: normalizedSpecialtyId, excludeDoctorId })
        : null,
      withoutSpecialty: await countEligibleDoctors({ specialtyId: null, excludeDoctorId })
    };
  } catch (e) {
    eligibleCounts = null;
  }

  return {
    doctor: null,
    normalizedSpecialtyId,
    fallbackAttempted,
    eligibleCounts
  };
}

function logNoAlternateDoctor({ candidate, selection, trigger }) {
  // eslint-disable-next-line no-console
  console.error('[case-sla] No eligible doctor for reassignment', {
    trigger,
    case_id: candidate.case_id,
    excludeDoctorId: candidate.doctor_id,
    specialtyId: candidate.specialty_id ?? null,
    normalizedSpecialtyId: selection.normalizedSpecialtyId || null,
    maxActiveCasesPerDoctor: MAX_ACTIVE_CASES_PER_DOCTOR,
    fallbackAttempted: selection.fallbackAttempted,
    eligibleCounts: selection.eligibleCounts || null
  });
}

async function fetchSlaCandidates(nowIso) {
  const statuses = SCAN_STATUSES.map((s) => String(s).toLowerCase());
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id,
            o.specialty_id
     FROM orders o
     WHERE LOWER(COALESCE(o.status, '')) IN ($1, $2)
       AND o.deadline_at IS NOT NULL
       AND o.breached_at IS NULL
       AND o.deadline_at <= $3`,
    [...statuses, nowIso]
  );
}

async function fetchDoctorTimeouts({ nowIso, cutoffIso }) {
  const assigned = String(CASE_STATUS.ASSIGNED || 'assigned').toLowerCase();

  // Prefer assignment timestamps from doctor_assignments (more accurate than updated_at).
  // Fall back to legacy logic if the table doesn't exist.
  try {
    return await queryAll(
      `SELECT o.id AS case_id,
              o.doctor_id,
              o.specialty_id,
              COALESCE(da.assigned_at, o.updated_at, o.created_at) AS assigned_at,
              da.accept_by_at AS accept_by_at
       FROM orders o
       LEFT JOIN (
         SELECT case_id, MAX(assigned_at) AS max_assigned_at
         FROM doctor_assignments
         WHERE completed_at IS NULL
         GROUP BY case_id
       ) latest ON latest.case_id = o.id
       LEFT JOIN doctor_assignments da
         ON da.case_id = o.id
        AND da.assigned_at = latest.max_assigned_at
        AND da.completed_at IS NULL
       WHERE LOWER(COALESCE(o.status, '')) = $1
         AND o.doctor_id IS NOT NULL
         AND o.accepted_at IS NULL
         AND da.case_id IS NOT NULL
         AND (
           (da.accept_by_at IS NOT NULL AND da.accept_by_at <= $2)
           OR
           (da.accept_by_at IS NULL AND COALESCE(da.assigned_at, o.updated_at, o.created_at) <= $3)
         )`,
      [assigned, nowIso, cutoffIso]
    );
  } catch (e) {
    return await queryAll(
      `SELECT o.id AS case_id,
              o.doctor_id,
              o.specialty_id
       FROM orders o
       WHERE LOWER(COALESCE(o.status, '')) = $1
         AND o.doctor_id IS NOT NULL
         AND o.accepted_at IS NULL
         AND COALESCE(o.updated_at, o.created_at) <= $2`,
      [assigned, cutoffIso]
    );
  }
}

async function handleBreach(candidate) {
  markSlaBreach(candidate.case_id);
  const selection = await findAlternateDoctor({
    specialtyId: candidate.specialty_id,
    excludeDoctorId: candidate.doctor_id
  });
  const nextDoctor = selection.doctor;
  if (!nextDoctor) {
    // Move the case out of an active doctor workload bucket to prevent repeated retry spam.
    try {
      reassignCase(candidate.case_id, null, { reason: 'sla_breach_no_doctor_available' });
    } catch (e) {}
    logNoAlternateDoctor({ candidate, selection, trigger: 'sla_breach' });
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

async function handleDoctorTimeout(candidate) {
  // Close the current open assignment so this timeout is processed only once.
  // (Prevents repeated DOCTOR_TIMEOUT_REASSIGNMENT / ADMIN_NOTIFIED spam loops.)
  try {
    await execute(
      `UPDATE doctor_assignments
       SET completed_at = NOW()
       WHERE id = (
         SELECT id
         FROM doctor_assignments
         WHERE case_id = $1
           AND completed_at IS NULL
         ORDER BY assigned_at DESC
         LIMIT 1
       )`,
      [candidate.case_id]
    );
  } catch (e) {
    // doctor_assignments may not exist in legacy DBs; ignore.
  }

  logCaseEvent(candidate.case_id, 'DOCTOR_TIMEOUT_REASSIGNMENT', {
    doctorId: candidate.doctor_id
  });
  const selection = await findAlternateDoctor({
    specialtyId: candidate.specialty_id,
    excludeDoctorId: candidate.doctor_id
  });
  const nextDoctor = selection.doctor;
  if (!nextDoctor) {
    // Move the case out of ASSIGNED so this worker does not retry and spam events.
    try {
      reassignCase(candidate.case_id, null, { reason: 'doctor_timeout_no_doctor_available' });
    } catch (e) {}
    logNoAlternateDoctor({ candidate, selection, trigger: 'doctor_timeout' });
    logCaseEvent(candidate.case_id, 'CASE_REASSIGNMENT_FAILED', {
      reason: 'no_doctor_available',
      trigger: 'doctor_timeout'
    });
    logCaseEvent(candidate.case_id, 'ADMIN_NOTIFIED', {
      reason: 'no_doctor_available',
      context: 'doctor_timeout'
    });
    return 1;
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

async function runCaseSlaSweep(runAt = new Date()) {
  const now = runAt instanceof Date ? runAt : new Date(runAt);
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - DOCTOR_RESPONSE_TIMEOUT_HOURS * 60 * 60 * 1000)
    .toISOString();

  const breaches = await fetchSlaCandidates(nowIso);
  const timeouts = await fetchDoctorTimeouts({ nowIso, cutoffIso });

  let breachCount = 0;
  let timeoutCount = 0;

  for (const candidate of breaches) {
    try {
      breachCount += await handleBreach(candidate);
    } catch (err) {
      logFatal('Case SLA breach handling failed', candidate.case_id, err);
    }
  }

  for (const candidate of timeouts) {
    try {
      timeoutCount += await handleDoctorTimeout(candidate);
    } catch (err) {
      logFatal('Doctor timeout handling failed', candidate.case_id, err);
    }
  }

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
