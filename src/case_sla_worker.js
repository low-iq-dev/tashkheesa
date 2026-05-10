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
//
// Theme 7 sub-issue D (2026-05-10): 'awaiting_files' is kept as a
// transitional fallback. Migration 047 converts existing rows
// in-place to 'REJECTED_FILES'; new code never writes 'awaiting_files'.
// Removed in a follow-up cleanup PR after 30 days of stable behaviour.
const ACTIVE_STATUSES = ['assigned', 'in_review', 'awaiting_files', 'rejected_files', 'sla_breach'];

function normalizeSpecialtyId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized ? normalized : null;
}

function buildAlternateDoctorQuery({ specialtyId, excludeDoctorId, countOnly }) {
  // P1-FIN-2: exclude is_paused doctors (auto-paused by SLA breach
  // threshold or manually paused by admin). is_active continues to gate
  // login; is_paused gates new-assignment routing only.
  const clauses = ["u.role = 'doctor'", 'u.is_active = true', "COALESCE(u.is_paused, false) = false"];
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
      FROM orders_active
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

async function fetchSlaCandidates() {
  // Use server-side NOW()::timestamp rather than a parameterized ISO-Z
  // string. With Africa/Cairo session TZ on prod Supabase, the param
  // form applies a TZ offset to the implicit timestamp coercion and
  // silently filters out rows past deadline by less than the offset
  // (~3h). Mirrors the fix in sweepSlaBreaches (commit f8b11c0).
  const statuses = SCAN_STATUSES.map((s) => String(s).toLowerCase());
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id,
            o.specialty_id
     FROM orders_active o
     WHERE LOWER(COALESCE(o.status, '')) IN ($1, $2)
       AND o.deadline_at IS NOT NULL
       AND o.breached_at IS NULL
       AND o.deadline_at <= NOW()::timestamp`,
    statuses
  );
}

// Theme 7 sub-issue B: pre-breach scan — N min before deadline (default 60).
// Replaces the legacy paths' pre-breach handling that lived in
// src/sla_watcher.js (order_sla_prebreach to superadmins) and
// src/server.js:runSlaReminderJob (sla_reminder_doctor to the assigned
// doctor). Mirrors fetchSlaCandidates' NOW()::timestamp semantics to
// avoid the Africa/Cairo TZ-offset bug from commit f8b11c0.
//
// SLA_REMINDER_MINUTES env var preserved from runSlaReminderJob — clamps
// into [1, 360] so the value can be safely interpolated into the
// `INTERVAL` literal without exposing a SQL-injection surface (Postgres
// requires `INTERVAL` to be a literal, not a bound parameter).
async function fetchPreBreachCandidates() {
  const statuses = SCAN_STATUSES.map((s) => String(s).toLowerCase());
  const rawMin = Number(process.env.SLA_REMINDER_MINUTES);
  const reminderMinutes = Number.isFinite(rawMin) && rawMin > 0
    ? Math.max(1, Math.min(360, Math.floor(rawMin)))
    : 60;
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id
     FROM orders_active o
     WHERE LOWER(COALESCE(o.status, '')) IN ($1, $2)
       AND o.deadline_at IS NOT NULL
       AND o.breached_at IS NULL
       AND o.deadline_at > NOW()::timestamp
       AND o.deadline_at <= (NOW() + INTERVAL '${reminderMinutes} minutes')::timestamp`,
    statuses
  );
}

async function handlePreBreach(candidate) {
  // Dedupe via case_events 'SLA pre-breach alert' row — port of
  // src/sla_watcher.js:18-24. One row per case → handler fires once
  // total per case, even across multiple sweep ticks within the
  // 60-minute window.
  const exists = await queryOne(
    "SELECT 1 FROM case_events WHERE case_id = $1 AND event_type = $2 LIMIT 1",
    [candidate.case_id, 'SLA pre-breach alert']
  );
  if (exists) return 0;

  await logCaseEvent(candidate.case_id, 'SLA pre-breach alert');

  const { queueNotification } = require('./notify');

  // Notify all active superadmins (port of sla_watcher fan-out).
  let supers = [];
  try {
    supers = await queryAll(
      "SELECT id FROM users WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
    );
  } catch (e) {
    // best-effort; if the query fails, the doctor reminder below still fires
  }
  for (const sa of supers) {
    try {
      await queueNotification({
        orderId: candidate.case_id,
        toUserId: sa.id,
        channel: 'internal',
        template: 'order_sla_prebreach',
        status: 'queued',
        dedupe_key: 'sla:prebreach:' + candidate.case_id + ':sa:' + sa.id
      });
    } catch (e) { /* best-effort */ }
  }

  // Notify the assigned doctor (port of server.js:runSlaReminderJob's
  // 60-min reminder loop, replacing the orders.sla_reminder_sent column
  // flag with per-(case, doctor) dedupe_key).
  if (candidate.doctor_id) {
    try {
      await queueNotification({
        orderId: candidate.case_id,
        toUserId: candidate.doctor_id,
        channel: 'internal',
        template: 'sla_reminder_doctor',
        status: 'queued',
        dedupe_key: 'sla:prebreach:' + candidate.case_id + ':doctor'
      });
    } catch (e) { /* best-effort */ }
  }

  return 1;
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
       FROM orders_active o
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
       FROM orders_active o
       WHERE LOWER(COALESCE(o.status, '')) = $1
         AND o.doctor_id IS NOT NULL
         AND o.accepted_at IS NULL
         AND COALESCE(o.updated_at, o.created_at) <= $2`,
      [assigned, cutoffIso]
    );
  }
}

async function handleBreach(candidate) {
  // Await so a per-id throw (e.g. case deleted between SELECT and call)
  // surfaces to runCaseSlaSweep's try/catch instead of escaping as an
  // UnhandledRejection. Also ensures the breach is recorded before the
  // reassignCase calls below — without await, the reassignment can race
  // ahead of the breach mark.
  await markSlaBreach(candidate.case_id);
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

  // P3-OBS-1: pg-boss handler errors don't propagate through the express
  // error middleware, so a throw from these queries stays invisible to
  // /ops/errors — surfaces only in pgboss.job.output. Wrap each fetch,
  // log to error_logs on failure (visibility), and rethrow at the end of
  // the function if either failed so pg-boss still retries (preserves
  // existing retry semantics — variant c2 from the diagnosis).
  let breaches = [];
  let timeouts = [];
  let preBreaches = [];
  let fetchError = null;
  try {
    breaches = await fetchSlaCandidates();
  } catch (err) {
    fetchError = err;
    try {
      const { logErrorToDb } = require('./logger');
      logErrorToDb(err, { context: 'case_sla_worker.runCaseSlaSweep.fetchSlaCandidates', level: 'error' });
    } catch (_) { /* logErrorToDb is fire-and-forget; ignore secondary failure */ }
    logFatal('SLA breach candidates fetch failed', err);
  }
  try {
    timeouts = await fetchDoctorTimeouts({ nowIso, cutoffIso });
  } catch (err) {
    fetchError = fetchError || err;
    try {
      const { logErrorToDb } = require('./logger');
      logErrorToDb(err, { context: 'case_sla_worker.runCaseSlaSweep.fetchDoctorTimeouts', level: 'error' });
    } catch (_) { /* ignore */ }
    logFatal('Doctor timeout candidates fetch failed', err);
  }
  // Theme 7 sub-issue B: pre-breach candidates — 0–60 min before deadline.
  try {
    preBreaches = await fetchPreBreachCandidates();
  } catch (err) {
    fetchError = fetchError || err;
    try {
      const { logErrorToDb } = require('./logger');
      logErrorToDb(err, { context: 'case_sla_worker.runCaseSlaSweep.fetchPreBreachCandidates', level: 'error' });
    } catch (_) { /* ignore */ }
    logFatal('SLA pre-breach candidates fetch failed', err);
  }

  let breachCount = 0;
  let timeoutCount = 0;
  let preBreachCount = 0;

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

  for (const candidate of preBreaches) {
    try {
      preBreachCount += await handlePreBreach(candidate);
    } catch (err) {
      logFatal('SLA pre-breach handling failed', candidate.case_id, err);
    }
  }

  if (preBreachCount || breachCount || timeoutCount) {
    logMajor(`[case-sla] prebreaches=${preBreachCount}, breaches=${breachCount}, timeouts=${timeoutCount}`);
  }

  pingOps('ops-agent', 'SLA sweep completed — prebreaches=' + preBreachCount + ' breaches=' + breachCount + ' timeouts=' + timeoutCount);

  // c2 (P3-OBS-1): rethrow at the end so pg-boss still retries on transient
  // pool exhaustion. The error is already logged to error_logs above; this
  // ensures pg-boss marks the job failed (state='failed' in pgboss.job)
  // instead of silently treating partial results as success.
  if (fetchError) throw fetchError;

  return { preBreaches: preBreachCount, breaches: breachCount, timeouts: timeoutCount };
}

function pingOps(agentName, task) {
  try {
    var http = require('http');
    var body = JSON.stringify({ agent_name: agentName, status: 'running', current_task: task });
    var req = http.request({ hostname: 'localhost', port: Number(process.env.PORT || 3000), path: '/ops/agent/ping', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', function() {});
    req.write(body);
    req.end();
  } catch(e) {}
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
