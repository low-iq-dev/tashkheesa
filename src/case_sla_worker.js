const { queryOne, queryAll, execute } = require('./pg');
const {
  CASE_STATUS,
  markSlaBreach,
  reassignCase,
  logCaseEvent,
  insertCaseEventOrThrow,
  CASE_ROUTING_RESET_EVENT,
  dbStatusValuesFor
} = require('./case_lifecycle');
const { major: logMajor, fatal: logFatal } = require('./logger');
const { eligibleDoctorClause } = require('./services/doctor_eligibility');

// SLA breach scanning should only apply once the case is in active review.
// Keep this resilient even if older code uses a string literal for rejected_files.
//
// AUDIT-2026-08-22 — REJECTED_FILES stays in this set, and the OTHER end was
// fixed to match. case_lifecycle.transitionCase used to refuse any SLA_BREACH
// target unless the current status was exactly IN_REVIEW, so a rejected-files
// candidate selected here could never complete its transition: handleBreach
// threw, breached_at was never written, the row was re-selected on the next
// 5-minute tick and the loop ran forever with no breach and no refund. The
// `sla_paused_at IS NULL` filter below covers a PAUSED case but not a RESUMED
// one — resumeSla clears the pause and writes a live deadline_at, while the
// REJECTED_FILES -> IN_REVIEW flip that should follow it is a separate,
// independently-failing try block in routes/patient.js. transitionCase now
// admits REJECTED_FILES (and STATUS_TRANSITIONS lists SLA_BREACH under it), so
// the scan set and the transition guard can no longer disagree. Do not remove
// REJECTED_FILES here without removing it from that guard in the same change.
const SCAN_STATUSES = [CASE_STATUS.IN_REVIEW, (CASE_STATUS.REJECTED_FILES || 'rejected_files')];

// AUDIT 2026-08-17 — expand each canonical status into EVERY spelling that has
// ever been written to orders.status, instead of just lowercasing the canonical
// key.
//
// The sweep compared `LOWER(o.status) IN ('in_review','rejected_files')`. That
// matches the canonical writer's 'IN_REVIEW' (it lowercases to 'in_review') but
// misses every historical variant that case_lifecycle's own DB_STATUS_VARIANTS
// map knows about — 'in_progress', 'review', 'inreview'.
//
// A case stored under one of those spellings is invisible to this sweep, which
// means it can NEVER breach: no breach mark, no reassignment, no urgency-uplift
// refund to the patient, no accountability for the doctor holding it. It simply
// sits past its deadline forever, and nothing anywhere says so.
//
// That is not theoretical. Order demo-order-in-progress-001 was found on
// 2026-08-17 sitting three months past its deadline with breached_at NULL and
// status 'in_progress' — a spelling this query could not see. No live code path
// writes 'in_progress' today, so the exposure is latent rather than active, but
// the row proves such rows exist in this table and the sweep silently skips
// them.
//
// dbStatusValuesFor() is the map that already knows every spelling; using it
// here means the sweep and the normaliser can no longer disagree.
function scanStatusValues() {
  const out = [];
  for (const canon of SCAN_STATUSES) {
    for (const variant of dbStatusValuesFor(canon)) {
      const v = String(variant).toLowerCase();
      if (out.indexOf(v) === -1) out.push(v);
    }
  }
  return out;
}
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
// AUDIT-ACCEPT-1 / LAUNCH-SLA-3 — LEGACY rows (doctor_assignments with a NULL
// accept_by_at, written before migration 014 added the column) are NO LONGER
// timed out by this sweep. They are counted and reported instead.
//
// Why not "just restore the 24h default":
//   A NULL accept_by_at row that times out routes to handleDoctorTimeout ->
//   reassignCase -> markPartialPayOnReassignment, which claws the assigned
//   doctor back to 10% pay. The backlog of NULL-accept_by_at rows is, by
//   definition, OLD — so any wall-clock cutoff, 2h or 24h, matches all of them
//   on the FIRST sweep after deploy. Restoring 24h changes which rows burst,
//   not whether a burst happens. Only declining to act on them cannot fire a
//   clawback on deploy.
//
// Rows WITH an accept_by_at (every assignment written by
// case_lifecycle.assignDoctor or workers/acceptance_watcher since 014) still
// time out exactly on their per-tier window from src/acceptance_window.js
// (urgent 15m / vip 45m / standard 2h). Backfilling accept_by_at on the legacy
// rows — accept_by_at = assigned_at + the tier window — hands them back to the
// normal path, deliberately and under human control.
//
// DOCTOR_RESPONSE_TIMEOUT_HOURS now only ages the diagnostic count below; it
// drives no write. Default restored to 24h so the report means "unaccepted for
// a day with no deadline recorded", not "unaccepted for two hours".
const DOCTOR_RESPONSE_TIMEOUT_HOURS = Number(
  process.env.DOCTOR_RESPONSE_TIMEOUT_HOURS || 24
);
// Cap how many active (non-terminal) cases a doctor can hold.
// Configurable via env; defaults to 4.
const MAX_ACTIVE_CASES_PER_DOCTOR = Number(process.env.MAX_ACTIVE_CASES_PER_DOCTOR || 4);
let workerStarted = false;

// FIX 8 — throttle for the legacy NULL-accept_by_at backlog report. The sweep
// runs every 5 minutes against a static condition; without this it wrote 288
// error_logs rows a day and poisoned the error-rate cron's baseline. 0 means
// "log on the first sweep after boot", so a deploy always gets one report.
const LEGACY_BACKLOG_LOG_INTERVAL_MS = 60 * 60 * 1000;
let _lastLegacyBacklogLogMs = 0;

// Pick the least-loaded eligible doctor, excluding doctors at/over capacity.
// Note: we treat these statuses as "active workload".
//
// Theme 7 sub-issue D (2026-05-10): 'awaiting_files' is kept as a
// transitional fallback. Migration 047 converts existing rows
// in-place to 'REJECTED_FILES'; new code never writes 'awaiting_files'.
// Removed in a follow-up cleanup PR after 30 days of stable behaviour.
const ACTIVE_STATUSES = ['assigned', 'in_review', 'awaiting_files', 'rejected_files', 'sla_breach'];

// Local lowercase normaliser — case_lifecycle's canonical statuses are
// UPPERCASE but legacy rows and some call sites are not. Kept local so this
// worker does not grow another import cycle with case_lifecycle.
function normalizeStatusLocal(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeSpecialtyId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized ? normalized : null;
}

function buildAlternateDoctorQuery({ specialtyId, excludeDoctorId, countOnly, serviceId }) {
  // P1-FIN-2: exclude is_paused doctors (auto-paused by SLA breach
  // threshold or manually paused by admin). is_active continues to gate
  // login; is_paused gates new-assignment routing only.
  //
  // §4.6: onboarding + service-level matching now come from the shared
  // eligibleDoctorClause (keyed on the case's service_id). role/is_active/
  // is_paused are folded into that fragment; specialty + capacity stay local.
  const statusParams = [...ACTIVE_STATUSES];
  let paramIdx = statusParams.length + 1; // $1..$N are status params

  const clauses = [];

  if (serviceId) {
    // eligibleDoctorClause emits role='doctor', is_active, is_paused,
    // onboarding_complete, and the doctor_services EXISTS gate.
    clauses.push(eligibleDoctorClause({ alias: 'u', serviceIdParam: `$${paramIdx}` }));
    statusParams.push(serviceId);
    paramIdx++;
  } else {
    // Legacy fallback (no service on the case): keep the pre-§4.6 predicates.
    // pending_approval is NOT optional on this path either — it is the gate
    // migration 067 relies on, and a case with a NULL service_id is exactly the
    // legacy shape most likely to be routed to a legacy unapproved account.
    clauses.push(
      "u.role = 'doctor'",
      'u.is_active = true',
      "COALESCE(u.is_paused, false) = false",
      "COALESCE(u.pending_approval, false) = false"
    );
  }

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

async function selectAlternateDoctor({ specialtyId, excludeDoctorId, serviceId } = {}) {
  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId,
    excludeDoctorId,
    countOnly: false,
    serviceId
  });
  return await queryOne(query, allParams);
}

async function countEligibleDoctors({ specialtyId, excludeDoctorId, serviceId } = {}) {
  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId,
    excludeDoctorId,
    countOnly: true,
    serviceId
  });
  const row = await queryOne(query, allParams);
  return row ? Number(row.eligible_count) : 0;
}

async function findAlternateDoctor({ specialtyId, excludeDoctorId, serviceId } = {}) {
  const normalizedSpecialtyId = normalizeSpecialtyId(specialtyId);
  const hasSpecialtyFilter = Boolean(normalizedSpecialtyId);

  let doctor = await selectAlternateDoctor({
    specialtyId: hasSpecialtyFilter ? normalizedSpecialtyId : null,
    excludeDoctorId,
    serviceId
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
      excludeDoctorId,
      serviceId
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
        ? await countEligibleDoctors({ specialtyId: normalizedSpecialtyId, excludeDoctorId, serviceId })
        : null,
      withoutSpecialty: await countEligibleDoctors({ specialtyId: null, excludeDoctorId, serviceId })
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
  // THEME8-LINT-EXEMPT-HELPER: CASE_REASSIGNMENT_FAILED case_event covers /ops surface.
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
  // AUDIT-TZ-1 / migration 081 — deadline_at is timestamptz, so a plain NOW()
  // comparison is unambiguous: both sides are absolute instants and the session
  // timezone cannot change the result.
  //
  // History, because the comment that used to live here had it backwards and
  // the wrong version is cited in a still-open audit ticket. The column was
  // once `timestamp WITHOUT time zone` holding UTC digits (every write is a JS
  // .toISOString()). A previous fix (f8b11c0) replaced a parameterized ISO-Z
  // comparison with NOW()::timestamp, believing the param form was the bug. It
  // was the other way round: NOW()::timestamp yields the SESSION's wall clock,
  // which on production was Africa/Cairo, so this query read every deadline as
  // 2-3h further past than it was and swept cases that were nowhere near due.
  //
  // P3-WORKER-48 in docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md
  // still asks for NOW()::timestamp to be propagated to sla_watcher /
  // runSlaReminderJob / appointment_reminders on the strength of that wrong
  // reasoning. Do not. Plain NOW() against a timestamptz column is the answer.
  //
  // AUDIT-P0-4 — `sla_paused_at IS NULL` added here and in
  // fetchPreBreachCandidates. SCAN_STATUSES includes REJECTED_FILES, and
  // pauseSla stores sla_remaining_seconds but deliberately leaves the stale
  // deadline_at in place. Without this filter a paused case was selected on
  // every tick once its old deadline passed, handleBreach called
  // transitionCase(SLA_BREACH), and transitionCase rejected it with
  // "Only active review cases can escalate to SLA breach" — caught, logged,
  // breached_at never set, re-selected 5 minutes later, forever.
  const statuses = scanStatusValues();
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id,
            o.specialty_id,
            o.service_id
     FROM orders_active o
     WHERE LOWER(COALESCE(o.status, '')) IN (${statuses.map((_, i) => '$' + (i + 1)).join(', ')})
       AND o.deadline_at IS NOT NULL
       AND o.breached_at IS NULL
       AND o.sla_paused_at IS NULL
       AND o.deadline_at <= NOW()`,
    statuses
  );
}

// Theme 7 sub-issue B: pre-breach scan — N min before deadline (default 60).
// Replaces the legacy paths' pre-breach handling that lived in
// src/sla_watcher.js (order_sla_prebreach to superadmins) and
// src/server.js:runSlaReminderJob (sla_reminder_doctor to the assigned
// doctor). Mirrors fetchSlaCandidates' plain-NOW() semantics to
// avoid the Africa/Cairo TZ-offset bug from commit f8b11c0.
//
// SLA_REMINDER_MINUTES env var preserved from runSlaReminderJob — clamps
// into [1, 360] so the value can be safely interpolated into the
// `INTERVAL` literal without exposing a SQL-injection surface (Postgres
// requires `INTERVAL` to be a literal, not a bound parameter).
//
// Migration 081 / LAUNCH-TZ-3: the upper bound used to end in `::timestamp`
// while the `deadline_at > NOW()` line above it did not. deadline_at is
// timestamptz since 081, so `(NOW() + INTERVAL ...)::timestamp` stripped the
// zone off one side of the SAME WHERE clause and forced Postgres to re-read it
// in the session zone — two different clock semantics deciding one window. The
// cast is gone; both arms are plain timestamptz comparisons.
async function fetchPreBreachCandidates() {
  const statuses = scanStatusValues();
  const rawMin = Number(process.env.SLA_REMINDER_MINUTES);
  const reminderMinutes = Number.isFinite(rawMin) && rawMin > 0
    ? Math.max(1, Math.min(360, Math.floor(rawMin)))
    : 60;
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id
     FROM orders_active o
     WHERE LOWER(COALESCE(o.status, '')) IN (${statuses.map((_, i) => '$' + (i + 1)).join(', ')})
       AND o.deadline_at IS NOT NULL
       AND o.breached_at IS NULL
       AND o.sla_paused_at IS NULL
       AND o.deadline_at > NOW()
       AND o.deadline_at <= NOW() + INTERVAL '${reminderMinutes} minutes'`,
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

  const { queueNotification, notifyAdmins } = require('./notify');

  // Theme 7b Phase 1: superadmin fan-out delegated to the canonical
  // notifyAdmins helper. The dedupeKey passed here ('sla:prebreach:
  // <caseId>:sa') gets suffixed with `:${r.id}` per recipient inside
  // notifyAdmins, reproducing the original key shape
  // 'sla:prebreach:<caseId>:sa:<userId>' so any in-flight notification
  // rows from before the migration still dedupe correctly. Best-effort
  // semantics preserved: notifyAdmins catches its own SELECT + per-
  // recipient enqueue errors and never rejects.
  await notifyAdmins({
    template: 'order_sla_prebreach',
    dedupeKey: 'sla:prebreach:' + candidate.case_id + ':sa',
    orderId: candidate.case_id,
  });

  // NOTIFICATIONS 2026-08-25 — and onto the phone.
  //
  // notifyAdmins writes rows into `notifications`, which is read by the web
  // console's bell and by NOTHING in the Command app — there is no
  // /notifications endpoint in routes/api/admin.js. So the one alert that can
  // still PREVENT a breach only reached someone sitting at a desk.
  //
  // Breaches themselves push (case_lifecycle.markSlaBreach). Warning about one
  // in time is worth more than reporting it afterwards.
  try {
    const { pushOpsEvent } = require('./services/ops_push');
    await pushOpsEvent({
      kind: 'sla_prebreach',
      dedupeKey: candidate.case_id,
      title: 'Case approaching its SLA',
      body: 'This case is close to breaching. There is still time to act.',
      orderId: candidate.case_id,
      data: { screen: 'case-detail', caseId: candidate.case_id }
    });
  } catch (_) { /* the sweep must never throw */ }

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

async function fetchDoctorTimeouts({ nowIso }) {
  const assigned = String(CASE_STATUS.ASSIGNED || 'assigned').toLowerCase();

  // Only rows with an explicit accept_by_at are actionable. See the
  // DOCTOR_RESPONSE_TIMEOUT_HOURS comment at the top of this file: a NULL
  // accept_by_at means the row predates migration 014, and reassigning it
  // partial-pays a doctor against a deadline nobody ever recorded.
  //
  // The old `catch` fell back to a query that timed out EVERY unaccepted
  // assigned case on `updated_at <= cutoff`, with no accept_by_at concept at
  // all. doctor_assignments has existed since migration 001, so that branch
  // could only ever fire on a transient DB error — and it would answer that
  // error by mass-reassigning the live book. It now rethrows: the caller
  // already logs to error_logs and rethrows for pg-boss retry, and skipping one
  // 5-minute tick of timeouts is strictly safer than a wrong sweep.
  return await queryAll(
    `SELECT o.id AS case_id,
            o.doctor_id,
            o.specialty_id,
            o.service_id,
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
       AND da.accept_by_at IS NOT NULL
       AND da.accept_by_at <= $2`,
    [assigned, nowIso]
  );
}

// Legacy assignments the sweep deliberately will NOT act on: open
// doctor_assignments rows with no accept_by_at whose case is still sitting
// unaccepted past DOCTOR_RESPONSE_TIMEOUT_HOURS. Reported, never reassigned —
// acting on them is the clawback burst described at the top of this file.
// Fire-and-forget: a failure here must not affect the sweep.
async function countLegacyAcceptanceRows({ cutoffIso }) {
  const assigned = String(CASE_STATUS.ASSIGNED || 'assigned').toLowerCase();
  try {
    const row = await queryOne(
      `SELECT COUNT(*) AS c
       FROM orders_active o
       JOIN doctor_assignments da
         ON da.case_id = o.id
        AND da.completed_at IS NULL
        AND da.accept_by_at IS NULL
       WHERE LOWER(COALESCE(o.status, '')) = $1
         AND o.doctor_id IS NOT NULL
         AND o.accepted_at IS NULL
         AND COALESCE(da.assigned_at, o.updated_at, o.created_at) <= $2`,
      [assigned, cutoffIso]
    );
    return row ? Number(row.c || 0) : 0;
  } catch (e) {
    return 0;
  }
}

async function handleBreach(candidate) {
  // Await so a per-id throw (e.g. case deleted between SELECT and call)
  // surfaces to runCaseSlaSweep's try/catch instead of escaping as an
  // UnhandledRejection. Also ensures the breach is recorded before the
  // reassignCase calls below — without await, the reassignment can race
  // ahead of the breach mark.
  const breached = await markSlaBreach(candidate.case_id);

  // AUDIT-TZ-2 — markSlaBreach has three guards that DECLINE to breach: the
  // acceptance-based deadline has not actually passed, the case is unpaid, or
  // the case is already terminal. Each returns the case untouched. This
  // function ignored the return value and reassigned UNCONDITIONALLY, so a
  // case the guard had just protected was still stripped from its doctor —
  // and reassignCase → markPartialPayOnReassignment clawed that doctor back to
  // 10% partial pay for an SLA they had not missed.
  //
  // Under the Cairo/UTC skew (see src/pg.js) the sweep selected every case ~3h
  // early, so the not-yet-due guard fired constantly and this was the common
  // path, not the edge case. Pinning the session to UTC stops the early
  // selection; this stops the wrongful reassignment even if a candidate
  // reaches here by some other route.
  if (!breached || normalizeStatusLocal(breached.status) !== 'sla_breach') {
    logCaseEvent(candidate.case_id, 'SLA_BREACH_DECLINED', {
      reason: 'not_breached_on_recheck',
      status: breached ? breached.status : null,
      trigger: 'sla_sweep'
    });
    return 0;
  }

  const selection = await findAlternateDoctor({
    specialtyId: candidate.specialty_id,
    excludeDoctorId: candidate.doctor_id,
    serviceId: candidate.service_id
  });
  const nextDoctor = selection.doctor;
  if (!nextDoctor) {
    // Move the case out of an active doctor workload bucket to prevent repeated retry spam.
    try {
      await reassignCase(candidate.case_id, null, { reason: 'sla_breach_no_doctor_available' });
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
  await reassignCase(candidate.case_id, nextDoctor.id, { reason: 'sla_breach' });
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
    excludeDoctorId: candidate.doctor_id,
    serviceId: candidate.service_id
  });
  const nextDoctor = selection.doctor;
  if (!nextDoctor) {
    // Move the case out of ASSIGNED so this worker does not retry and spam events.
    try {
      await reassignCase(candidate.case_id, null, { reason: 'doctor_timeout_no_doctor_available' });
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
  await reassignCase(candidate.case_id, nextDoctor.id, { reason: 'doctor_timeout' });
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

// AUDIT-P1-4 — re-entrancy guard. notification_worker and acceptance_watcher
// both have one; this sweep did not, and fetchSlaCandidates does not use
// FOR UPDATE SKIP LOCKED. On the in-process fallback path (pg-boss
// unavailable, server.js registers a 5-minute setInterval) a sweep that runs
// long enough for a backlog gets a second tick selecting the SAME
// still-unbreached rows, so handleBreach / handleDoctorTimeout run twice per
// case — duplicate reassignment and duplicate notifications.
let _slaSweepRunning = false;

// ── A2 (AUDIT 2026-09-09) — durable re-broadcast of stranded paid cases ──────
//
// markCasePaid fires broadcastOrderToSpecialty FIRE-AND-FORGET. If that throws,
// or the process dies between the payment commit and the call, the case is left
// status=PAID with doctor_id IS NULL and acceptance_deadline_at IS NULL — and NO
// worker anywhere scans for that shape: acceptance_watcher requires a non-NULL
// acceptance_deadline_at, and every other fetcher in this file wants
// IN_REVIEW/ASSIGNED. The only other durable retry is auto_assign, which is OFF
// at launch. So a paid case can sit forever with no doctor and no signal.
//
// This sweep is the durable path. It re-runs the broadcast for any paid case
// older than STRANDED_PAID_MIN_AGE_MINUTES with no doctor and no acceptance
// window that is NOT parked in the manual queue. broadcast itself sets
// acceptance_deadline_at (under its own NULLIF(doctor_id, '') guard), so a case it
// successfully places drops out of this SELECT on the next tick — that column
// IS the "already broadcast" marker, which is exactly why re-running is
// idempotent and never double-broadcasts a case that already went out.
//
// Launch gate 2026-09-15 — four bounds the first version lacked:
//   * PAYMENT. status PAID is not proof of money: a refunded or never-captured
//     row can still carry it. broadcast.js refuses such a row (not_paid) BEFORE
//     its claim UPDATE, so the marker never landed and the row was re-broadcast
//     every tick forever. The fetch now mirrors broadcast's own payment gate.
//   * START DATE. The first tick after deploy broadcast every historical match,
//     oldest first. Rows paid before STRANDED_PAID_START_ISO (bound as a query
//     parameter) are a human's to route. Age is measured from paid_at only:
//     COALESCE(paid_at, updated_at) let a row with no payment timestamp in.
//   * RETRY CAP. After STRANDED_PAID_MAX_ATTEMPTS broadcasts (6 ≈ 30 minutes at
//     the 5-minute cadence) the case is parked at assignment_status =
//     'manual_queue' — the state both the web console and the Command API list —
//     with ONE registered terminal event (STRANDED_PAID_PARKED_EVENT) and ONE
//     final ops push. The terminal event takes the case out of the fetch, so it
//     is written only after the park UPDATE actually ran: a park that throws
//     writes nothing and is retried on the next tick; a park refused by its
//     guard is still terminal — quietly (reason 'taken', no push) when the case
//     got a doctor or an acceptance window meanwhile. A case whose attempts hit
//     the cap before a restart finishes the park on the next tick without
//     broadcasting again. Each attempt row is written BEFORE its broadcast with
//     an INSERT that throws: if it cannot be written the case is skipped for
//     the tick, because a silently lost row would never advance the count.
//   * RESET (T2-R3). Both manual-queue approve handlers write
//     CASE_ROUTING_RESET when they release a case to automatic routing with no
//     doctor. The terminal-event exclusion and both counts only consider events
//     after the case's latest reset (created_at compared with created_at), so a
//     case that was parked, sent back by an operator and fails again gets a
//     fresh budget of STRANDED_PAID_MAX_ATTEMPTS and parks again. A terminal
//     event with no later reset keeps the case excluded.
//   * EMPTY-STRING DOCTOR. doctor_id is TEXT and the doctor routes already read
//     '' as unassigned, but `doctor_id IS NULL` hid such a row from this sweep
//     and from every claim on its way to a doctor. NULLIF(doctor_id, '') IS NULL.
const STRANDED_PAID_MIN_AGE_MINUTES = 10;
const STRANDED_PAID_START_ISO = '2026-09-15T00:00:00Z';
const STRANDED_PAID_MAX_ATTEMPTS = 6;
const STRANDED_PAID_RETRY_EVENT = 'CASE_ROUTING_RETRIED';        // timeline event, not a silent failure
const STRANDED_PAID_PARKED_EVENT = 'CASE_ROUTING_RETRY_FAILED';  // registered in SILENT_FAILURE_EVENTS
const STRANDED_PAID_RESET_EVENT = CASE_ROUTING_RESET_EVENT;      // written by both manual-queue approve handlers
const STRANDED_PAID_OPS_KIND = 'case_routing_stuck';

async function fetchStrandedPaidCases(opts = {}) {
  const d = opts.deps || {};
  const _queryAll = d.queryAll || queryAll;
  const rows = await _queryAll(
    `SELECT o.id
       FROM orders_active o
      WHERE LOWER(COALESCE(o.status, '')) = 'paid'
        AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
        AND NULLIF(o.doctor_id, '') IS NULL
        AND o.acceptance_deadline_at IS NULL
        AND COALESCE(o.assignment_status, '') NOT IN ('manual_queue', 'manual_pending', 'manual_claimed')
        AND o.paid_at IS NOT NULL
        AND o.paid_at >= $2::timestamptz
        AND o.paid_at < NOW() - make_interval(mins => $1)
        AND NOT EXISTS (
              SELECT 1 FROM case_events ce
               WHERE ce.case_id = o.id AND ce.event_type = $3
                 AND NOT EXISTS (
                       SELECT 1 FROM case_events r
                        WHERE r.case_id = ce.case_id AND r.event_type = $4
                          AND r.created_at >= ce.created_at
                     )
            )
      ORDER BY o.paid_at ASC
      LIMIT 100`,
    [STRANDED_PAID_MIN_AGE_MINUTES, STRANDED_PAID_START_ISO, STRANDED_PAID_PARKED_EVENT, STRANDED_PAID_RESET_EVENT]
  );
  return rows || [];
}

// Counts one event type for the case, ignoring every event at or before the
// case's latest CASE_ROUTING_RESET: an operator who sends a parked case back to
// automatic routing starts a new episode with a fresh budget.
async function countStrandedCaseEvents(queryOneFn, caseId, eventType) {
  const row = await queryOneFn(
    `SELECT COUNT(*)::int AS c
       FROM case_events ce
      WHERE ce.case_id = $1 AND ce.event_type = $2
        AND NOT EXISTS (
              SELECT 1 FROM case_events r
               WHERE r.case_id = ce.case_id AND r.event_type = $3
                 AND r.created_at >= ce.created_at
            )`,
    [caseId, eventType, STRANDED_PAID_RESET_EVENT]
  );
  const n = Number(row && row.c);
  return Number.isFinite(n) ? n : 0;
}

function logStrandedSweepError(logFn, err, ctx) {
  try {
    logFn(err, Object.assign({ category: 'assignment', level: 'error' }, ctx));
  } catch (_) { /* fire-and-forget */ }
}

// Park a capped case for a human. Returns false when the park UPDATE threw —
// nothing is recorded, so the fetch selects the case again next tick and the
// park is retried. Returns true once the terminal state is recorded, whether
// the guard let the park land or refused it.
async function parkStrandedPaidCase(caseId, attempts, reason, deps) {
  let parked = false;
  try {
    // Guarded so it only lands on a case that is still unassigned, not yet
    // announced and still in automatic routing: a doctor who accepted a moment
    // ago, a broadcast claim that landed between this tick's fetch and here (it
    // sets acceptance_deadline_at), or an operator who already moved the case,
    // is never overwritten. doctor_id is written NULL — the guard admits only
    // NULL or '' — so every operator view that reads doctor_id IS NULL lists
    // the parked case.
    const res = await deps.execute(
      `UPDATE orders
          SET assignment_status = 'manual_queue',
              doctor_id = NULL,
              updated_at = $1
        WHERE id = $2
          AND NULLIF(doctor_id, '') IS NULL
          AND acceptance_deadline_at IS NULL
          AND COALESCE(assignment_status, 'auto') = 'auto'
          AND deleted_at IS NULL`,
      [new Date().toISOString(), caseId]
    );
    parked = !!(res && res.rowCount > 0);
  } catch (err) {
    logStrandedSweepError(deps.logErrorToDb, err, {
      context: 'case_sla_worker.strandedPaid.park', orderId: caseId, attempts: attempts,
    });
    return false;
  }

  // A refused park is not always a problem: if the case now has a doctor or an
  // acceptance window, routing placed it meanwhile. Record the terminal state
  // quietly and raise no alarm. The alarm stays for a case that is still
  // unrouted, and for one whose row cannot be re-read.
  let taken = false;
  if (!parked) {
    try {
      const row = await deps.queryOne(
        `SELECT (NULLIF(doctor_id, '') IS NOT NULL OR acceptance_deadline_at IS NOT NULL) AS taken
           FROM orders_active
          WHERE id = $1`,
        [caseId]
      );
      taken = !!(row && row.taken === true);
    } catch (err) {
      logStrandedSweepError(deps.logErrorToDb, err, {
        context: 'case_sla_worker.strandedPaid.parkReread', orderId: caseId, attempts: attempts,
      });
    }
  }

  try {
    await deps.logCaseEvent(caseId, STRANDED_PAID_PARKED_EVENT, taken
      ? { attempts: attempts, reason: 'taken', parked: false, via: 'sla_sweep', lastReason: reason }
      : { attempts: attempts, reason: reason, parked: parked, via: 'sla_sweep' });
  } catch (_) { /* logCaseEvent swallows its own failures; this guards an injected one */ }
  if (taken) return true;

  const ref = String(caseId).slice(0, 12).toUpperCase();
  const why = reason || 'unknown';
  try {
    await deps.pushOpsEvent({
      kind: STRANDED_PAID_OPS_KIND,
      // NOT String(caseId): that is the per-order stuck alert's key, and its
      // claim cooldown would swallow this one.
      dedupeKey: String(caseId) + ':parked',
      title: parked ? 'Paid case moved to the manual queue' : 'Paid case could not be routed',
      body: parked
        ? 'Case ' + ref + ': automatic routing stopped after ' + attempts + ' attempts (' + why + '). ' +
          'It is in the manual queue — assign a doctor by hand.'
        : 'Case ' + ref + ': automatic routing stopped after ' + attempts + ' attempts (' + why + '), ' +
          'and it could not be moved to the manual queue (it left automatic routing meanwhile). ' +
          'Open the case and check it has a doctor.',
      orderId: caseId,
      data: { attempts: attempts, reason: reason, parked: parked },
    });
  } catch (_) { /* the terminal case event above is the durable record */ }
  return true;
}

async function handleStrandedPaidCase(candidate, opts = {}) {
  const d = opts.deps || {};
  const deps = {
    queryOne: d.queryOne || queryOne,
    execute: d.execute || execute,
    logCaseEvent: d.logCaseEvent || logCaseEvent,
    broadcast: d.broadcast || require('./notify/broadcast').broadcastOrderToSpecialty,
    pushOpsEvent: d.pushOpsEvent || require('./services/ops_push').pushOpsEvent,
    logErrorToDb: d.logErrorToDb || require('./logger').logErrorToDb,
  };

  const caseId = candidate && (candidate.id || candidate.case_id);
  if (!caseId) return 0;

  // The count of CASE_ROUTING_RETRIED events since the case's latest
  // CASE_ROUTING_RESET IS the durable attempt counter. If it cannot be read,
  // skip the case this tick: assuming "first attempt" would let a persistent
  // read failure broadcast past the cap forever.
  let priorRetries;
  try {
    priorRetries = await countStrandedCaseEvents(deps.queryOne, caseId, STRANDED_PAID_RETRY_EVENT);
  } catch (err) {
    logStrandedSweepError(deps.logErrorToDb, err, { context: 'case_sla_worker.strandedPaid.countAttempts', orderId: caseId });
    return 0;
  }

  if (priorRetries >= STRANDED_PAID_MAX_ATTEMPTS) {
    // The cap was reached on an earlier tick but the terminal event never
    // landed: a restart between the last attempt and the park, or a park that
    // threw. Finish the park now; never broadcast again.
    let alreadyParked;
    try {
      alreadyParked = await countStrandedCaseEvents(deps.queryOne, caseId, STRANDED_PAID_PARKED_EVENT);
    } catch (err) {
      logStrandedSweepError(deps.logErrorToDb, err, { context: 'case_sla_worker.strandedPaid.countParked', orderId: caseId });
      return 0;
    }
    if (alreadyParked > 0) return 0;
    await parkStrandedPaidCase(caseId, priorRetries, 'retries_exhausted', deps);
    return 0;
  }
  const attempt = priorRetries + 1;

  // Record the attempt BEFORE broadcasting, with an INSERT that throws. This row
  // IS the attempt counter, and logCaseEvent swallows a failed write: a write
  // that kept failing silently would let the sweep broadcast every tick with no
  // cap. If it cannot be written, skip the case this tick — no broadcast — and
  // log it.
  let attemptEventId;
  try {
    attemptEventId = await insertCaseEventOrThrow(caseId, STRANDED_PAID_RETRY_EVENT, { attempt, via: 'sla_sweep' }, deps.execute);
  } catch (err) {
    logStrandedSweepError(deps.logErrorToDb, err, { context: 'case_sla_worker.strandedPaid.recordAttempt', orderId: caseId, attempt: attempt });
    return 0;
  }

  let ok = false;
  let reason = null;
  try {
    const result = await deps.broadcast(caseId);
    ok = !!(result && result.ok);
    reason = ok ? null : ((result && result.reason) || 'broadcast_returned_not_ok');
  } catch (err) {
    ok = false;
    reason = (err && err.message) || 'broadcast_threw';
  }

  // The outcome is detail on the attempt row, not the counter: best-effort,
  // but a failure is logged.
  try {
    await deps.execute(
      'UPDATE case_events SET event_payload = $1 WHERE id = $2',
      [JSON.stringify({ attempt, ok, reason, via: 'sla_sweep' }), attemptEventId]
    );
  } catch (err) {
    logStrandedSweepError(deps.logErrorToDb, err, { context: 'case_sla_worker.strandedPaid.recordOutcome', orderId: caseId, attempt: attempt, level: 'warn' });
  }

  if (ok) return 1;

  // The capped attempt: stop broadcasting, park for a human, one final push.
  if (attempt >= STRANDED_PAID_MAX_ATTEMPTS) {
    await parkStrandedPaidCase(caseId, attempt, reason, deps);
    return 0;
  }

  // After the SECOND failed retry, raise an ops event that PERSISTS to the
  // Activity feed (pushOpsEvent, NOT notifySuperadmins directly — the operator
  // must be able to scroll back to it). Deduped per order so a case that stays
  // stuck does not buzz on every 5-minute tick.
  if (attempt >= 2) {
    try {
      await deps.pushOpsEvent({
        kind: STRANDED_PAID_OPS_KIND,
        dedupeKey: String(caseId),
        title: 'Paid case cannot be routed',
        body: 'Case ' + String(caseId).slice(0, 12).toUpperCase() + ' has been paid with no ' +
              'doctor for over ' + STRANDED_PAID_MIN_AGE_MINUTES + ' minutes; the broadcast has ' +
              'failed ' + attempt + ' times (' + (reason || 'unknown') + '). Retrying every 5 minutes; ' +
              'after ' + STRANDED_PAID_MAX_ATTEMPTS + ' attempts it moves to the manual queue.',
        orderId: caseId,
        data: { attempt, reason },
      });
    } catch (_) { /* the CASE_ROUTING_RETRIED event above is the durable record */ }
  }

  return 0;
}

async function runCaseSlaSweep(runAt = new Date()) {
  if (_slaSweepRunning) {
    return { ok: true, skipped: 'already_running' };
  }
  _slaSweepRunning = true;
  try {
    return await _runCaseSlaSweepInner(runAt);
  } finally {
    _slaSweepRunning = false;
  }
}

async function _runCaseSlaSweepInner(runAt = new Date()) {
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
    timeouts = await fetchDoctorTimeouts({ nowIso });
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
  // A2: paid cases stranded with no doctor and no acceptance window.
  // Launch gate 2026-09-15 — a failure here is logged but does NOT join
  // fetchError: a routing problem must never fail (and retry-storm) the SLA
  // job that detects breaches. The next tick runs the fetch again anyway.
  let stranded = [];
  try {
    stranded = await fetchStrandedPaidCases();
  } catch (err) {
    try {
      const { logErrorToDb } = require('./logger');
      logErrorToDb(err, { context: 'case_sla_worker.runCaseSlaSweep.fetchStrandedPaidCases', level: 'error' });
    } catch (_) { /* ignore */ }
    logFatal('Stranded paid-case fetch failed', err);
  }

  let breachCount = 0;
  let timeoutCount = 0;
  let preBreachCount = 0;
  let strandedRebroadcast = 0;

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

  // A2: re-broadcast stranded paid cases. Each handler is independently guarded
  // so one bad case cannot abort the sweep.
  for (const candidate of stranded) {
    try {
      strandedRebroadcast += await handleStrandedPaidCase(candidate);
    } catch (err) {
      logFatal('Stranded paid-case handling failed', candidate.id, err);
    }
  }

  if (preBreachCount || breachCount || timeoutCount || stranded.length) {
    logMajor(`[case-sla] prebreaches=${preBreachCount}, breaches=${breachCount}, timeouts=${timeoutCount}, stranded=${stranded.length} rebroadcast=${strandedRebroadcast}`);
  }

  // LAUNCH-SLA-3: report (never act on) legacy NULL-accept_by_at assignments.
  // These are invisible to fetchDoctorTimeouts by design; without this line
  // they would be invisible to ops as well.
  const legacyStranded = await countLegacyAcceptanceRows({ cutoffIso });
  if (legacyStranded > 0) {
    // The stdout line is unthrottled — it is free, and it keeps the count
    // visible on every tick for anyone tailing logs.
    logMajor(
      `[case-sla] ${legacyStranded} legacy assignment(s) unaccepted >${DOCTOR_RESPONSE_TIMEOUT_HOURS}h with NULL ` +
      'doctor_assignments.accept_by_at — NOT reassigned (would partial-pay against a deadline that was never ' +
      'recorded). Backfill accept_by_at = assigned_at + the tier window to hand them back to the sweep.'
    );
    // ── REGRESSION FIX (F8) — throttle the error_logs write to hourly. ─────
    //
    // This sweep runs every 5 minutes and the condition it reports is a STATIC
    // backlog: a fixed set of legacy rows that nothing in this worker ever
    // acts on, and that only a manual backfill can clear. Writing an
    // error_logs row per tick produced 288 identical rows a day for a
    // situation that has not changed since the last deploy. That is not
    // reporting, it is a leak: it inflates the denominator of the error-rate
    // cron, sits near its alert threshold on volume alone, and buries real
    // errors in /ops/errors under a repeating one.
    //
    // Hourly is enough for a backlog measured in days. The counter resets on
    // process restart, so a fresh deploy always reports once immediately —
    // the first sweep after a deploy is exactly when someone is looking.
    const nowMs = Date.now();
    if (nowMs - _lastLegacyBacklogLogMs >= LEGACY_BACKLOG_LOG_INTERVAL_MS) {
      _lastLegacyBacklogLogMs = nowMs;
      try {
        const { logErrorToDb } = require('./logger');
        logErrorToDb(new Error('legacy doctor_assignments rows with NULL accept_by_at are stranded (' + legacyStranded + ')'), {
          context: 'case_sla_worker.legacy_accept_by_at_backlog',
          category: 'sla',
          level: 'warn',
          legacyStranded,
          cutoffHours: DOCTOR_RESPONSE_TIMEOUT_HOURS,
          throttledToEveryMs: LEGACY_BACKLOG_LOG_INTERVAL_MS
        });
      } catch (_) { /* fire-and-forget */ }
    }
  }

  pingOps('case_sla_worker', 'SLA sweep completed — prebreaches=' + preBreachCount + ' breaches=' + breachCount + ' timeouts=' + timeoutCount);

  // c2 (P3-OBS-1): rethrow at the end so pg-boss still retries on transient
  // pool exhaustion. The error is already logged to error_logs above; this
  // ensures pg-boss marks the job failed (state='failed' in pgboss.job)
  // instead of silently treating partial results as success.
  if (fetchError) throw fetchError;

  // Return shape is pinned by theme7-sla-breach-uses-canonical — keep it exact.
  // The stranded re-broadcast count is reported on the logMajor line above.
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
  if (workerStarted) return null;
  workerStarted = true;
  // Theme 6 §4-B (Sub-issue B): runCaseSlaSweep is async and rethrows on
  // fetch failure (intentional for pg-boss retry semantics, see comment
  // in runCaseSlaSweep). The previous sync try/catch could not catch
  // async rejections, so a single transient DB blip on the in-process
  // fallback path surfaced as unhandledRejection and tripped server.js's
  // process.exit(1) guard. Both the boot run and the interval body must
  // use a promise-aware catcher.
  runCaseSlaSweep().catch(err => logFatal('Case SLA sweep failed (boot)', err));
  const id = setInterval(() => {
    runCaseSlaSweep().catch(err => logFatal('Case SLA sweep failed', err));
  }, intervalMs);
  if (id && id.unref) id.unref();
  return id;
}

module.exports = {
  startCaseSlaWorker,
  runCaseSlaSweep,
  buildAlternateDoctorQuery,
  // A2 — exported for the durable-routing guard (unit + structural).
  fetchStrandedPaidCases,
  handleStrandedPaidCase,
  STRANDED_PAID_MIN_AGE_MINUTES,
  STRANDED_PAID_START_ISO,
  STRANDED_PAID_MAX_ATTEMPTS,
  STRANDED_PAID_RETRY_EVENT,
  STRANDED_PAID_PARKED_EVENT,
  STRANDED_PAID_RESET_EVENT,
};
