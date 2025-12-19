// src/jobs/sla_watcher.js
const cron = require('node-cron');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { queueNotification } = require('../notify');
const { logOrderEvent } = require('../audit');

function findAlternateDoctor(specialtyId, excludeDoctorId) {
  return db
    .prepare(
      `SELECT id, name
       FROM users
       WHERE role = 'doctor'
         AND is_active = 1
         AND id != ?
         AND specialty_id = ?
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(excludeDoctorId, specialtyId);
}

function findSuperadmins() {
  return db
    .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
    .all();
}

function reassignOrder(order, newDoctor, nowIso) {
  db.prepare(
    `UPDATE orders
     SET doctor_id = ?,
         reassigned_count = COALESCE(reassigned_count, 0) + 1,
         breached_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(newDoctor.id, nowIso, nowIso, order.id);

  logOrderEvent({
    orderId: order.id,
    label: 'Order auto-reassigned due to SLA breach',
    actorRole: 'system'
  });

  queueNotification({
    orderId: order.id,
    toUserId: newDoctor.id,
    channel: 'internal',
    template: 'order_reassigned_due_to_sla_breach',
    status: 'queued'
  });
}

function markBreachNoDoctor(order, nowIso) {
  db.prepare(
    `UPDATE orders
     SET breached_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso, nowIso, order.id);

  logOrderEvent({
    orderId: order.id,
    label: 'Order breached deadline with no available doctors',
    actorRole: 'system'
  });

  const supers = findSuperadmins();
  supers.forEach((sa) => {
    queueNotification({
      orderId: order.id,
      toUserId: sa.id,
      channel: 'internal',
      template: 'order_deadline_breached_no_doctor',
      status: 'queued'
    });
  });
}

function runOnce(now = new Date()) {
  const nowIso = now.toISOString();
  const overdueOrders = db
    .prepare(
      `SELECT *
       FROM orders
       WHERE status = 'accepted'
         AND completed_at IS NULL
         AND deadline_at IS NOT NULL
         AND datetime(deadline_at) < datetime(?)
         AND (breached_at IS NULL OR datetime(breached_at) < datetime(?))`
    )
    .all(nowIso, nowIso);

  overdueOrders.forEach((order) => {
    db.transaction(() => {
      // Try to reassign
      const newDoctor = findAlternateDoctor(order.specialty_id, order.doctor_id);
      if (newDoctor) {
        reassignOrder(order, newDoctor, nowIso);
      } else {
        markBreachNoDoctor(order, nowIso);
      }
    })();
  });
}


module.exports = {
  runOnce
};
