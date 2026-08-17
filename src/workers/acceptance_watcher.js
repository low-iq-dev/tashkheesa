// src/workers/acceptance_watcher.js
// Runs every 2 minutes. Auto-assigns orders whose acceptance deadline has expired.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('../notify/templates');
const { logOrderEvent } = require('../audit');
const { logErrorToDb } = require('../logger');
const { eligibleDoctorClause } = require('../services/doctor_eligibility');
const { acceptanceMinutesForOrder, acceptanceDeadlineIso, normalizeTier } = require('../acceptance_window');
const { pushOpsEvent } = require('../services/ops_push');
const MAX_ACTIVE_CASES_PER_DOCTOR = Number(process.env.MAX_ACTIVE_CASES_PER_DOCTOR || 4);

let running = false;

async function runAcceptanceWatcherSweep() {
  if (running) return;
  running = true;

  try {
    // REGRESSION FIX (F6) — `o.urgency_tier` and `o.sla_hours` added.
    //
    // acceptanceMinutesForOrder resolves `order.tier || order.urgency_tier`,
    // then falls back to `order.sla_hours`. This SELECT fetched NONE of the
    // last two — only `tier`, which is written by exactly one writer,
    // notify/broadcast.js. So every case that reached assignment WITHOUT a
    // broadcast (superadmin mark-paid, the auto_assign job, a manual admin
    // assign) arrived here with tier NULL, urgency_tier undefined and
    // sla_hours undefined, and the resolver fell all the way through to
    // `standard` — handing an URGENT 4h case the 120-minute standard window
    // instead of 15 minutes. Eight times policy, on the tier that pays the
    // largest premium for speed, on the busiest assignment path in the system.
    //
    // REGRESSION FIX (F5) — `o.status` added so the rollback below can restore
    // the status the row actually had, instead of forcing every row to 'paid'.
    const expiredOrders = await queryAll(`
      SELECT o.id, o.specialty_id, o.service_id, o.reference_id, o.patient_id,
             o.tier, o.urgency_tier, o.sla_hours, o.status,
             o.urgency_flag, o.sla_24hr_selected
      FROM orders_active o
      WHERE o.doctor_id IS NULL
        AND o.acceptance_deadline_at IS NOT NULL
        AND o.acceptance_deadline_at < NOW()
        AND LOWER(COALESCE(o.status, '')) IN ('pending', 'available', 'submitted', 'new', 'paid')
        AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
    `);

    const expiredCount = (expiredOrders && expiredOrders.length) || 0;

    if (expiredCount > 0) {
      console.log('[acceptance_watcher] found ' + expiredCount + ' expired orders');
      for (const order of expiredOrders) {
        // AUDIT 2026-08-17 — an urgent case nobody accepted was SILENT.
        // This loop is, by definition, "the acceptance deadline passed and
        // doctor_id is still NULL". For a standard case that is a routine
        // hand-off. For an URGENT case it is the 15-minute window (the floor
        // in acceptance_window.js) burned on top of a 4-hour SLA the patient
        // paid a premium for — and until now the only trace was a console
        // line and, if the auto-assign ALSO found nobody, a warn. At 2am the
        // founder learned about it at 9am. Fired before the auto-assign
        // attempt because the reportable fact is the missed window, not
        // whether the retry found someone; the per-case dedupe key with its
        // 60-minute cooldown keeps a case that stays unassignable from
        // re-alarming every 2-minute sweep.
        await notifyUrgentUnaccepted(order);
        try {
          await autoAssignOrder(order);
        } catch (err) {
          logErrorToDb(err, {
            context: 'acceptance_watcher.auto_assign',
            category: 'acceptance_watcher',
            candidateId: order.id,
            workerPhase: 'per_candidate'
          });
          console.error('[acceptance_watcher] failed to auto-assign order ' + order.id + ':', err.message);
        }
      }
    }

    // Side issue #54 — heartbeat the canonical ops endpoint so Widget 3 +
    // CONFIGURED_AGENTS show fresh lastRun. Fires on every successful sweep
    // (including no-op sweeps where nothing expired). Match shape used in
    // case_sla_worker.js:503 and notification_worker.js:364.
    pingOps('acceptance_watcher', 'Acceptance watcher sweep completed — ' + expiredCount + ' expired order(s) processed');
  } catch (err) {
    logErrorToDb(err, {
      context: 'acceptance_watcher.sweep',
      category: 'acceptance_watcher',
      workerPhase: 'interval'
    });
    console.error('[acceptance_watcher] sweep failed:', err.message);
  } finally {
    running = false;
  }
}

// Side issue #54 — local pingOps helper (same shape as case_sla_worker.js:503).
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

// Command-app push for an URGENT case whose acceptance window expired with no
// doctor. Swallows everything: this runs inside the sweep loop and a push
// problem must not stop the auto-assign that follows it.
async function notifyUrgentUnaccepted(order) {
  try {
    if (!order) return;
    const isUrgent = Boolean(order.urgency_flag) || normalizeTier(order.tier) === 'urgent';
    if (!isUrgent) return;

    const caseRef = order.reference_id || String(order.id).slice(0, 12).toUpperCase();

    let specialtyName = order.specialty_id || '';
    try {
      if (order.specialty_id) {
        const sp = await queryOne('SELECT name FROM specialties WHERE id = $1', [order.specialty_id]);
        if (sp && sp.name) specialtyName = sp.name;
      }
    } catch (_) { /* the id is a usable fallback */ }

    const minutes = acceptanceMinutesForOrder(order);

    await pushOpsEvent({
      kind: 'urgent_unaccepted',
      dedupeKey: order.id,
      title: 'Urgent case unaccepted — ' + (specialtyName || 'no specialty'),
      body: 'No doctor accepted ' + caseRef + ' in its ' + minutes + '-min window. The 4h SLA clock is running.',
      data: { orderId: order.id, tier: 'urgent', specialtyId: order.specialty_id || null },
      orderId: order.id,
    });
  } catch (err) {
    logErrorToDb(err, {
      context: 'acceptance_watcher.urgent_unaccepted_push',
      category: 'acceptance_watcher',
      candidateId: order && order.id,
    });
  }
}

async function autoAssignOrder(order) {
  // Resolve specialty
  let specialtyId = order.specialty_id;
  if (!specialtyId && order.service_id) {
    const svc = await queryOne('SELECT specialty_id FROM services WHERE id = $1', [order.service_id]);
    specialtyId = svc ? svc.specialty_id : null;
  }

  // AUDIT-ACCEPT-2 — this hand-rolled query bypassed the assignment safety
  // gate entirely. It filtered on `is_available` (a column the admin UI does
  // not even set) and checked NONE of: is_paused, onboarding_complete,
  // pending_approval, service-level matching, or the per-doctor capacity cap.
  // So the path that fires when a doctor misses their acceptance window — i.e.
  // the busiest assignment path in the system — could hand a paid case to a
  // suspended doctor, a doctor still mid-onboarding, or a doctor who does not
  // offer that service. Under the timezone skew this path fired for EVERY
  // broadcast case (see src/pg.js), so it was not a corner case.
  //
  // Now routed through the same eligibility fragment every other assignment
  // site uses (services/doctor_eligibility.js), ordered by current load.
  const doctor = await queryOne(`
    SELECT u.id, u.name
    FROM users u
    LEFT JOIN (
      SELECT doctor_id, COUNT(*) AS active_count
      FROM orders_active
      WHERE doctor_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(status, ''))) IN ('assigned','in_review','rejected_files','sla_breach')
      GROUP BY doctor_id
    ) a ON a.doctor_id = u.id
    WHERE ${eligibleDoctorClause({ alias: 'u', serviceIdParam: '$2' })}
      AND LOWER(TRIM(COALESCE(u.specialty_id, ''))) = LOWER(TRIM($1))
      AND COALESCE(a.active_count, 0) < $3
    ORDER BY COALESCE(a.active_count, 0) ASC, u.created_at ASC
    LIMIT 1
  `, [specialtyId, order.service_id, MAX_ACTIVE_CASES_PER_DOCTOR]);

  if (!doctor) {
    // THEME8-LINT-EXEMPT-HELPER: benign "no available doctor" diagnostic,
    // not an error. The order stays unassigned and gets retried on the
    // next sweep tick; if it keeps failing past the SLA, case_sla_worker
    // emits CASE_REASSIGNMENT_FAILED on the silent-failures view. This
    // warn line is for stdout triage during local dev.
    console.warn('[acceptance_watcher] no available doctor for order ' + order.id + ' specialty=' + specialtyId);
    return;
  }

  // AUDIT-ACCEPT-3 — this set `accepted_at` while auto-assigning, which is a
  // lie: the doctor has not accepted, they have merely been handed the case.
  // deadlineFromAcceptance() reads accepted_at, so the SLA clock started the
  // moment the system assigned rather than when a human took responsibility —
  // the doctor could open the case hours later already part-way through their
  // window. It also made the case invisible to the doctor-timeout sweep, which
  // requires accepted_at IS NULL, so a doctor who ignored an auto-assigned case
  // held it indefinitely and it was never passed on.
  //
  // accepted_at now stays NULL and a fresh per-tier accept_by_at is written, so
  // an ignored case keeps moving down the eligible list until someone accepts.
  const nowIso = new Date().toISOString();
  const acceptMinutes = acceptanceMinutesForOrder(order);
  const acceptByAt = acceptanceDeadlineIso(acceptMinutes);
  const result = await execute(
    `UPDATE orders
     SET doctor_id = $1,
         status = 'assigned',
         acceptance_deadline_at = $4,
         reassigned_count = COALESCE(reassigned_count, 0) + 1,
         updated_at = $2
     WHERE id = $3
       AND doctor_id IS NULL`,
    [doctor.id, nowIso, order.id, acceptByAt]
  );

  if (!result || result.rowCount === 0) {
    return; // Already assigned by another process
  }

  // Mirror the assignment into doctor_assignments so the doctor-timeout sweep
  // (case_sla_worker.fetchDoctorTimeouts) sees an explicit accept_by_at.
  //
  // AUDIT-ACCEPT-4 — this used to be `catch (e) { /* table may not exist on
  // older deployments */ }`. doctor_assignments has existed since migration
  // 001_initial_tables.sql:124 and accept_by_at since 014, so the excuse was
  // dead — and the row it silently dropped is now the ONLY thing that makes an
  // auto-assigned case sweepable. The orders UPDATE above deliberately leaves
  // accepted_at NULL (AUDIT-ACCEPT-3), and fetchDoctorTimeouts requires
  // `da.case_id IS NOT NULL`. A swallowed INSERT therefore parked a PAID case
  // on a doctor who may never open it, with no event, no error_logs row and no
  // ops signal — permanently.
  //
  // ROLLBACK, and why: the doctor_id claim IS rolled back on failure. The
  // alternative (keep the claim, log the error) leaves precisely the stranded
  // state described above and needs a human to notice a log line. Rolling back
  // doctor_id=NULL and the prior status restores the exact shape this sweep
  // selects on, so the next 2-minute tick retries — the failure becomes
  // self-healing instead of terminal. reassigned_count is decremented back so
  // a retry loop cannot inflate a case's reassignment history.
  //
  // ── REGRESSION FIX (F5) ────────────────────────────────────────────────
  //
  // This comment used to claim "the acceptance_deadline_at deliberately stays
  // in the past: that is what makes the row eligible again on the next tick."
  // That was simply not true of the code. The assign UPDATE above had ALREADY
  // moved acceptance_deadline_at forward to `now + acceptMinutes`, and the
  // rollback never touched it — so the row failed the sweep's
  // `acceptance_deadline_at < NOW()` predicate for the whole of the new
  // window. The advertised "self-healing retry in 2 minutes" was in reality a
  // retry in up to 2 HOURS on a standard case, on a paid case with no doctor.
  // It is now explicitly reset, which is what the comment always described.
  //
  // Status is restored to the row's PRIOR value rather than forced to 'paid'.
  // The sweep accepts five statuses ('pending','available','submitted','new',
  // 'paid'); forcing 'paid' silently rewrote the lifecycle state of the other
  // four on a path whose entire purpose is to leave no trace. COALESCE keeps
  // 'paid' as the fallback for the impossible case of a NULL status.
  //
  // If the INSERT actually committed and only the ack was lost, the rollback
  // leaves an orphan doctor_assignments row on an unassigned case. That is
  // harmless: every consumer joins it to orders with status='assigned' AND
  // doctor_id IS NOT NULL, and the retry's row wins on MAX(assigned_at).
  try {
    await execute(
      `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accept_by_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [order.id, doctor.id, nowIso, acceptByAt]
    );
  } catch (e) {
    logErrorToDb(e, {
      context: 'acceptance_watcher.mirror_assignment',
      category: 'sla',
      orderId: order.id,
      userId: doctor.id
    });
    console.error('[acceptance_watcher] doctor_assignments mirror INSERT failed for order ' +
                  order.id + ' — rolling back the claim: ' + (e && e.message));

    let rolledBack = null;
    try {
      const rollbackTs = new Date().toISOString();
      rolledBack = await execute(
        `UPDATE orders
            SET doctor_id = NULL,
                status = COALESCE($4, 'paid'),
                acceptance_deadline_at = $1,
                reassigned_count = GREATEST(COALESCE(reassigned_count, 1) - 1, 0),
                updated_at = $1
          WHERE id = $2
            AND doctor_id = $3
            AND LOWER(COALESCE(status, '')) = 'assigned'
            AND accepted_at IS NULL`,
        [rollbackTs, order.id, doctor.id, order.status || null]
      );
    } catch (rollbackErr) {
      logErrorToDb(rollbackErr, {
        context: 'acceptance_watcher.mirror_assignment_rollback',
        category: 'sla',
        orderId: order.id,
        userId: doctor.id
      });
    }

    // case_events, not order_events: ASSIGNMENT_MIRROR_FAILED is a registered
    // SILENT_FAILURE_EVENTS label (case_lifecycle.js) and /ops/silent-failures
    // queries case_events for `event_type LIKE '%_FAILED'`. logOrderEvent
    // writes order_events, which feeds the patient/admin case timeline — the
    // wrong surface for an infrastructure failure. Lazy require: no cycle
    // (case_lifecycle does not import this worker), and it keeps boot order
    // unchanged.
    try {
      const { logCaseEvent } = require('../case_lifecycle');
      await logCaseEvent(order.id, 'ASSIGNMENT_MIRROR_FAILED', {
        doctor_id: doctor.id,
        error: String((e && e.message) || e).slice(0, 500),
        rolled_back: Boolean(rolledBack && rolledBack.rowCount)
      });
    } catch (_) {}

    if (!rolledBack || rolledBack.rowCount === 0) {
      // THEME8-LINT-EXEMPT-HELPER: stdout triage line only. The failure itself
      // is already in error_logs (the logErrorToDb above, context
      // acceptance_watcher.mirror_assignment) and in case_events
      // (ASSIGNMENT_MIRROR_FAILED with rolled_back:false), which is what /ops
      // reads. Could not undo the claim — the doctor accepted in the meantime,
      // or the row moved on. Leaving it is correct: an accepted case is fine.
      console.error('[acceptance_watcher] rollback did not apply for order ' + order.id +
                    ' — case may be assigned without a doctor_assignments row');
    }
    return;
  }

  console.log('[acceptance_watcher] auto-assigned order ' + order.id + ' to doctor ' + doctor.id +
              ' (' + doctor.name + ') accept_by=' + acceptByAt + ' (' + acceptMinutes + 'm)');

  // Log event
  try {
    logOrderEvent({
      orderId: order.id,
      label: 'acceptance_timeout_auto_assigned',
      meta: { doctor_id: doctor.id, doctor_name: doctor.name, tier: order.tier },
      actorRole: 'system',
    });
  } catch (_) {}

  // Notify doctor (WhatsApp)
  queueNotification({
    orderId: order.id,
    toUserId: doctor.id,
    channel: 'whatsapp',
    template: TEMPLATES.CASE_AUTO_ASSIGNED,
    response: {
      case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
    },
    dedupe_key: 'auto_assign:' + order.id + ':' + doctor.id,
  });

  // Notify patient (WhatsApp)
  if (order.patient_id) {
    queueNotification({
      orderId: order.id,
      toUserId: order.patient_id,
      channel: 'whatsapp',
      template: TEMPLATES.CASE_ASSIGNED,
      response: {
        case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
        doctor_name: doctor.name || '',
      },
      dedupe_key: 'case_assigned_patient:' + order.id,
    });
  }

  // Notify admin (internal)
  queueNotification({
    orderId: order.id,
    toUserId: 'superadmin-1',
    channel: 'internal',
    template: 'acceptance_timeout_auto_assigned_admin',
    response: {
      case_ref: order.reference_id || String(order.id).slice(0, 12).toUpperCase(),
      doctor_id: doctor.id,
      doctor_name: doctor.name,
    },
    dedupe_key: 'auto_assign_admin:' + order.id,
  });
}

function startAcceptanceWatcher() {
  console.log('[acceptance_watcher] started (interval: 2 minutes)');
  runAcceptanceWatcherSweep();
  return setInterval(runAcceptanceWatcherSweep, 2 * 60 * 1000);
}

module.exports = { startAcceptanceWatcher, runAcceptanceWatcherSweep };
