// src/jobs/sla_watcher.js
const cron = require('node-cron');
const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { queueNotification } = require('../notify');
const { logOrderEvent } = require('../audit');

async function findAlternateDoctor(specialtyId, excludeDoctorId) {
  return await queryOne(
    `SELECT id, name
     FROM users
     WHERE role = 'doctor'
       AND is_active = true
       AND id != $1
       AND specialty_id = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [excludeDoctorId, specialtyId]
  );
}

async function findSuperadmins() {
  return await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
  );
}

async function reassignOrder(order, newDoctor, nowIso) {
  await execute(
    `UPDATE orders
     SET doctor_id = $1,
         reassigned_count = COALESCE(reassigned_count, 0) + 1,
         breached_at = $2,
         updated_at = $3
     WHERE id = $4`,
    [newDoctor.id, nowIso, nowIso, order.id]
  );

  logOrderEvent({
    orderId: order.id,
    label: 'Order auto-reassigned due to SLA breach',
    actorRole: 'system'
  });

  await queueNotification({
    orderId: order.id,
    toUserId: newDoctor.id,
    channel: 'internal',
    template: 'order_reassigned_due_to_sla_breach',
    status: 'queued'
  });
}

async function markBreachNoDoctor(order, nowIso) {
  await execute(
    `UPDATE orders
     SET breached_at = $1,
         updated_at = $2
     WHERE id = $3`,
    [nowIso, nowIso, order.id]
  );

  logOrderEvent({
    orderId: order.id,
    label: 'Order breached deadline with no available doctors',
    actorRole: 'system'
  });

  const supers = await findSuperadmins();
  for (const sa of supers) {
    await queueNotification({
      orderId: order.id,
      toUserId: sa.id,
      channel: 'internal',
      template: 'order_deadline_breached_no_doctor',
      status: 'queued'
    });
  }
}

async function runOnce(now = new Date()) {
  const nowIso = now.toISOString();
  const overdueOrders = await queryAll(
    `SELECT *
     FROM orders
     WHERE status = 'accepted'
       AND completed_at IS NULL
       AND deadline_at IS NOT NULL
       AND deadline_at < $1
       AND (breached_at IS NULL OR breached_at < $2)`,
    [nowIso, nowIso]
  );

  for (const order of overdueOrders) {
    await withTransaction(async (client) => {
      // Try to reassign
      const newDoctor = await findAlternateDoctor(order.specialty_id, order.doctor_id);
      if (newDoctor) {
        await reassignOrder(order, newDoctor, nowIso);
      } else {
        await markBreachNoDoctor(order, nowIso);
      }
    });
  }
}


module.exports = {
  runOnce
};
