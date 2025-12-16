const { db } = require('./db');
const { queueNotification } = require('./notify');
const { randomUUID } = require('crypto');

function runSlaSweep() {
  const now = new Date();
  const nowIso = now.toISOString();

  let superadmins = [];
  try {
    superadmins = db
      .prepare("SELECT id FROM users WHERE role = 'superadmin' AND is_active = 1")
      .all();
  } catch (err) {
    console.error('[SLA] failed to load superadmins', err);
  }

  let orders = [];
  try {
    orders = db
      .prepare(
        "SELECT * FROM orders WHERE status IN ('accepted','in_review') AND deadline_at IS NOT NULL"
      )
      .all();
  } catch (err) {
    console.error('[SLA] failed to load orders', err);
    return;
  }

  orders.forEach((order) => {
    try {
      const deadline = new Date(order.deadline_at);
      if (isNaN(deadline)) return;

      const minutesToDeadline = (deadline.getTime() - now.getTime()) / 60000;

      // Pre-deadline warning
      if (
        minutesToDeadline <= 60 &&
        minutesToDeadline > 0
      ) {
        const existingWarn = db
          .prepare(
            "SELECT 1 FROM order_events WHERE order_id = ? AND label = 'SLA warning: 1 hour before deadline' LIMIT 1"
          )
          .get(order.id);
        if (!existingWarn) {
          db.prepare(
            `INSERT INTO order_events (id, order_id, label, meta, at)
             VALUES (?, ?, ?, ?, ?)`
          ).run(
            randomUUID(),
            order.id,
            'SLA warning: 1 hour before deadline',
            JSON.stringify({ deadline: order.deadline_at }),
            nowIso
          );

          superadmins.forEach((sa) => {
            try {
              queueNotification({
                orderId: order.id,
                toUserId: sa.id,
                channel: 'internal',
                template: 'sla_warning_1h',
                status: 'queued',
              });
            } catch (err) {
              console.error('[SLA] warn notify fail', err);
            }
          });
        }
      }

      // Breach handling
      if (
        deadline.getTime() <= now.getTime() &&
        order.status !== 'completed' &&
        order.status !== 'breached'
      ) {
        db.prepare(
          `UPDATE orders
             SET status = 'breached',
                 breached_at = ?,
                 updated_at = ?,
                 reassigned_count = reassigned_count + 1,
                 doctor_id = NULL
           WHERE id = ?`
        ).run(nowIso, nowIso, order.id);

        db.prepare(
          `INSERT INTO order_events (id, order_id, label, meta, at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          order.id,
          'SLA breached – case returned to unassigned queue',
          null,
          nowIso
        );

        superadmins.forEach((sa) => {
          try {
            queueNotification({
              orderId: order.id,
              toUserId: sa.id,
              channel: 'internal',
              template: 'sla_breached',
              status: 'queued',
            });
          } catch (err) {
            console.error('[SLA] breach notify fail', err);
          }
        });
      }
    } catch (err) {
      console.error('[SLA] error processing order', order.id, err);
    }
  });
}

module.exports = { runSlaSweep };
