// src/workers/acceptance_watcher.js
// Runs every 2 minutes. Auto-assigns orders whose acceptance deadline has expired.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('../notify/templates');
const { logOrderEvent } = require('../audit');
const { logErrorToDb } = require('../logger');
const { eligibleDoctorClause } = require('../services/doctor_eligibility');
const { acceptanceMinutesForOrder, acceptanceDeadlineIso } = require('../acceptance_window');
const MAX_ACTIVE_CASES_PER_DOCTOR = Number(process.env.MAX_ACTIVE_CASES_PER_DOCTOR || 4);

let running = false;

async function runAcceptanceWatcherSweep() {
  if (running) return;
  running = true;

  try {
    const expiredOrders = await queryAll(`
      SELECT o.id, o.specialty_id, o.service_id, o.reference_id, o.patient_id,
             o.tier, o.urgency_flag, o.sla_24hr_selected
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
  // (case_sla_worker.fetchDoctorTimeouts) sees an explicit accept_by_at rather
  // than falling back to the legacy cutoff.
  try {
    await execute(
      `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accept_by_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [order.id, doctor.id, nowIso, acceptByAt]
    );
  } catch (e) { /* table may not exist on older deployments */ }

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
