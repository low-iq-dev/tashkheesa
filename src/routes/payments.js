const express = require('express');
const { db } = require('../db');
const { logOrderEvent } = require('../audit');
const { queueNotification } = require('../notify');
const { markCasePaid } = require('../case_lifecycle');

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

// Canonical payment URL boundary: all reminders, dashboards, and views must use this helper; no other code should synthesize payment links.
function getOrCreatePaymentUrl(order) {
  if (order && order.payment_link && String(order.payment_link).trim() !== '') {
    return order.payment_link;
  }
  // Synthesize canonical hosted payment URL
  const url = `/portal/patient/pay/${order.id}`;
  // Persist the generated URL if not already present
  db.prepare('UPDATE orders SET payment_link = ? WHERE id = ?').run(url, order.id);
  return url;
}

router.post('/callback', (req, res) => {
const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!secret) {
  return res.status(503).json({ ok: false, error: 'webhook_not_configured' });
}

const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
if (secret !== providedSecret) {
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

  const alreadyPaid = String(order.payment_status || '').toLowerCase() === 'paid';

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

  // If already paid, we still may need to backfill lifecycle fields (deadline/SLA/status)
  // in cases where payment was set manually or a prior callback partially succeeded.
  const needsBackfill = (
  String(order.status || '').toLowerCase() !== 'paid' ||
  !order.deadline_at ||
  String(order.deadline_at).trim() === '' ||
  !order.sla_hours
);

  if (alreadyPaid && !needsBackfill) {
    logOrderEvent({
      orderId,
      label: 'Payment callback: already paid (ignored)',
      meta: JSON.stringify({ status, method, reference }),
      actorRole: 'system'
    });
    return res.json({ ok: true });
  }

  if (alreadyPaid && needsBackfill) {
    logOrderEvent({
      orderId,
      label: 'Payment callback: already paid (backfill lifecycle)',
      meta: JSON.stringify({ status, method, reference }),
      actorRole: 'system'
    });
  }

  const nowIso = new Date().toISOString();

  // 1) Persist payment facts (idempotent)
  db.prepare(
    `UPDATE orders
     SET payment_status = 'paid',
         paid_at = COALESCE(paid_at, ?),
         uploads_locked = 1,
         payment_method = COALESCE(?, payment_method, 'gateway'),
         payment_reference = COALESCE(?, payment_reference),
         payment_link = COALESCE(?, ?),
         updated_at = ?
     WHERE id = ?`
  ).run(
    nowIso,
    method || 'gateway',
    reference || null,
    payment_link || getOrCreatePaymentUrl(order),
    nowIso,
    orderId
  );

  // 2) Transition lifecycle via canonical boundary (sets status=PAID + SLA/deadline)
  try {
    // Default SLA type until you wire priority add-on into the payment payload.
    markCasePaid(orderId, 'standard_72h');
  } catch (e) {
    // If already PAID/ASSIGNED/etc, treat as idempotent success.
    logOrderEvent({
      orderId,
      label: 'Payment lifecycle transition skipped/failed (idempotent)',
      meta: JSON.stringify({ error: String(e && e.message ? e.message : e), status, method, reference }),
      actorRole: 'system'
    });
  }

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
  queueNotification({
    orderId,
    toUserId: order.patient_id,
    channel: 'whatsapp',
    template: 'payment_success_patient',
    status: 'queued',
    response: JSON.stringify({ order_id: orderId })
  });
  if (order.doctor_id) {
    queueNotification({
      orderId,
      toUserId: order.doctor_id,
      channel: 'internal',
      template: 'payment_success_doctor',
      status: 'queued'
    });
    queueNotification({
      orderId,
      toUserId: order.doctor_id,
      channel: 'whatsapp',
      template: 'payment_success_doctor',
      status: 'queued',
      response: JSON.stringify({ order_id: orderId })
    });
  }

  return res.json({ ok: true });
});


module.exports = router;
module.exports.getOrCreatePaymentUrl = getOrCreatePaymentUrl;
