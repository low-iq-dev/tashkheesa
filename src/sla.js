const { randomUUID } = require('crypto');
const { queryAll, execute } = require('./pg');
const { queueNotification, queueMultiChannelNotification } = require('./notify');
const { logOrderEvent } = require('./audit');

async function checkAndMarkBreaches() {
  const now = new Date();
  const nowIso = now.toISOString();

  const candidates = await queryAll(
    `SELECT * FROM orders
     WHERE status IN ('accepted','in_review')
       AND deadline_at IS NOT NULL
       AND breached_at IS NULL
       AND completed_at IS NULL
       AND deadline_at < $1`,
    [nowIso]
  );

  if (!candidates || !candidates.length) return;

  const superadmins = await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin' AND is_active = true"
  );

  for (const order of candidates) {
    try {
      await execute(
        `UPDATE orders
         SET status = 'breached',
             breached_at = $1,
             updated_at = $2
         WHERE id = $3`,
        [nowIso, nowIso, order.id]
      );

      // event log
      try {
        await execute(
          `INSERT INTO order_events (id, order_id, label, meta, at, actor_role)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            order.id,
            'SLA breached (deadline missed)',
            JSON.stringify({ reason: 'deadline_missed' }),
            nowIso,
            'system'
          ]
        );
      } catch (e) {
        // fallback to helper if direct insert fails
        logOrderEvent({
          orderId: order.id,
          label: 'SLA breached (deadline missed)',
          meta: JSON.stringify({ reason: 'deadline_missed' }),
          actorRole: 'system'
        });
      }

      // notify doctor (email + internal)
      if (order.doctor_id) {
        await queueMultiChannelNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channels: ['email', 'internal'],
          template: 'sla_breached_doctor',
          response: {
            caseReference: String(order.id).slice(0, 12).toUpperCase(),
          },
        });
      }

      // notify superadmins
      for (const adm of superadmins) {
        await queueNotification({
          orderId: order.id,
          toUserId: adm.id,
          channel: 'internal',
          template: 'sla_breached_superadmin',
          status: 'queued'
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SLA] failed to mark breach', order.id, err);
    }
  }
}

/**
 * Send milestone warnings for 24h SLA orders at 75% and 90% of deadline.
 * Uses dedupe keys so each milestone fires at most once per order.
 */
async function checkSla24hrMilestones() {
  const now = new Date();
  const nowIso = now.toISOString();

  const slaOrders = await queryAll(
    `SELECT * FROM orders
     WHERE sla_24hr_selected = true
       AND sla_24hr_deadline IS NOT NULL
       AND status IN ('accepted','in_review')
       AND completed_at IS NULL
       AND breached_at IS NULL`
  );

  if (!slaOrders || !slaOrders.length) return;

  for (const order of slaOrders) {
    try {
      const deadline = new Date(order.sla_24hr_deadline);
      const created = new Date(order.accepted_at || order.created_at);
      const totalMs = deadline.getTime() - created.getTime();
      const elapsedMs = now.getTime() - created.getTime();

      if (totalMs <= 0) continue;

      const pct = elapsedMs / totalMs;
      const hoursRemaining = Math.max(0, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60));

      // 75% milestone (~6h remaining for 24h SLA)
      if (pct >= 0.75 && pct < 0.90 && order.doctor_id) {
        await queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_24hr_warning_75',
          status: 'queued',
          response: JSON.stringify({ hours_remaining: Math.round(hoursRemaining * 10) / 10 }),
          dedupe_key: `sla24:75:${order.id}`
        });
      }

      // 90% milestone (~2.4h remaining for 24h SLA)
      if (pct >= 0.90 && order.doctor_id) {
        await queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_24hr_warning_90',
          status: 'queued',
          response: JSON.stringify({ hours_remaining: Math.round(hoursRemaining * 10) / 10 }),
          dedupe_key: `sla24:90:${order.id}`
        });
        // Also WhatsApp for urgent 90%
        await queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'whatsapp',
          template: 'sla_24hr_warning_90',
          status: 'queued',
          response: JSON.stringify({ hours_remaining: Math.round(hoursRemaining * 10) / 10 }),
          dedupe_key: `sla24:90:whatsapp:${order.id}`
        });
      }
    } catch (err) {
      console.error('[SLA] 24h milestone check failed', order.id, err);
    }
  }
}

// Alias used by some routes
async function runSlaSweep() {
  await checkAndMarkBreaches();
  await checkSla24hrMilestones();
}

// Alias used by some routes
async function recalcSlaBreaches() {
  return await checkAndMarkBreaches();
}

module.exports = { runSlaSweep, checkAndMarkBreaches, recalcSlaBreaches, checkSla24hrMilestones };
