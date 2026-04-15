// src/workers/acceptance_watcher.js
// Runs every 2 minutes. Auto-assigns orders whose acceptance deadline has expired.

const { queryOne, queryAll, execute } = require('../pg');
const { queueNotification } = require('../notify');
const { TEMPLATES } = require('../notify/templates');
const { logOrderEvent } = require('../audit');

let running = false;

async function runAcceptanceWatcherSweep() {
  if (running) return;
  running = true;

  try {
    const expiredOrders = await queryAll(`
      SELECT o.id, o.specialty_id, o.service_id, o.reference_id, o.patient_id,
             o.tier, o.urgency_flag, o.sla_24hr_selected
      FROM orders o
      WHERE o.doctor_id IS NULL
        AND o.acceptance_deadline_at IS NOT NULL
        AND o.acceptance_deadline_at < NOW()
        AND LOWER(COALESCE(o.status, '')) IN ('pending', 'available', 'submitted', 'new', 'paid')
        AND LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')
    `);

    if (!expiredOrders || expiredOrders.length === 0) {
      return;
    }

    console.log('[acceptance_watcher] found ' + expiredOrders.length + ' expired orders');

    for (const order of expiredOrders) {
      try {
        await autoAssignOrder(order);
      } catch (err) {
        console.error('[acceptance_watcher] failed to auto-assign order ' + order.id + ':', err.message);
      }
    }
  } catch (err) {
    console.error('[acceptance_watcher] sweep failed:', err.message);
  } finally {
    running = false;
  }
}

async function autoAssignOrder(order) {
  // Resolve specialty
  let specialtyId = order.specialty_id;
  if (!specialtyId && order.service_id) {
    const svc = await queryOne('SELECT specialty_id FROM services WHERE id = $1', [order.service_id]);
    specialtyId = svc ? svc.specialty_id : null;
  }

  // Find the most available doctor in the specialty
  const doctor = await queryOne(`
    SELECT u.id, u.name
    FROM users u
    JOIN doctor_specialties ds ON ds.doctor_id = u.id
    WHERE ds.specialty_id = $1
      AND u.role = 'doctor'
      AND COALESCE(u.is_active, true) = true
      AND COALESCE(u.is_available, true) = true
    ORDER BY (
      SELECT COUNT(*) FROM orders o
      WHERE o.doctor_id = u.id
        AND LOWER(o.status) NOT IN ('completed', 'cancelled')
    ) ASC
    LIMIT 1
  `, [specialtyId]);

  if (!doctor) {
    console.warn('[acceptance_watcher] no available doctor for order ' + order.id + ' specialty=' + specialtyId);
    return;
  }

  // Idempotency guard: only assign if still unassigned
  const nowIso = new Date().toISOString();
  const result = await execute(
    `UPDATE orders
     SET doctor_id = $1,
         status = 'assigned',
         accepted_at = $2,
         reassigned_count = COALESCE(reassigned_count, 0) + 1,
         updated_at = $2
     WHERE id = $3
       AND doctor_id IS NULL`,
    [doctor.id, nowIso, order.id]
  );

  if (!result || result.rowCount === 0) {
    return; // Already assigned by another process
  }

  console.log('[acceptance_watcher] auto-assigned order ' + order.id + ' to doctor ' + doctor.id + ' (' + doctor.name + ')');

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
