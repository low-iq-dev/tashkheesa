// src/sla_watcher.js

const { queryOne, queryAll, execute, withTransaction } = require('./pg');
const { queueNotification } = require('./notify');
const { logOrderEvent } = require('./audit');
const { isDryRun, dryRunLog } = require('./slaDryRun');

/**
 * Helpers
 */

async function findSuperadmins() {
  return await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
  );
}

async function hasPreBreachEvent(orderId) {
  const row = await queryOne(
    "SELECT 1 FROM order_events WHERE order_id = $1 AND label = 'SLA pre-breach alert' LIMIT 1",
    [orderId]
  );
  return !!row;
}

/**
 * Main SLA sweep
 */
async function runSlaSweep(now = new Date()) {
  const nowTime = now.getTime();

  // Candidate orders
  const candidates = await queryAll(
    `SELECT *
     FROM orders
     WHERE status IN ('new','accepted','in_review')
       AND sla_hours IS NOT NULL
       AND deadline_at IS NOT NULL
       AND (payment_status IS NULL OR payment_status = 'paid')`
  );

  const superadmins = await findSuperadmins();

  /**
   * PRE-BREACH HANDLING (read + notify only)
   */
  for (const order of candidates) {
    const deadline = new Date(order.deadline_at);
    const deltaMs = deadline.getTime() - nowTime;

    // Pre-breach window: 0-60 minutes before deadline
    const withinPreBreach = deltaMs > 0 && deltaMs <= 60 * 60 * 1000;

    if (withinPreBreach && !(await hasPreBreachEvent(order.id))) {
      logOrderEvent({
        orderId: order.id,
        label: 'SLA pre-breach alert',
        actorRole: 'system'
      });

      for (const sa of superadmins) {
        if (isDryRun()) {
          dryRunLog('Would send SLA pre-breach notification', {
            orderId: order.id,
            toUserId: sa.id
          });
        } else {
          await queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_prebreach',
            status: 'queued'
          });
        }
      }
    }
  }

  /**
   * BREACH HANDLING (single authoritative path)
   */
  const breached = candidates.filter((order) => {
    const deadline = new Date(order.deadline_at);
    return nowTime > deadline.getTime();
  });

  for (const order of breached) {
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

      continue;
    }

    // -------------------------
    // REAL MUTATION PATH
    // -------------------------
    await withTransaction(async (client) => {
      const nowIso = new Date().toISOString();

      // Mark breached
      await client.query(
        `UPDATE orders
         SET status = 'breached',
             breached_at = $1,
             updated_at = $2
         WHERE id = $3`,
        [nowIso, nowIso, order.id]
      );

      logOrderEvent({
        orderId: order.id,
        label: 'SLA breached',
        actorRole: 'system'
      });

      // If no assigned doctor -> notify admins only
      if (!order.doctor_id) {
        for (const sa of superadmins) {
          await queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_breached_no_reassign',
            status: 'queued'
          });
        }
        return;
      }

      // Find replacement doctor
      const newDoctor = await queryOne(
        `SELECT id, name
         FROM users
         WHERE role = 'doctor'
           AND is_active = true
           AND (specialty_id = $1 OR specialty_id IS NULL)
           AND id != $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [order.specialty_id, order.doctor_id]
      );

      if (!newDoctor) {
        for (const sa of superadmins) {
          await queueNotification({
            orderId: order.id,
            toUserId: sa.id,
            channel: 'internal',
            template: 'order_sla_breached_no_reassign',
            status: 'queued'
          });
        }
        return;
      }

      // Reassign
      await client.query(
        `UPDATE orders
         SET doctor_id = $1,
             reassigned_count = COALESCE(reassigned_count, 0) + 1,
             updated_at = $2
         WHERE id = $3`,
        [newDoctor.id, nowIso, order.id]
      );

      logOrderEvent({
        orderId: order.id,
        label: `Reassigned to ${newDoctor.name}`,
        actorRole: 'system'
      });

      // Notifications
      await queueNotification({
        orderId: order.id,
        toUserId: order.doctor_id,
        channel: 'internal',
        template: 'order_reassigned_from_doctor',
        status: 'queued'
      });

      await queueNotification({
        orderId: order.id,
        toUserId: newDoctor.id,
        channel: 'internal',
        template: 'order_reassigned_to_doctor',
        status: 'queued'
      });

      for (const sa of superadmins) {
        await queueNotification({
          orderId: order.id,
          toUserId: sa.id,
          channel: 'internal',
          template: 'order_reassigned_sla_breached',
          status: 'queued'
        });
      }
    });
  }
}

module.exports = { runSlaSweep };
