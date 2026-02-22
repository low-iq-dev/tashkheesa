const { queryOne, queryAll, execute } = require('./pg');
const { queueNotification } = require('./notify');
const { randomUUID } = require('crypto');

async function runSlaSweep() {
  const now = new Date();
  const nowIso = now.toISOString();

  let superadmins = [];
  try {
    superadmins = await queryAll(
      "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
    );
  } catch (err) {
    console.error('[SLA] failed to load superadmins', err);
  }

  let orders = [];
  try {
    orders = await queryAll(
      "SELECT * FROM orders WHERE status IN ('accepted','in_review') AND deadline_at IS NOT NULL"
    );
  } catch (err) {
    console.error('[SLA] failed to load orders', err);
    return;
  }

  for (const order of orders) {
    try {
      const deadline = new Date(order.deadline_at);
      if (isNaN(deadline)) continue;

      const minutesToDeadline = (deadline.getTime() - now.getTime()) / 60000;

      // Pre-deadline warning
      if (
        minutesToDeadline <= 60 &&
        minutesToDeadline > 0
      ) {
        const existingWarn = await queryOne(
          "SELECT 1 FROM order_events WHERE order_id = $1 AND label = 'SLA warning: 1 hour before deadline' LIMIT 1",
          [order.id]
        );
        if (!existingWarn) {
          await execute(
            `INSERT INTO order_events (id, order_id, label, meta, at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              order.id,
              'SLA warning: 1 hour before deadline',
              JSON.stringify({ deadline: order.deadline_at }),
              nowIso
            ]
          );

          for (const sa of superadmins) {
            try {
              await queueNotification({
                orderId: order.id,
                toUserId: sa.id,
                channel: 'internal',
                template: 'sla_warning_1h',
                status: 'queued',
              });
            } catch (err) {
              console.error('[SLA] warn notify fail', err);
            }
          }
        }
      }

      // Breach handling
      if (
        deadline.getTime() <= now.getTime() &&
        order.status !== 'completed' &&
        order.status !== 'breached'
      ) {
        await execute(
          `UPDATE orders
             SET status = 'breached',
                 breached_at = $1,
                 updated_at = $2,
                 reassigned_count = reassigned_count + 1,
                 doctor_id = NULL
           WHERE id = $3`,
          [nowIso, nowIso, order.id]
        );

        await execute(
          `INSERT INTO order_events (id, order_id, label, meta, at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            randomUUID(),
            order.id,
            'SLA breached \u2013 case returned to unassigned queue',
            null,
            nowIso
          ]
        );

        for (const sa of superadmins) {
          try {
            await queueNotification({
              orderId: order.id,
              toUserId: sa.id,
              channel: 'internal',
              template: 'sla_breached',
              status: 'queued',
            });
          } catch (err) {
            console.error('[SLA] breach notify fail', err);
          }
        }
      }
    } catch (err) {
      console.error('[SLA] error processing order', order.id, err);
    }
  }
}

module.exports = { runSlaSweep };
