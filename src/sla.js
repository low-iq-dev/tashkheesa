const { randomUUID } = require('crypto');
const { db } = require('./db');
const { queueNotification, queueMultiChannelNotification } = require('./notify');
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

      // notify doctor (email + internal)
      if (order.doctor_id) {
        queueMultiChannelNotification({
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

/**
 * Send milestone warnings for 24h SLA orders at 75% and 90% of deadline.
 * Uses dedupe keys so each milestone fires at most once per order.
 */
function checkSla24hrMilestones() {
  const now = new Date();
  const nowIso = now.toISOString();

  const slaOrders = db
    .prepare(
      `SELECT * FROM orders
       WHERE sla_24hr_selected = 1
         AND sla_24hr_deadline IS NOT NULL
         AND status IN ('accepted','in_review')
         AND completed_at IS NULL
         AND breached_at IS NULL`
    )
    .all();

  if (!slaOrders || !slaOrders.length) return;

  slaOrders.forEach((order) => {
    try {
      const deadline = new Date(order.sla_24hr_deadline);
      const created = new Date(order.accepted_at || order.created_at);
      const totalMs = deadline.getTime() - created.getTime();
      const elapsedMs = now.getTime() - created.getTime();

      if (totalMs <= 0) return;

      const pct = elapsedMs / totalMs;
      const hoursRemaining = Math.max(0, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60));

      // 75% milestone (~6h remaining for 24h SLA)
      if (pct >= 0.75 && pct < 0.90 && order.doctor_id) {
        queueNotification({
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
        queueNotification({
          orderId: order.id,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_24hr_warning_90',
          status: 'queued',
          response: JSON.stringify({ hours_remaining: Math.round(hoursRemaining * 10) / 10 }),
          dedupe_key: `sla24:90:${order.id}`
        });
        // Also WhatsApp for urgent 90%
        queueNotification({
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
  });
}

// Alias used by some routes
function runSlaSweep() {
  checkAndMarkBreaches();
  checkSla24hrMilestones();
}

// Alias used by some routes
function recalcSlaBreaches() {
  return checkAndMarkBreaches();
}

module.exports = { runSlaSweep, checkAndMarkBreaches, recalcSlaBreaches, checkSla24hrMilestones };
