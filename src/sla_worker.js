const { queryOne, queryAll, execute, withTransaction } = require('./pg');
const { queueNotification } = require('./notify');
const { randomUUID } = require('crypto');

let workerStarted = false;

async function insertEvent(orderId, label, meta, atIso) {
  const metaValue =
    typeof meta === 'string' ? meta : (meta ? JSON.stringify(meta) : null);
  await execute(
    `INSERT INTO order_events (id, order_id, label, meta, at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), orderId, label, metaValue, atIso]
  );
}

async function notifySupers(orderId, template) {
  const supers = await queryAll(
    "SELECT id FROM users WHERE role = 'superadmin'"
  );
  for (const u of supers) {
    await queueNotification({
      orderId,
      toUserId: u.id,
      channel: 'internal',
      template,
      status: 'queued'
    });
  }
}

async function notifyDoctor(orderId, doctorId, template) {
  if (!doctorId) return;
  await queueNotification({
    orderId,
    toUserId: doctorId,
    channel: 'internal',
    template,
    status: 'queued'
  });
}

async function detectWarnings(now, nowIso) {
  const oneHourAhead = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const candidates = await queryAll(
    `SELECT id, deadline_at
     FROM orders
     WHERE status IN ('accepted','in_review')
       AND deadline_at IS NOT NULL
       AND breached_at IS NULL
       AND deadline_at > $1
       AND deadline_at <= $2`,
    [nowIso, oneHourAhead]
  );

  for (const order of candidates) {
    const hasWarning = await queryOne(
      `SELECT 1 FROM order_events
       WHERE order_id = $1
         AND label = 'SLA warning \u2013 1 hour before deadline'
       LIMIT 1`,
      [order.id]
    );
    if (hasWarning) continue;

    await insertEvent(order.id, 'SLA warning \u2013 1 hour before deadline', null, nowIso);
    await notifySupers(order.id, 'sla_warning_superadmin');
  }
}

async function detectBreaches(nowIso) {
  const overdue = await queryAll(
    `SELECT id, doctor_id
     FROM orders
     WHERE status IN ('accepted','in_review')
       AND deadline_at IS NOT NULL
       AND breached_at IS NULL
       AND deadline_at < $1`,
    [nowIso]
  );

  for (const order of overdue) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE orders
         SET status = 'breached',
             breached_at = $1,
             updated_at = $2
         WHERE id = $3`,
        [nowIso, nowIso, order.id]
      );

      const metaValue = null;
      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), order.id, 'SLA breached', metaValue, nowIso]
      );
    });

    await notifyDoctor(order.id, order.doctor_id, 'sla_breached_doctor');
    await notifySupers(order.id, 'sla_breached_superadmin');
  }
}

async function autoReassign(now) {
  const breached = await queryAll(
    `SELECT id, doctor_id, specialty_id, sla_hours, reassigned_count
     FROM orders
     WHERE status = 'breached'
       AND doctor_id IS NOT NULL
       AND COALESCE(reassigned_count, 0) < 3`
  );

  for (const order of breached) {
    const newDoctor = await queryOne(
      `SELECT id
       FROM users
       WHERE role = 'doctor'
         AND specialty_id = $1
         AND id != $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [order.specialty_id, order.doctor_id]
    );

    if (!newDoctor) {
      await insertEvent(order.id, 'SLA breached \u2013 no alternate doctor available', null, now.toISOString());
      continue;
    }

    const nowIso = now.toISOString();
    const newDeadline = new Date(now.getTime() + Number(order.sla_hours || 0) * 60 * 60 * 1000).toISOString();

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE orders
         SET doctor_id = $1,
             status = 'accepted',
             accepted_at = $2,
             deadline_at = $3,
             updated_at = $4,
             reassigned_count = COALESCE(reassigned_count, 0) + 1
         WHERE id = $5`,
        [newDoctor.id, nowIso, newDeadline, nowIso, order.id]
      );

      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), order.id, 'Order reassigned due to SLA breach', JSON.stringify({ from: order.doctor_id, to: newDoctor.id }), nowIso]
      );
    });

    await notifyDoctor(order.id, newDoctor.id, 'order_reassigned_doctor');
    await notifySupers(order.id, 'order_reassigned_superadmin');
  }
}

async function runSweep() {
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    await detectWarnings(now, nowIso);
    await detectBreaches(nowIso);
    await autoReassign(now);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[SLA worker] error', err);
  }
}

function startSlaWorker() {
  if (workerStarted) return;
  workerStarted = true;
  // run every 5 minutes
  runSweep();
  setInterval(runSweep, 5 * 60 * 1000);
}

const runSlaSweep = runSweep;

module.exports = { startSlaWorker, runSlaSweep };
