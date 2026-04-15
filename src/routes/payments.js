const express = require('express');
const crypto = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { logOrderEvent } = require('../audit');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { verifyPaymobHmac } = require('../paymob-hmac');
const { markCasePaid } = require('../case_lifecycle');
const { logErrorToDb } = require('../logger');
var { enqueueAutoAssign } = require('../job_queue');
var { broadcastOrderToSpecialty } = require('../notify/broadcast');

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
async function getOrCreatePaymentUrl(order) {
  if (order && order.payment_link && String(order.payment_link).trim() !== '') {
    return order.payment_link;
  }
  // Synthesize canonical hosted payment URL
  const url = `/portal/patient/pay/${order.id}`;
  // Persist the generated URL if not already present
  await execute('UPDATE orders SET payment_link = $1 WHERE id = $2', [url, order.id]);
  return url;
}

router.post('/callback', async (req, res, next) => {
  try {
    const hmacSecret = process.env.PAYMOB_HMAC_SECRET;
    const legacySecret = process.env.PAYMENT_WEBHOOK_SECRET;

    if (hmacSecret) {
      // Primary: full Paymob HMAC-SHA512 verification
      const hmacResult = verifyPaymobHmac(req, hmacSecret);
      if (!hmacResult.ok) {
        console.warn('[callback] HMAC verification failed:', hmacResult.reason, 'ip:', req.ip);
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    } else if (legacySecret) {
      // Fallback: legacy shared-secret header (timing-safe comparison)
      const providedSecret = req.headers['x-webhook-secret'] || req.query.secret || '';
      const a = Buffer.from(legacySecret);
      const b = Buffer.from(providedSecret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    } else {
      return res.status(503).json({ ok: false, error: 'webhook_not_configured' });
    }

    // Paymob wraps the transaction in body.obj; fall back to flat body for compatibility
    const txnBody = (req.body && req.body.obj) ? req.body.obj : (req.body || {});
    const { order_id: orderId, status, method, reference, payment_link } = txnBody;
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'order_id required' });
  }

  const order = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
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

  // Atomic idempotency guard: only one webhook wins the race
  const nowIso = new Date().toISOString();
  const guard = await execute(
    `UPDATE orders
     SET payment_status = 'paid',
         paid_at = COALESCE(paid_at, $1),
         uploads_locked = true,
         payment_method = COALESCE(payment_method, $2, 'gateway'),
         payment_reference = COALESCE(payment_reference, $3),
         updated_at = $4
     WHERE id = $5 AND (payment_status IS NULL OR payment_status != 'paid')`,
    [nowIso, method || 'gateway', reference || null, nowIso, orderId]
  );

  if (!guard || guard.rowCount === 0) {
    // Already processed by a concurrent webhook — check if backfill needed
    const needsBackfill = (
      String(order.status || '').toLowerCase() !== 'paid' ||
      !order.deadline_at ||
      !order.sla_hours
    );
    if (!needsBackfill) {
      logOrderEvent({
        orderId,
        label: 'Payment callback: already paid (ignored)',
        meta: JSON.stringify({ status, method, reference }),
        actorRole: 'system'
      });
      return res.json({ ok: true });
    }
    logOrderEvent({
      orderId,
      label: 'Payment callback: already paid (backfill lifecycle)',
      meta: JSON.stringify({ status, method, reference }),
      actorRole: 'system'
    });
  }

  // Backfill payment_link if missing
  if (!order.payment_link) {
    const url = await getOrCreatePaymentUrl(order);
    await execute('UPDATE orders SET payment_link = $1 WHERE id = $2 AND payment_link IS NULL', [url, orderId]);
  }

  // 2) Transition lifecycle via canonical boundary (sets status=PAID + locks sla_hours; SLA starts on doctor acceptance)
  try {
    const hours = Number(order?.sla_hours || 72);
    const slaType = hours === 24 ? 'priority_24h' : 'standard_72h';
    await markCasePaid(orderId, slaType);
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

  // Mark referral reward as granted now that payment is confirmed
  try {
    await execute(
      'UPDATE referral_redemptions SET reward_granted = true WHERE order_id = $1 AND reward_granted = false',
      [orderId]
    );
  } catch (_) {}

  // === AUTO-ASSIGN DOCTOR (queued via pg-boss — checks enabled flag inside handler) ===
  if (!order.doctor_id) {
    enqueueAutoAssign(orderId).catch(function(err) {
      console.error('[auto-assign] enqueue failed:', err.message);
    });
  }

  // === BROADCAST TO SPECIALTY DOCTORS ===
  if (!order.doctor_id) {
    broadcastOrderToSpecialty(orderId).catch(function(err) {
      console.error('[broadcast] post-payment broadcast failed:', err.message);
    });
  }

  // === AUTO-CREATE APPOINTMENT IF VIDEO CONSULTATION ADD-ON SELECTED ===
  const addonVideoConsultation = req.query?.addon_video_consultation || req.body?.addon_video_consultation;

  if (addonVideoConsultation === '1' || addonVideoConsultation === 1) {
    try {
      const service = await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id]);
      const videoPrice = service?.video_consultation_price || 0;

      await execute(`
        UPDATE orders
        SET video_consultation_selected = true,
            video_consultation_price = $1,
            addons_json = $2
        WHERE id = $3
      `, [videoPrice, JSON.stringify({ video_consultation: true }), orderId]);

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
      const service = await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id]);
      const slaPrice = service?.sla_24hr_price || 100;

      // Set 24h SLA: update sla_hours to 24, set deadline, store add-on
      const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await execute(`
        UPDATE orders
        SET sla_24hr_selected = true,
            sla_24hr_price = $1,
            sla_hours = 24,
            sla_24hr_deadline = $2,
            addons_json = COALESCE(addons_json, '{}')::jsonb || $3::jsonb
        WHERE id = $4
      `, [slaPrice, deadline, JSON.stringify({ sla_24hr: true }), orderId]);

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
      const rxRow = await queryOne(
        "SELECT tashkheesa_price FROM service_regional_prices WHERE service_id = 'addon_prescription' AND currency = $1 LIMIT 1",
        [rxCurrency]
      );
      const rxPrice = rxRow ? rxRow.tashkheesa_price : 350;

      await execute(`
        UPDATE orders
        SET addons_json = COALESCE(addons_json, '{}')::jsonb || $1::jsonb
        WHERE id = $2
      `, [JSON.stringify({ prescription: true, prescription_price: rxPrice }), orderId]);

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
