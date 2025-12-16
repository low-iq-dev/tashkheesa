const { db } = require('./db');
const { queueNotification } = require('./notify');
const { randomUUID } = require('crypto');

let workerStarted = false;

function insertEvent(orderId, label, meta, atIso) {
  const metaValue =
    typeof meta === 'string' ? meta : (meta ? JSON.stringify(meta) : null);
  db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), orderId, label, metaValue, atIso);
}

function notifySupers(orderId, template) {
  const supers = db
    .prepare("SELECT id FROM users WHERE role = 'superadmin'")
    .all();
  supers.forEach((u) =>
    queueNotification({
      orderId,
      toUserId: u.id,
      channel: 'internal',
      template,
      status: 'queued'
    })
  );
}

function notifyDoctor(orderId, doctorId, template) {
  if (!doctorId) return;
  queueNotification({
    orderId,
    toUserId: doctorId,
    channel: 'internal',
    template,
    status: 'queued'
  });
}

function detectWarnings(now, nowIso) {
  const oneHourAhead = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const candidates = db
    .prepare(
      `SELECT id, deadline_at
       FROM orders
       WHERE status IN ('accepted','in_review')
         AND deadline_at IS NOT NULL
         AND breached_at IS NULL
         AND deadline_at > ?
         AND deadline_at <= ?`
    )
    .all(nowIso, oneHourAhead);

  candidates.forEach((order) => {
    const hasWarning = db
      .prepare(
        `SELECT 1 FROM order_events
         WHERE order_id = ?
           AND label = 'SLA warning – 1 hour before deadline'
         LIMIT 1`
      )
      .get(order.id);
    if (hasWarning) return;

    insertEvent(order.id, 'SLA warning – 1 hour before deadline', null, nowIso);
    notifySupers(order.id, 'sla_warning_superadmin');
  });
}

function detectBreaches(nowIso) {
  const overdue = db
    .prepare(
      `SELECT id, doctor_id
       FROM orders
       WHERE status IN ('accepted','in_review')
         AND deadline_at IS NOT NULL
         AND breached_at IS NULL
         AND deadline_at < ?`
    )
    .all(nowIso);

  overdue.forEach((order) => {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, nowIso, order.id);

      insertEvent(order.id, 'SLA breached', null, nowIso);
    });
    tx();

    notifyDoctor(order.id, order.doctor_id, 'sla_breached_doctor');
    notifySupers(order.id, 'sla_breached_superadmin');
  });
}

function autoReassign(now) {
  const breached = db
    .prepare(
      `SELECT id, doctor_id, specialty_id, sla_hours, reassigned_count
       FROM orders
       WHERE status = 'breached'
         AND doctor_id IS NOT NULL
         AND COALESCE(reassigned_count, 0) < 3`
    )
    .all();

  breached.forEach((order) => {
    const newDoctor = db
      .prepare(
        `SELECT id
         FROM users
         WHERE role = 'doctor'
           AND specialty_id = ?
           AND id != ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(order.specialty_id, order.doctor_id);

    if (!newDoctor) {
      insertEvent(order.id, 'SLA breached – no alternate doctor available', null, now.toISOString());
      return;
    }

    const nowIso = now.toISOString();
    const newDeadline = new Date(now.getTime() + Number(order.sla_hours || 0) * 60 * 60 * 1000).toISOString();

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE orders
         SET doctor_id = ?,
             status = 'accepted',
             accepted_at = ?,
             deadline_at = ?,
             updated_at = ?,
             reassigned_count = COALESCE(reassigned_count, 0) + 1
         WHERE id = ?`
      ).run(newDoctor.id, nowIso, newDeadline, nowIso, order.id);

      insertEvent(order.id, 'Order reassigned due to SLA breach', JSON.stringify({ from: order.doctor_id, to: newDoctor.id }), nowIso);
    });
    tx();

    notifyDoctor(order.id, newDoctor.id, 'order_reassigned_doctor');
    notifySupers(order.id, 'order_reassigned_superadmin');
  });
}

function runSweep() {
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    detectWarnings(now, nowIso);
    detectBreaches(nowIso);
    autoReassign(now);
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
