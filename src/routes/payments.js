const express = require('express');
const { db } = require('../db');
const { logOrderEvent } = require('../audit');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { markCasePaid } = require('../case_lifecycle');
const { logErrorToDb } = require('../logger');

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

router.post('/callback', (req, res, next) => {
  try {
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

  // 2) Transition lifecycle via canonical boundary (sets status=PAID + locks sla_hours; SLA starts on doctor acceptance)
  try {
    // Default SLA type until you wire priority add-on into the payment payload.
const hours = Number(order?.sla_hours || 72);
const slaType = hours === 24 ? 'priority_24h' : 'standard_72h';
markCasePaid(orderId, slaType);
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

  queueMultiChannelNotification({
    orderId,
    toUserId: order.patient_id,
    channels: ['email', 'whatsapp', 'internal'],
    template: 'payment_success_patient',
    response: {
      order_id: orderId,
      caseReference: String(orderId).slice(0, 12).toUpperCase(),
    },
  });
  if (order.doctor_id) {
    queueMultiChannelNotification({
      orderId,
      toUserId: order.doctor_id,
      channels: ['whatsapp', 'internal'],
      template: 'payment_success_doctor',
      response: { order_id: orderId },
    });
  }

  // === AUTO-CREATE APPOINTMENT IF VIDEO CONSULTATION ADD-ON SELECTED ===
  const addonVideoConsultation = req.query?.addon_video_consultation || req.body?.addon_video_consultation;

  if (addonVideoConsultation === '1' || addonVideoConsultation === 1) {
    try {
      const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
      const videoPrice = service?.video_consultation_price || 0;

      db.prepare(`
        UPDATE orders
        SET video_consultation_selected = 1,
            video_consultation_price = ?,
            addons_json = ?
        WHERE id = ?
      `).run(videoPrice, JSON.stringify({ video_consultation: true }), orderId);

      logOrderEvent({
        orderId,
        label: 'Video consultation add-on selected',
        meta: JSON.stringify({ price: videoPrice }),
        actorRole: 'system'
      });
    } catch (e) {
      console.error('Error processing video consultation add-on:', e);
      logOrderEvent({
        orderId,
        label: 'Video consultation add-on processing failed',
        meta: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
        actorRole: 'system'
      });
    }
  }

  // === 24-HOUR SLA ADD-ON ===
  const addonSla24hr = req.query?.addon_sla_24hr || req.body?.addon_sla_24hr;

  if (addonSla24hr === '1' || addonSla24hr === 1) {
    try {
      const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
      const slaPrice = service?.sla_24hr_price || 100;

      // Set 24h SLA: update sla_hours to 24, set deadline, store add-on
      const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE orders
        SET sla_24hr_selected = 1,
            sla_24hr_price = ?,
            sla_hours = 24,
            sla_24hr_deadline = ?,
            addons_json = json_patch(COALESCE(addons_json, '{}'), ?)
        WHERE id = ?
      `).run(slaPrice, deadline, JSON.stringify({ sla_24hr: true }), orderId);

      logOrderEvent({
        orderId,
        label: '24h SLA add-on activated',
        meta: JSON.stringify({ price: slaPrice, deadline }),
        actorRole: 'system'
      });

      // Notify patient of 24h SLA activation
      queueNotification({
        orderId,
        toUserId: order.patient_id,
        channel: 'internal',
        template: 'sla_24hr_activated',
        status: 'queued',
        response: JSON.stringify({ deadline })
      });

      // Notify doctor if assigned
      if (order.doctor_id) {
        queueNotification({
          orderId,
          toUserId: order.doctor_id,
          channel: 'internal',
          template: 'sla_24hr_activated_doctor',
          status: 'queued',
          response: JSON.stringify({ deadline })
        });
      }
    } catch (e) {
      console.error('Error processing 24h SLA add-on:', e);
      logOrderEvent({
        orderId,
        label: '24h SLA add-on processing failed',
        meta: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
        actorRole: 'system'
      });
    }
  }

  // === PRESCRIPTION SERVICE ADD-ON ===
  const addonPrescription = req.query?.addon_prescription || req.body?.addon_prescription;

  if (addonPrescription === '1' || addonPrescription === 1) {
    try {
      const rxCurrency = order.locked_currency || 'EGP';
      const rxRow = db.prepare(
        "SELECT tashkheesa_price FROM service_regional_prices WHERE service_id = 'addon_prescription' AND currency = ? LIMIT 1"
      ).get(rxCurrency);
      const rxPrice = rxRow ? rxRow.tashkheesa_price : 350;

      db.prepare(`
        UPDATE orders
        SET addons_json = json_patch(COALESCE(addons_json, '{}'), ?)
        WHERE id = ?
      `).run(JSON.stringify({ prescription: true, prescription_price: rxPrice }), orderId);

      logOrderEvent({
        orderId,
        label: 'Prescription add-on selected',
        meta: JSON.stringify({ price: rxPrice, currency: rxCurrency }),
        actorRole: 'system'
      });
    } catch (e) {
      console.error('Error processing prescription add-on:', e);
      logOrderEvent({
        orderId,
        label: 'Prescription add-on processing failed',
        meta: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
        actorRole: 'system'
      });
    }
  }

  return res.json({ ok: true });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, context: 'payment_callback' });
    return next(err);
  }
});


module.exports = router;
module.exports.getOrCreatePaymentUrl = getOrCreatePaymentUrl;
