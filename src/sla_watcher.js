// src/sla_watcher.js

const { db } = require('./db');
const { queueNotification } = require('./notify');
const { logOrderEvent } = require('./audit');
const { isDryRun, dryRunLog } = require('./slaDryRun');

/**
 * Helpers
 */

function findSuperadmins() {
  return db
    .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
    .all();
}

function hasPreBreachEvent(orderId) {
  const row = db
    .prepare(
      "SELECT 1 FROM order_events WHERE order_id = ? AND label = 'SLA pre-breach alert' LIMIT 1"
    )
    .get(orderId);
  return !!row;
}

/**
 * Main SLA sweep
 */
function runSlaSweep(now = new Date()) {
  const nowTime = now.getTime();

  // Candidate orders
  const candidates = db
    .prepare(
      `SELECT *
       FROM orders
       WHERE status IN ('new','accepted','in_review')
         AND sla_hours IS NOT NULL
         AND deadline_at IS NOT NULL
         AND (payment_status IS NULL OR payment_status = 'paid')`
    )
    .all();

  const superadmins = findSuperadmins();

  /**
   * PRE-BREACH HANDLING (read + notify only)
   */
  candidates.forEach((order) => {
    const deadline = new Date(order.deadline_at);
    const deltaMs = deadline.getTime() - nowTime;

    // Pre-breach window: 0–60 minutes before deadline
    const withinPreBreach = deltaMs > 0 && deltaMs <= 60 * 60 * 1000;

    if (withinPreBreach && !hasPreBreachEvent(order.id)) {
      logOrderEvent({
        orderId: order.id,
        label: 'SLA pre-breach alert',
        actorRole: 'system'
      });

      superadmins.forEach((sa) => {
        if (isDryRun()) {
          dryRunLog('Would send SLA pre-breach notification', {
            orderId: order.id,
            toUserId: sa.id
          });
        } else {
          queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_prebreach',
            status: 'queued'
          });
        }
      });
    }
  });

  /**
   * BREACH HANDLING (single authoritative path)
   */
  const breached = candidates.filter((order) => {
    const deadline = new Date(order.deadline_at);
    return nowTime > deadline.getTime();
  });

  breached.forEach((order) => {
    // -------------------------
    // DRY-RUN MODE (NO SIDE FX)
    // -------------------------
    if (isDryRun()) {
      dryRunLog('Would mark order as SLA breached', {
        orderId: order.id,
        deadline: order.deadline_at
      });

      if (order.doctor_id) {
        dryRunLog('Would attempt doctor reassignment', {
          orderId: order.id,
          fromDoctorId: order.doctor_id
        });
      }

      dryRunLog('Would send SLA breach notifications', {
        orderId: order.id
      });

      return;
    }

    // -------------------------
    // REAL MUTATION PATH
    // -------------------------
    const txn = db.transaction(() => {
      const nowIso = new Date().toISOString();

      // Mark breached
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: 'SLA breached',
        actorRole: 'system'
      });

      // If no assigned doctor → notify admins only
      if (!order.doctor_id) {
        superadmins.forEach((sa) => {
          queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_breached_no_reassign',
            status: 'queued'
          });
        });
        return;
      }

      // Find replacement doctor
      const newDoctor = db
        .prepare(
          `SELECT id, name
           FROM users
           WHERE role = 'doctor'
             AND is_active = 1
             AND (specialty_id = ? OR specialty_id IS NULL)
             AND id != ?
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get(order.specialty_id, order.doctor_id);

      if (!newDoctor) {
        superadmins.forEach((sa) => {
          queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_breached_no_reassign',
            status: 'queued'
          });
        });
        return;
      }

      // Reassign
      db.prepare(
        `UPDATE orders
         SET doctor_id = ?,
             reassigned_count = COALESCE(reassigned_count, 0) + 1,
             updated_at = ?
         WHERE id = ?`
      ).run(newDoctor.id, nowIso, order.id);

      logOrderEvent({
        orderId: order.id,
        label: `Reassigned to ${newDoctor.name}`,
        actorRole: 'system'
      });

      // Notifications
      queueNotification({
        orderId: order.id,
        toUserId: order.doctor_id,
        channel: 'internal',
        template: 'order_reassigned_from_doctor',
        status: 'queued'
      });

      queueNotification({
        orderId: order.id,
        toUserId: newDoctor.id,
        channel: 'internal',
        template: 'order_reassigned_to_doctor',
        status: 'queued'
      });

      superadmins.forEach((sa) => {
        queueNotification({
          orderId: order.id,
          toUserId: sa.id,
          channel: 'internal',
          template: 'order_reassigned_sla_breached',
          status: 'queued'
        });
      });
    });

    txn();
  });
}

module.exports = { runSlaSweep };