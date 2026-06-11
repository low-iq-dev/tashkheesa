const express = require('express');
const crypto = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { logOrderEvent } = require('../audit');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { verifyPaymobHmac } = require('../paymob-hmac');
const { markCasePaid } = require('../case_lifecycle');
const { logErrorToDb } = require('../logger');
const { requireRole } = require('../middleware');
const paymobService = require('../services/paymob');
const { sendCriticalAlert } = require('../critical-alert');
const { getAddon, safeDualWrite } = require('../services/addons/registry');

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

// ───────────────────────────────────────────────────────────────────
// POST /payments/paymob/create-intention
//
// Patient-triggered checkout creation. Calls Paymob's Unified Intention
// API and returns a checkoutUrl for the browser to redirect to.
//
// Failure modes mapped to specific HTTP statuses so the Pay Now button
// JS can show the right message:
//
//   400 patient_profile_incomplete  → patient missing name/email/phone or
//                                      malformed format. Includes `fields`.
//   400 invalid_amount              → order has no locked_price > 0
//   400 unsupported_currency        → not EGP (test mode)
//   404 order_not_found             → not owned by patient or absent
//   404 patient_not_found           → req.user.id doesn't resolve to a row
//   409 already_paid                → no-op redirect to success page
//   502 paymob_unavailable          → Paymob API timeout / non-2xx
//   500 internal_error              → unknown
// ───────────────────────────────────────────────────────────────────
router.post('/paymob/create-intention', requireRole('patient'), async (req, res) => {
  try {
    const orderId = (req.body && req.body.orderId) ? String(req.body.orderId).trim() : '';
    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'orderId required' });
    }

    // orders.price is the canonical patient-charged total
    // (= base_price + urgency_uplift_amount per docs/PAYOUT_AND_URGENCY_POLICY.md).
    // orders.currency is the order-locked currency. Both exist in dev + prod;
    // the legacy locked_price/locked_currency columns added via
    // migrate_mobile_api.js are not used here to avoid env-specific drift.
    const order = await queryOne(
      `SELECT id, patient_id, payment_status, price, currency, paymob_intention_id
         FROM orders_active
        WHERE id = $1 AND patient_id = $2`,
      [orderId, req.user.id]
    );
    if (!order) {
      return res.status(404).json({ ok: false, error: 'order_not_found' });
    }
    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      return res.status(409).json({ ok: false, error: 'already_paid' });
    }

    const amount = Number(order.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    const currency = String(order.currency || 'EGP').toUpperCase();
    if (currency !== 'EGP') {
      // Test mode is EGP-only by design. International patients pay in EGP
      // via Paymob's currency-conversion (per existing P1-PUB copy).
      return res.status(400).json({ ok: false, error: 'unsupported_currency' });
    }

    // Pull patient PII for billing_data. The PII gate inside
    // paymobService.createIntention catches missing/malformed fields
    // before any network call.
    const patient = await queryOne(
      `SELECT id, name, email, phone, country, country_code FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!patient) {
      return res.status(404).json({ ok: false, error: 'patient_not_found' });
    }

    // Per-request redirection URL — derived from the request host so test
    // and prod work without a separate env var.
    const proto = req.secure ? 'https'
      : (req.headers['x-forwarded-proto'] || req.protocol || 'https');
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectionUrl = proto + '://' + host + '/portal/patient/payment-return';

    let result;
    try {
      result = await paymobService.createIntention({
        orderId: order.id,
        amountCents: Math.round(amount * 100),
        currency: currency,
        patient: {
          name: patient.name,
          email: patient.email,
          phone: patient.phone,
          country: patient.country_code || patient.country || 'EG'
        },
        redirectionUrl: redirectionUrl
      });
    } catch (err) {
      if (err && err.code === 'PATIENT_PROFILE_INCOMPLETE') {
        return res.status(400).json({
          ok: false,
          error: 'patient_profile_incomplete',
          fields: err.fields || []
        });
      }
      if (err && (err.code === 'PAYMOB_TIMEOUT' || err.code === 'PAYMOB_HTTP_ERROR' || err.code === 'PAYMOB_MALFORMED_RESPONSE')) {
        try {
          await execute(
            `INSERT INTO payment_events (id, order_id, event_type, payload_json, received_at)
             VALUES ($1, $2, 'intention_failed', $3, NOW())`,
            [
              'pe-' + crypto.randomUUID(),
              order.id,
              JSON.stringify({ code: err.code, message: err.message, status: err.status || null })
            ]
          );
        } catch (auditErr) {
          // Audit failure should never mask the original error.
          logErrorToDb(auditErr, { context: 'paymob_create_intention_audit' });
        }
        return res.status(502).json({ ok: false, error: 'paymob_unavailable' });
      }
      // Unknown error — let the catch below log it.
      throw err;
    }

    // Persist intention id + checkout URL so a returning visitor with the
    // same browser session reuses the existing intention instead of
    // burning a fresh one on every page load.
    await execute(
      `UPDATE orders SET paymob_intention_id = $1, payment_link = $2 WHERE id = $3`,
      [result.intentionId, result.checkoutUrl, order.id]
    );

    try {
      await execute(
        `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, received_at)
         VALUES ($1, $2, $3, 'intention_created', $4, NOW())`,
        [
          'pe-' + crypto.randomUUID(),
          order.id,
          result.intentionId,
          JSON.stringify({ amountCents: Math.round(amount * 100), currency: currency })
        ]
      );
    } catch (auditErr) {
      logErrorToDb(auditErr, { context: 'paymob_create_intention_audit_success' });
    }

    return res.json({ ok: true, checkoutUrl: result.checkoutUrl });
  } catch (err) {
    logErrorToDb(err, {
      context: 'paymob_create_intention',
      orderId: (req.body && req.body.orderId) || null,
      requestId: req.requestId
    });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});


router.post('/callback', async (req, res, next) => {
  try {
    // P1-PAY-1 commit 4: HMAC is the only auth path. The legacy
    // PAYMENT_WEBHOOK_SECRET shared-secret fallback was deleted in
    // this commit — only Paymob's signed payload is accepted now.
    const hmacSecret = process.env.PAYMOB_HMAC_SECRET;
    if (!hmacSecret) {
      return res.status(503).json({ ok: false, error: 'webhook_not_configured' });
    }

    const hmacResult = verifyPaymobHmac(req, hmacSecret);
    if (!hmacResult.ok) {
      console.warn('[callback] HMAC verification failed:', hmacResult.reason, 'ip:', req.ip);
      // Audit: record the failure in payment_events. order_id is unknown
      // here because we don't trust the unsigned payload; ip + reason +
      // user-agent give us enough to triage.
      try {
        await execute(
          `INSERT INTO payment_events (id, event_type, payload_json, hmac_verified, received_at)
           VALUES ($1, 'hmac_failure', $2, false, NOW())`,
          [
            'pe-' + crypto.randomUUID(),
            JSON.stringify({
              reason: hmacResult.reason,
              ip: req.ip || null,
              user_agent: req.get('user-agent') || null,
              request_id: req.requestId || null
            })
          ]
        );
      } catch (auditErr) {
        // Audit insert failure must never mask the 401 to the caller.
        logErrorToDb(auditErr, { context: 'payment_callback_hmac_failure_audit' });
      }
      // Page on-call via existing WhatsApp critical channel. Throttled
      // to 1/5min inside sendCriticalAlert, so a flood of probes won't
      // spam the admin phone.
      try {
        sendCriticalAlert(
          'Paymob webhook HMAC failure (' + hmacResult.reason + ') ' +
          'from ip=' + (req.ip || 'unknown') + ' req=' + (req.requestId || 'n/a')
        );
      } catch (_) {}
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Paymob wraps the transaction in body.obj; fall back to flat body for compatibility
    const txnBody = (req.body && req.body.obj) ? req.body.obj : (req.body || {});
    const { method, reference, payment_link } = txnBody;
    // Our order id arrives at obj.order.merchant_order_id (set via
    // special_reference at intention creation). Flat order_id kept for
    // compatibility with the legacy payload shape.
    const orderId = txnBody.order_id
      || (txnBody.order && txnBody.order.merchant_order_id)
      || txnBody.merchant_order_id
      || null;
    // Outcome: Paymob transaction webhooks signal via booleans
    // (success / pending), not a status string. Fall back to
    // txnBody.status for the legacy flat shape.
    const status = (txnBody.status != null) ? txnBody.status
      : (txnBody.pending === true) ? 'pending'
      : (txnBody.success === true) ? 'success'
      : (txnBody.success === false) ? 'failed'
      : null;
    // Paymob transaction id (signed by HMAC) — used for per-txn-id idempotency.
    const paymobTxnId = (txnBody && txnBody.id != null) ? String(txnBody.id) : null;
    const paymobIntentionId = (txnBody && txnBody.intention && txnBody.intention.id != null)
      ? String(txnBody.intention.id) : null;

    if (!orderId) {
      return res.status(400).json({ ok: false, error: 'order_id required' });
    }

    // P1-PAY-1: per-transaction-id idempotency.
    // payment_events.paymob_transaction_id is UNIQUE (WHERE NOT NULL).
    // We classify the event by Paymob's status field and INSERT one row;
    // ON CONFLICT DO NOTHING short-circuits replays of the same transaction.
    // The downstream per-order UPDATE-where-not-paid stays as a backup —
    // together they guarantee no double-marking of an order paid even if
    // two distinct transaction ids settle the same order.
    const _normalizedForEvent = normalizeStatus(status);
    const _eventType =
      _normalizedForEvent === 'paid'   ? 'payment_succeeded' :
      _normalizedForEvent === 'failed' ? 'payment_failed'    :
      _normalizedForEvent === 'cancelled' ? 'payment_failed' :
                                           'webhook_received';
    if (paymobTxnId) {
      // ON CONFLICT must repeat the partial-index predicate
      // (WHERE paymob_transaction_id IS NOT NULL) for Postgres to match
      // the index — that's the rule for partial unique indexes.
      const idemRes = await execute(
        `INSERT INTO payment_events
           (id, order_id, paymob_transaction_id, paymob_intention_id, event_type, payload_json, hmac_verified, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
         ON CONFLICT (paymob_transaction_id) WHERE paymob_transaction_id IS NOT NULL DO NOTHING`,
        [
          'pe-' + crypto.randomUUID(),
          orderId,
          paymobTxnId,
          paymobIntentionId,
          _eventType,
          JSON.stringify(req.body || {})
        ]
      );
      if (!idemRes || idemRes.rowCount === 0) {
        // Replay of an already-recorded transaction — no-op, return 200
        // so Paymob stops retrying. The original processing already ran.
        logOrderEvent({
          orderId,
          label: 'Payment callback: idempotent replay (already recorded)',
          meta: JSON.stringify({ paymob_transaction_id: paymobTxnId, status }),
          actorRole: 'system'
        });
        return res.json({ ok: true, idempotent: true });
      }
    }
    // (If paymobTxnId is missing — defensive fallback — we skip the
    // per-txn idempotency check and rely on the per-order UPDATE guard
    // below. Paymob's documented payload always includes obj.id.)

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
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

    // P1-NOTIF-4: notify the patient on payment failure so they can retry.
    // Only fires on `failed` (not `cancelled` — user-initiated cancel doesn't
    // need a "try again" prompt). Soft-fail wrapped: notification queueing
    // never blocks the webhook ack. Worker dedupe handles repeat webhook hits.
    if (normalized === 'failed' && order && order.patient_id) {
      try {
        const paymentUrl = await getOrCreatePaymentUrl(order);
        queueMultiChannelNotification({
          orderId,
          toUserId: order.patient_id,
          channels: ['email', 'whatsapp', 'internal'],
          template: 'payment_failed_patient',
          response: {
            order_id: orderId,
            caseReference: String(orderId).slice(0, 12).toUpperCase(),
            paymentUrl: paymentUrl,
            errorReason: (txnBody && (txnBody.error_message || txnBody.data_message)) || null
          }
        });
      } catch (err) {
        console.error('[payment-failed-notify] queue failed:', err && err.message ? err.message : err);
      }
    }

    return res.json({ ok: true });
  }

  // Atomic idempotency guard: only one webhook wins the race.
  // P1-PAY-1 commit 4 also writes paymob_transaction_id + hmac_verified_at
  // here so the orders row carries the WINNING transaction id (not the
  // first attempt). Per-txn-id idempotency lives upstream on
  // payment_events; this UPDATE is the per-order backstop.
  const nowIso = new Date().toISOString();
  const guard = await execute(
    `UPDATE orders
     SET payment_status = 'paid',
         paid_at = COALESCE(paid_at, $1),
         uploads_locked = true,
         payment_method = COALESCE(payment_method, $2, 'gateway'),
         payment_reference = COALESCE(payment_reference, $3),
         paymob_transaction_id = COALESCE(paymob_transaction_id, $6),
         hmac_verified_at = COALESCE(hmac_verified_at, $1::timestamptz),
         updated_at = $4
     WHERE id = $5 AND (payment_status IS NULL OR payment_status != 'paid')`,
    [nowIso, method || 'gateway', reference || null, nowIso, orderId, paymobTxnId]
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

  // 2) Transition lifecycle via canonical boundary (sets status=PAID + locks sla_hours; SLA starts on doctor acceptance).
  // markCasePaid reads orders.sla_hours / orders.urgency_tier directly — no slaType arg needed.
  try {
    await markCasePaid(orderId);
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

  // WhatsApp-via-OpenClaw rollout: urgency upgrade is a tier on the
  // main service (orders.urgency_tier), not a separately-paid add-on
  // — see the dead-code comment further down where the legacy sla_24hr
  // addon used to live. When the paid tier is 'urgent', fire a
  // dedicated confirmation so the patient sees an explicit "upgraded
  // to urgent" message in addition to the generic payment_success.
  if (String(order.urgency_tier || '').toLowerCase() === 'urgent') {
    queueMultiChannelNotification({
      orderId,
      toUserId: order.patient_id,
      channels: ['email', 'whatsapp', 'internal'],
      template: 'addon_purchased_urgency',
      response: {
        order_id: orderId,
        caseReference: String(orderId).slice(0, 12).toUpperCase(),
        slaHours: order.sla_hours || null
      }
    }).catch(function(err) {
      console.error('[notify] addon_purchased_urgency queue failed:', err && err.message);
    });
  }

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

  // === AUTO-CREATE APPOINTMENT IF VIDEO CONSULTATION ADD-ON SELECTED ===
  const addonVideoConsultation = req.query?.addon_video_consultation || req.body?.addon_video_consultation;

  if (addonVideoConsultation === '1' || addonVideoConsultation === 1) {
    // Theme 9 Sub-issue C: kill-switch gate. If the video flag is off,
    // skip the addon work entirely — the case payment itself still
    // proceeds. The wizard EJS should also hide the checkbox so the
    // patient never sees the option (separate edit).
    const { isVideoEnabled } = require('../video_helpers');
    if (!isVideoEnabled()) {
      console.error('[payments] video_consultation addon requested but VIDEO_CONSULTATION_ENABLED=false');
      logOrderEvent({
        orderId,
        label: 'video_consultation_addon_skipped_feature_disabled',
        meta: '{}',
        actorRole: 'system'
      });
    } else {
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

      // ---- V2 dual-write (gated by ADDON_SYSTEM_V2) ----
      await safeDualWrite('video_consult', 'onPurchase', orderId, async () => {
        const svc = getAddon('video_consult');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'video_consult'`);
        if (!svc || !addonService) throw new Error('video_consult addon not registered/seeded');
        const currency = order.locked_currency || 'EGP';
        return svc.onPurchase({ order, addonService, currency });
      });

      // WhatsApp-via-OpenClaw rollout: confirmation notification for
      // the video consultation add-on. Fires after V2 dual-write so
      // appointment data (if any) is already persisted. Fire-and-forget —
      // a failed notification must not block the payment callback.
      queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'addon_purchased_video',
        response: {
          order_id: orderId,
          caseReference: String(orderId).slice(0, 12).toUpperCase()
        }
      }).catch(function(err) {
        console.error('[notify] addon_purchased_video queue failed:', err && err.message);
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
    }  // end !isVideoEnabled() else branch (Theme 9 Sub-issue C)
  }

  // The sla_24hr addon branch that used to live here was DEAD CODE after
  // migration 019b removed the addon — urgency / faster-turnaround is now
  // expressed via urgency tiers on main-service pricing, not via an addon.
  // See docs/architecture/addon_service_abstraction.md §0 and §1.2.
  // Removed as part of Phase 3 dual-write wiring.

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

      // ---- V2 dual-write (gated by ADDON_SYSTEM_V2) ----
      await safeDualWrite('prescription', 'onPurchase', orderId, async () => {
        const svc = getAddon('prescription');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'prescription'`);
        if (!svc || !addonService) throw new Error('prescription addon not registered/seeded');
        return svc.onPurchase({ order, addonService, currency: rxCurrency });
      });

      // Confirmation notification for the prescription add-on.
      queueMultiChannelNotification({
        orderId,
        toUserId: order.patient_id,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'addon_purchased_prescription',
        response: {
          order_id: orderId,
          caseReference: String(orderId).slice(0, 12).toUpperCase()
        }
      }).catch(function(err) {
        console.error('[notify] addon_purchased_prescription queue failed:', err && err.message);
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
