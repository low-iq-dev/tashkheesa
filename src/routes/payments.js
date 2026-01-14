const express = require('express');
const { db } = require('../db');
const { logOrderEvent } = require('../audit');
const { queueNotification } = require('../notify');

const router = express.Router();

router.use(express.json());

function normalizeStatus(input) {
  if (!input) return null;
  const s = String(input).toLowerCase();
  if (['success', 'paid', 'complete', 'completed'].includes(s)) return 'paid';
  if (['fail', 'failed', 'error'].includes(s)) return 'failed';
  if (['cancel', 'cancelled', 'canceled'].includes(s)) return 'cancelled';
  return null;
}

router.post('/callback', (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret && secret !== providedSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { order_id: orderId, status, method, reference, payment_link } = req.body || {};
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'order_id required' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'order not found' });
  }

  const normalized = normalizeStatus(status);
  if (!normalized) {
    logOrderEvent({
      orderId,
      label: `Payment callback: status=${status || 'unknown'}`,
      meta: JSON.stringify({ status, method, reference }),
      actorRole: 'system'
    });
    return res.json({ ok: true });
  }

  if (normalized !== 'paid') {
    logOrderEvent({
      orderId,
      label: `Payment callback: status=${normalized}`,
      meta: JSON.stringify({ status, method, reference }),
      actorRole: 'system'
    });
    return res.json({ ok: true });
  }

  const nowIso = new Date().toISOString();
db.prepare(
  `UPDATE orders
   SET payment_status = 'paid',
       paid_at = COALESCE(paid_at, ?),
       status = CASE
         WHEN status IN ('SUBMITTED','DRAFT') THEN 'PAID'
         ELSE status
       END,
       uploads_locked = 1,
       payment_method = COALESCE(?, payment_method, 'gateway'),
       payment_reference = COALESCE(?, payment_reference),
       payment_link = COALESCE(?, payment_link),
       updated_at = ?
   WHERE id = ?`
).run(
  nowIso,
  method || 'gateway',
  reference || null,
  payment_link || null,
  nowIso,
  orderId
);

  logOrderEvent({
    orderId,
    label: 'Payment confirmed via gateway',
    meta: JSON.stringify({ status, method, reference }),
    actorRole: 'system'
  });

  logOrderEvent({
    orderId,
    label: 'payment_confirmed',
    meta: JSON.stringify({ status: normalized, method, reference }),
    actorRole: 'system'
  });

  queueNotification({
    orderId,
    toUserId: order.patient_id,
    channel: 'internal',
    template: 'payment_success_patient',
    status: 'queued'
  });
  if (order.doctor_id) {
    queueNotification({
      orderId,
      toUserId: order.doctor_id,
      channel: 'internal',
      template: 'payment_success_doctor',
      status: 'queued'
    });
  }

  return res.json({ ok: true });
});

module.exports = router;
