const { randomUUID } = require('crypto');
const { db } = require('./db');
const { queueNotification } = require('./notify');
const { logOrderEvent } = require('./audit');

function checkAndMarkBreaches() {
  const now = new Date();
  const nowIso = now.toISOString();

  const candidates = db
    .prepare(
      `SELECT * FROM orders
       WHERE status IN ('accepted','in_review')
         AND deadline_at IS NOT NULL
         AND breached_at IS NULL
         AND completed_at IS NULL
         AND deadline_at < ?`
    )
    .all(nowIso);

  if (!candidates || !candidates.length) return;

  const updateOrder = db.prepare(
    `UPDATE orders
     SET status = 'breached',
         breached_at = ?,
         updated_at = ?
     WHERE id = ?`
  );

  const insertEvent = db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at, actor_role)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const superadmins = db
    .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
    .all();

  candidates.forEach((order) => {
    try {
      updateOrder.run(nowIso, nowIso, order.id);

      // event log
      try {
        insertEvent.run(
          randomUUID(),
          order.id,
          'SLA breached (deadline missed)',
          JSON.stringify({ reason: 'deadline_missed' }),
          nowIso,
          'system'
        );
      } catch (e) {
        // fallback to helper if prepared insert fails
        logOrderEvent({
          orderId: order.id,
          label: 'SLA breached (deadline missed)',
          meta: JSON.stringify({ reason: 'deadline_missed' }),
          actorRole: 'system'
        });
      }

      // notify doctor
      if (order.doctor_id) {
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_breached_doctor',
          status: 'queued'
        });
      }

      // notify superadmins
      superadmins.forEach((adm) => {
        queueNotification({
          orderId: order.id,
          toUserId: adm.id,
          channel: 'internal',
          template: 'sla_breached_superadmin',
          status: 'queued'
        });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SLA] failed to mark breach', order.id, err);
    }
  });
}

// Alias used by some routes
function runSlaSweep() {
  return checkAndMarkBreaches();
}

// Alias used by some routes
function recalcSlaBreaches() {
  return checkAndMarkBreaches();
}

module.exports = { runSlaSweep, checkAndMarkBreaches, recalcSlaBreaches };
