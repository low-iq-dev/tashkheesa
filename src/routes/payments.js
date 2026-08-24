const express = require('express');
const crypto = require('crypto');
// AUDIT-2026-08-22 (R3): `pool` is needed for the per-transaction advisory
// lock that serialises this webhook — see the lock block in POST /callback.
const { pool, queryOne, queryAll, execute } = require('../pg');
const { logOrderEvent } = require('../audit');
const { queueNotification, queueMultiChannelNotification, notifyAdmins } = require('../notify');
const { verifyPaymobHmac } = require('../paymob-hmac');
const { markCasePaid } = require('../case_lifecycle');
const { logErrorToDb } = require('../logger');
const { requireRole } = require('../middleware');
const paymobService = require('../services/paymob');
const { sendCriticalAlert } = require('../critical-alert');
const { owedCentsForOrder } = require('../services/order_pricing');

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

// Resolve a per-currency add-on price from a JSON price map.
//
// 2026-08-24: moved to services/addon_settlement.js and re-exported here, so
// the webhook below and the two mark-paid handlers — which now settle add-ons
// through the same module — cannot drift apart on how a price is read.
const { settleAddonsForPaidOrder, resolveAddonJsonPrice } = require('../services/addon_settlement');

// ── FIX 11: per-attempt-unique Paymob special_reference ────────────────────
//
// services/paymob.js sets `special_reference: args.orderId` and Paymob REQUIRES
// special_reference to be unique per merchant. Every re-mint for the same order
// (patient reloads the pay page, referral discount nulls the intention, the
// wizard re-prices) therefore got a non-2xx from Paymob and the order became
// permanently unpayable — a 502 the patient can never get past.
//
// Paymob echoes special_reference back as obj.order.merchant_order_id, which is
// exactly what /callback keys the order lookup on, so the suffix has to be
// strippable. '--' is the separator because order ids are randomUUID()
// (routes/patient.js:1734) — 36 chars of lowercase hex and SINGLE dashes — so a
// double dash can never occur inside a real order id.
const ATTEMPT_SUFFIX_SEP = '--';

function buildSpecialReference(orderId) {
  return String(orderId) + ATTEMPT_SUFFIX_SEP +
    Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function orderIdFromReference(reference) {
  if (reference == null) return null;
  const s = String(reference);
  const i = s.indexOf(ATTEMPT_SUFFIX_SEP);
  // i > 0 — never return an empty order id from a reference that merely starts
  // with the separator.
  return (i > 0) ? s.slice(0, i) : s;
}

// Reuse window for an already-minted Paymob intention. Purpose is to stop
// burning a fresh intention on every page load / reload, which happens within
// seconds-to-minutes; beyond the window we re-mint rather than risk handing the
// patient a checkout whose client_secret Paymob has since expired (a stale
// reuse is a dead end the patient cannot escape by reloading).
const INTENTION_REUSE_MINUTES = (function () {
  const n = parseInt(process.env.PAYMOB_INTENTION_REUSE_MINUTES || '', 10);
  return (Number.isInteger(n) && n > 0 && n <= 720) ? n : 30;
})();

const PAYMOB_CHECKOUT_PREFIX = 'https://accept.paymob.com/unifiedcheckout/';

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
      `SELECT id, patient_id, payment_status, price, currency, paymob_intention_id,
              payment_link, service_id
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

    // ── B6 (launch audit): ADD-ONS ARE CHARGED ────────────────────────────
    // The intention amount MUST include selected add-ons, priced from the DB
    // (never the client). Persist the selection on the order BEFORE creating
    // the intention so the webhook fulfills — and verifies the amount against —
    // exactly what was charged. An unknown/unpriced/disabled add-on defaults to
    // not-selected (client can never inflate or fabricate a line).
    const reqAddons = (req.body && req.body.addons && typeof req.body.addons === 'object') ? req.body.addons : {};
    const wantVideo = !!reqAddons.video_consultation;
    const wantRx = !!reqAddons.prescription;
    let videoPrice = 0;
    let rxPrice = 0;
    // 2026-08-24 — ONE catalogue: addon_services, via resolveAddonPrice.
    //
    // There were three, and they disagreed. Video was priced from
    // services.video_consultation_prices_json (populated on 0 of 168 rows).
    // Prescription was priced from service_regional_prices('addon_prescription')
    // — a row that does not exist in ANY of the nine currencies, so the lookup
    // returned 0, `selRx = wantRx && rxPrice > 0` was false, and the add-on was
    // silently dropped from every order. Meanwhile the doctor's commission was
    // computed from a third catalogue, addon_services, at 200 / 400 EGP.
    //
    // So both add-ons were unsellable for the same reason, and had either been
    // sellable, the patient would have been charged from one table while the
    // doctor was paid a percentage of another. That is structurally negative
    // margin the moment the two drift.
    //
    // addon_services IS the V2 registry: it holds the price, the per-currency
    // overrides and the commission percentage in one row, and it is already
    // what onPurchase snapshots. Reading it here makes the charged price and
    // the commission basis the same number by construction rather than by
    // coincidence. resolveAddonPrice falls back to base_price_egp for a
    // currency with no override, and returns null for an inactive add-on.
    if (wantVideo || wantRx) {
      const { resolveAddonPrice } = require('../services/addons/pricing');
      if (wantVideo) {
        const { isVideoEnabled } = require('../video_helpers');
        if (isVideoEnabled()) {
          const resolved = await resolveAddonPrice('video_consult', currency);
          videoPrice = resolved ? Number(resolved.amount) || 0 : 0;
        }
      }
      if (wantRx) {
        // The coming-soon hold is enforced here too, not only in the UI: a
        // crafted POST must not be able to add a line the product cannot
        // deliver. See src/services/prescriptions_flag.js.
        const { prescriptionsComingSoon } = require('../services/prescriptions_flag');
        if (!prescriptionsComingSoon()) {
          const resolved = await resolveAddonPrice('prescription', currency);
          rxPrice = resolved ? Number(resolved.amount) || 0 : 0;
        }
      }
    }
    const selVideo = wantVideo && videoPrice > 0;
    const selRx = wantRx && rxPrice > 0;
    const addonsJson = JSON.stringify({
      video_consultation: selVideo,
      video_consultation_price: selVideo ? videoPrice : 0,
      prescription: selRx,
      prescription_price: selRx ? rxPrice : 0
    });
    await execute(
      `UPDATE orders
         SET addons_json = $1, video_consultation_selected = $2, video_consultation_price = $3
       WHERE id = $4`,
      [addonsJson, selVideo, selVideo ? videoPrice : 0, order.id]
    );
    // Charge = base + selected add-ons, via the SAME helper the webhook uses to
    // verify — so intention and verification can never drift (audit B5/B6).
    const amountCents = owedCentsForOrder({ price: order.price, addons_json: addonsJson });

    // ── FIX 11a: REUSE the stored intention when nothing about the charge
    // changed. The comment below the createIntention call has always claimed
    // this happened; it never did — line 88 selected paymob_intention_id and
    // then ignored it, so every click on Pay Now minted a brand-new intention.
    //
    // Reuse is safe because every path that changes the price NULLs
    // paymob_intention_id: routes/referrals.js (referral discount) and
    // routes/patient.js:2064 / :2157 (wizard re-price). We additionally require
    // the recomputed amount to match the amount recorded on the
    // 'intention_created' payment_event, so an add-on selection change in THIS
    // request also forces a fresh mint.
    if (order.paymob_intention_id &&
        typeof order.payment_link === 'string' &&
        order.payment_link.startsWith(PAYMOB_CHECKOUT_PREFIX)) {
      try {
        const prior = await queryOne(
          `SELECT payload_json, received_at
             FROM payment_events
            WHERE order_id = $1
              AND event_type = 'intention_created'
              AND paymob_intention_id = $2
              AND received_at > NOW() - make_interval(mins => $3::int)
            ORDER BY received_at DESC
            LIMIT 1`,
          [order.id, String(order.paymob_intention_id), INTENTION_REUSE_MINUTES]
        );
        const priorAmount = prior && prior.payload_json
          ? Number(prior.payload_json.amountCents)
          : NaN;
        const priorCurrency = prior && prior.payload_json
          ? String(prior.payload_json.currency || '').toUpperCase()
          : '';
        if (Number.isFinite(priorAmount) && priorAmount === amountCents && priorCurrency === currency) {
          return res.json({ ok: true, checkoutUrl: order.payment_link, reused: true });
        }
      } catch (reuseErr) {
        // Never let the reuse optimisation block a payment — fall through and
        // mint a fresh intention (which FIX 11b makes safe to do repeatedly).
        logErrorToDb(reuseErr, { context: 'paymob_create_intention_reuse_check', orderId: order.id });
      }
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

    // ── FIX 11b: a genuine re-mint must never be rejected by Paymob. ─────────
    //
    // services/paymob.js uses `args.orderId` verbatim as BOTH `special_reference`
    // and `extras.merchant_order_id`, and Paymob enforces uniqueness on
    // special_reference per merchant. Passing a per-attempt-unique reference is
    // therefore the whole fix, and it is transport-safe because /callback below
    // strips the '--<attempt>' suffix back to the canonical order id before the
    // order lookup (see orderIdFromReference) — whichever of the two fields
    // Paymob echoes into obj.order.merchant_order_id.
    //
    // NOTE for the services/paymob.js owner: the clean shape is a dedicated
    // optional `specialReference` arg defaulting to `orderId`. See the handoff
    // notes; this call site works either way.
    const specialReference = buildSpecialReference(order.id);

    let result;
    try {
      result = await paymobService.createIntention({
        orderId: specialReference,
        amountCents: amountCents,
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
              JSON.stringify({
                code: err.code, message: err.message, status: err.status || null,
                special_reference: specialReference
              })
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

    // Persist intention id + checkout URL. FIX 11a above is what actually
    // makes the "returning visitor reuses the existing intention" claim true;
    // this write is what it reads back.
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
          // amountCents + currency are read back by the FIX 11a reuse check —
          // reuse only happens when BOTH still match the recomputed charge.
          JSON.stringify({
            amountCents: amountCents,
            currency: currency,
            special_reference: specialReference
          })
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
  // AUDIT-2026-08-22 (R3, P0): declared OUTSIDE the try so the finally at the
  // bottom of this handler can release the advisory lock on EVERY exit path,
  // including the `return next(err)` in the catch. See the lock block below.
  let _txnLockClient = null;
  let _txnLockKey = null;
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
        // FIX 4: sendCriticalAlert throttles PER alertKey and defaults to
        // 'generic'. This site and the intention-mismatch site below both
        // omitted the key, so they shared one 5-minute bucket — an HMAC probe
        // flood (trivial to generate, unauthenticated) silenced the
        // intention-mismatch page, which is the higher-severity signal of
        // the two. Distinct keys, distinct buckets.
        sendCriticalAlert(
          'Paymob webhook HMAC failure (' + hmacResult.reason + ') ' +
          'from ip=' + (req.ip || 'unknown') + ' req=' + (req.requestId || 'n/a'),
          'paymob_hmac_failure'
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
    const merchantOrderRef = txnBody.order_id
      || (txnBody.order && txnBody.order.merchant_order_id)
      || txnBody.merchant_order_id
      || null;
    // FIX 11: special_reference (which is what Paymob echoes back as
    // merchant_order_id) is now uniquified per intention attempt — Paymob
    // requires it to be unique per merchant, so re-using the bare order id made
    // the SECOND intention for an order fail and left that order unpayable
    // forever. orderIdFromReference strips the '--<attempt>' suffix back to the
    // canonical order id. Order ids are randomUUID() (see routes/patient.js),
    // which can never contain a double dash, so the split is unambiguous and
    // this is a no-op for every reference minted before this change.
    const orderId = orderIdFromReference(merchantOrderRef);
    // ── AUDIT-P0-6: the outcome is derived from HMAC-SIGNED FIELDS ONLY ──
    //
    // This used to prefer `txnBody.status`, which is NOT one of the 19 fields
    // in the HMAC subject (see paymob-hmac.js HMAC_FIELDS — only `success`,
    // `pending` and `error_occured` are signed). An attacker who captured any
    // valid (hmac, 19 signed fields) pair — trivially available from their own
    // Paymob redirect after deliberately failing a card — could re-POST it here
    // with `status: "success"` appended. The HMAC still verified, because the
    // appended field is not hashed, and the signed `success: false` was
    // silently overridden. Result: an order marked paid with no money moved.
    //
    // `pending` is checked before `success` because Paymob sends
    // success=false + pending=true on an in-flight 3DS transaction; treating
    // that as `failed` would fire a spurious "payment failed" notification.
    //
    // ── AUDIT 2026-08-17 (FIX 2): honour the SIGNED refund / void flags ──────
    //
    // `is_refunded`, `is_voided` and `has_parent_transaction` are all inside
    // the HMAC-signed 19-field set (paymob-hmac.js HMAC_FIELDS:22-43) and
    // NEITHER callback read them. Paymob delivers a void or a refund as its own
    // transaction: `success: true`, a FRESH `obj.id`, and the same
    // `amount_cents`. That combination cleared the amount check (same amount,
    // opposite direction) AND the per-transaction-id unique index (new id), so
    // "we gave the money back" was processed as "the patient just paid".
    // ── AUDIT 2026-08-17 (regression F4): has_parent_transaction does NOT
    // gate the paid path.
    //
    // The first cut treated it as a third refund signal. It is not one. Paymob
    // sets has_parent_transaction on ANY transaction derived from an earlier
    // one, which includes the two cases that are ordinary money coming IN:
    // the CAPTURE of a prior authorisation, and a token / recurring charge off
    // a saved card. And it short-circuited BEFORE the B5 amount check, so such
    // a transaction was refused outright — patient charged, order left unpaid,
    // no amount-mismatch record, and (with CRITICAL_ALERT_TEMPLATE_NAME unset)
    // no alert either. That is strictly worse than the bug it replaced.
    //
    // is_refunded / is_voided are the actual "money went back" flags and are
    // both HMAC-signed. has_parent_transaction stays as an AUDIT signal only:
    // recorded on every event payload, and paged on below when it appears on a
    // transaction we are about to mark paid — but it never blocks.
    const isRefundOrVoid = (txnBody.is_refunded === true)
      || (txnBody.is_voided === true);
    const hasParentTxn = (txnBody.has_parent_transaction === true);

    const status =
        (txnBody.pending === true) ? 'pending'
      : (txnBody.error_occured === true) ? 'failed'
      : (txnBody.success === true
          && txnBody.is_refunded !== true
          && txnBody.is_voided !== true) ? 'success'
      : (txnBody.success === false) ? 'failed'
      : null;
    // Paymob transaction id (signed by HMAC) — used for per-txn-id idempotency.
    const paymobTxnId = (txnBody && txnBody.id != null) ? String(txnBody.id) : null;
    const paymobIntentionId = (txnBody && txnBody.intention && txnBody.intention.id != null)
      ? String(txnBody.intention.id) : null;
    // Paymob's OWN order id — obj.order.id. This one IS in the signed field set
    // ('order' in HMAC_FIELDS, resolved to obj.order.id by buildHmacString),
    // unlike obj.order.merchant_order_id (unsigned, and the thing we key the
    // order lookup on) and obj.intention.id (unsigned). buildHmacString
    // computed it and then threw it away; we keep it for audit + binding.
    const paymobOrderId = (txnBody && txnBody.order && txnBody.order.id != null)
      ? String(txnBody.order.id) : null;

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
      isRefundOrVoid                   ? 'refund_or_void_received' :
      _normalizedForEvent === 'paid'   ? 'payment_succeeded' :
      _normalizedForEvent === 'failed' ? 'payment_failed'    :
      _normalizedForEvent === 'cancelled' ? 'payment_failed' :
                                           'webhook_received';
    // ── AUDIT-2026-08-22 (M6): the claim is PROVISIONAL until the outcome is
    //    actually applied ──────────────────────────────────────────────────
    //
    // This row was inserted with its FINAL event_type before the order lookup
    // (below), the intention binding, the amount check and markCasePaid. Every
    // one of those can throw — and a throw reaches the handler's outer catch,
    // which calls next(err) and answers 500. Paymob then retries, the retry
    // hits ON CONFLICT DO NOTHING, and the retry was treated as a replay of a
    // transaction that had never been processed at all. Net effect: the patient
    // is charged, the order NEVER becomes paid, nothing assigns, no SLA clock
    // starts, and the only trace is an "idempotent replay" timeline row saying
    // the work was already done. A transient DB blip on the money path
    // permanently stranded the payment.
    //
    // Fix: claim the transaction id under a PROVISIONAL event_type and rewrite
    // it to the real one only once the outcome has been applied (finalizeClaim
    // below, called at every point this handler answers with a decision). The
    // unique index still does the real work — a second delivery of a FINALISED
    // transaction is still a no-op, which is the replay protection we must not
    // lose. What changes is the meaning of a conflict on a row that is still
    // provisional: that is an abandoned attempt, not a completed one, and it
    // must be re-processed rather than swallowed.
    //
    // A provisional row is the RAW MATERIAL for an operational signal:
    //   SELECT * FROM payment_events WHERE event_type = 'webhook_processing';
    // is exactly the list of deliveries that died mid-flight.
    //
    // AUDIT-2026-08-22 (R7, P1): it is NOT a signal anyone currently sees, and
    // the original wording claimed otherwise. Nothing reads this event_type —
    // routes/ops.js:598 deliberately restricts lastWebhookAt to
    // ('webhook_received','payment_succeeded','payment_failed'), and no other
    // reader mentions it. HAND-OFF (ops owner): add a webhook_processing count
    // + oldest-age tile to /ops; a row older than a few minutes is a webhook
    // that died holding the claim. Until that exists, the two paths that leave
    // a row provisional AND end the request (order-not-found below, and the
    // outer catch) are the ones that page on-call directly.
    const PROVISIONAL_EVENT_TYPE = 'webhook_processing';
    // Long enough that two near-simultaneous deliveries of the same
    // transaction cannot both process it (the second is told to retry), short
    // enough that a crashed attempt is retried inside Paymob's retry schedule.
    const CLAIM_TAKEOVER_SECONDS = 60;
    let _claimOwned = false;

    // ── AUDIT-2026-08-22 (R3, P0): REAL serialisation, held for the whole
    //    handler ────────────────────────────────────────────────────────────
    //
    // M6 replaced an unconditional `ON CONFLICT DO NOTHING` — which made
    // concurrent processing of one transaction STRUCTURALLY impossible — with a
    // 60-second, heartbeat-free takeover window. A slow-but-alive attempt is
    // indistinguishable from a dead one under that rule, and 60s is reachable
    // here: markCasePaid does assignment + broadcast + notifications,
    // getOrCreatePaymentUrl (:1125) makes an outbound HTTPS call, and the pool
    // is capped at ~12 against Supabase Free. Sequence that resulted:
    //
    //   A claims at t=0 and is slow. Paymob retries. B at t≥61s takes the claim
    //   and runs the handler CONCURRENTLY with A. A has already committed
    //   payment_status='paid' but not finished markCasePaid, so B's read sees
    //   status != 'paid' and no deadline_at → needsBackfill is true (:1090) → B
    //   does not short-circuit, calls markCasePaid again and re-runs the whole
    //   add-on fulfilment block: safeDualWrite('video_consult','onPurchase'),
    //   the purchase notifications, the addons_json merge.
    //
    // The lock below restores the lost property without giving back M6's: only
    // one delivery of a given transaction id can be inside this handler at a
    // time, and a transient failure still cannot strand the payment (the claim
    // row stays provisional and a retry re-processes it).
    //
    // WHY pg_try_advisory_XACT_lock ON A DEDICATED CLIENT, AND NOT
    // pg_try_advisory_lock: DATABASE_URL is the Supabase TRANSACTION-mode
    // pooler (port 6543), where a node-pg client is NOT bound to a backend. A
    // session-scoped advisory lock is taken on backend A and unlocked on
    // whichever backend is free — that is the exact bug AUDIT-WATCHDOG-LOCK-1
    // found in services/worker_watchdog.js, where the leaked lock silently
    // disabled every ops push. An xact lock inside an explicit BEGIN is
    // released by the server at COMMIT/ROLLBACK and cannot be released on the
    // wrong backend, and the pooler pins one backend for the duration of a
    // transaction. Only the lock lives in this transaction — every query in
    // this handler still runs on the ordinary pool, so nothing below is holding
    // rows or reading a stale snapshot.
    //
    // NOT acquired (`false`) means a sibling delivery is genuinely mid-flight:
    // answer 503 and let Paymob redeliver, exactly as for the in-flight claim
    // below. An ERROR acquiring it (pool exhausted, connect timeout) also
    // answers 503 rather than proceeding unserialised — on the money path,
    // "try again" beats "run the non-idempotent block twice".
    //
    // COST, stated so it is not a surprise: one pooled client (of PG_POOL_MAX,
    // default 10) is held idle-in-transaction for the length of the handler.
    // Paymob webhook volume on this platform is a handful per minute, so the
    // budget is not close; and if it ever were, the failure mode is a
    // connect-timeout here → 503 → redelivery, not a corrupted order. If the
    // deployment ever sets idle_in_transaction_session_timeout below the
    // handler's worst case, the backend is killed and the lock drops early —
    // the ROLLBACK below then fails harmlessly and serialisation degrades to
    // the takeover window. Neither is silent: both land in error_logs.
    if (paymobTxnId) {
      _txnLockKey = 'paymob:txn:' + paymobTxnId;
      try {
        _txnLockClient = await pool.connect();
        await _txnLockClient.query('BEGIN');
        const lockRow = await _txnLockClient.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
          [_txnLockKey]
        );
        const gotLock = !!(lockRow && lockRow.rows && lockRow.rows[0] && lockRow.rows[0].locked);
        if (!gotLock) {
          logOrderEvent({
            orderId,
            label: 'Payment callback: concurrent delivery in flight — asked Paymob to retry',
            meta: JSON.stringify({ paymob_transaction_id: paymobTxnId, status }),
            actorRole: 'system'
          });
          return res.status(503).json({ ok: false, error: 'processing_in_progress' });
        }
      } catch (lockErr) {
        logErrorToDb(lockErr, {
          context: 'payment_callback_txn_lock',
          orderId,
          requestId: req.requestId,
          category: 'payment'
        });
        return res.status(503).json({ ok: false, error: 'lock_unavailable' });
      }
    }

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
          PROVISIONAL_EVENT_TYPE,
          JSON.stringify(req.body || {})
        ]
      );
      if (idemRes && idemRes.rowCount > 0) {
        _claimOwned = true;
      } else {
        // Someone already holds the claim. Take it over ONLY if it is still
        // provisional AND stale — i.e. an attempt that died without applying
        // an outcome. The predicate makes the takeover atomic: if a finaliser
        // commits first, event_type no longer matches and we match 0 rows.
        // AUDIT-2026-08-22 (R10, P2): the takeover used to bump received_at
        // ONLY, leaving payload_json / order_id / paymob_intention_id from the
        // ABANDONED attempt. Forensics on a re-processed delivery — the
        // amount-mismatch join in routes/api/admin.js, services/
        // payment_event_review, any manual reconciliation — then read a body
        // that is not the one this run acted on. The claim now carries THIS
        // delivery's body, which is the whole point of taking it over.
        const takeover = await execute(
          `UPDATE payment_events
              SET received_at = NOW(),
                  order_id = $3,
                  paymob_intention_id = $4,
                  payload_json = $5
            WHERE paymob_transaction_id = $1
              AND event_type = $2
              AND received_at < NOW() - INTERVAL '${CLAIM_TAKEOVER_SECONDS} seconds'`,
          [
            paymobTxnId,
            PROVISIONAL_EVENT_TYPE,
            orderId,
            paymobIntentionId,
            JSON.stringify(req.body || {})
          ]
        );
        if (takeover && takeover.rowCount > 0) {
          _claimOwned = true;
          logOrderEvent({
            orderId,
            label: 'Payment callback: re-processing an abandoned webhook claim',
            meta: JSON.stringify({ paymob_transaction_id: paymobTxnId, status }),
            actorRole: 'system'
          });
        } else {
          const heldRow = await queryOne(
            `SELECT event_type FROM payment_events WHERE paymob_transaction_id = $1 LIMIT 1`,
            [paymobTxnId]
          );
          if (heldRow && String(heldRow.event_type) === PROVISIONAL_EVENT_TYPE) {
            // A concurrent delivery of this same transaction is in flight right
            // now (or died inside the takeover window). Deliberately NOT a 200:
            // if that attempt dies, a 200 here is precisely the swallow this
            // fix removes. The retry either finds the row finalised (200 replay
            // below) or clears the takeover window above and re-processes.
            //
            // AUDIT-2026-08-22 (R7, P1): 503, not 409. Nothing in this repo
            // establishes that Paymob retries on 4xx, and many gateways treat
            // 4xx as terminal and retry only 5xx — under that contract the
            // loser of a concurrent pair was simply DROPPED, and if the winner
            // then threw, nobody redelivered: patient charged, order never
            // paid, which is the exact failure M6 set out to remove. 503 is the
            // conventional retriable answer and is safe under both contracts.
            return res.status(503).json({ ok: false, error: 'processing_in_progress' });
          }
          // Finalised row → a genuine replay of an already-APPLIED
          // transaction. No-op, 200, Paymob stops retrying. Unchanged.
          logOrderEvent({
            orderId,
            label: 'Payment callback: idempotent replay (already recorded)',
            meta: JSON.stringify({
              paymob_transaction_id: paymobTxnId,
              status,
              recorded_event_type: heldRow ? heldRow.event_type : null
            }),
            actorRole: 'system'
          });
          return res.json({ ok: true, idempotent: true });
        }
      }
    }
    // (If paymobTxnId is missing — defensive fallback — we skip the
    // per-txn idempotency check and rely on the per-order UPDATE guard
    // below. Paymob's documented payload always includes obj.id.)

    // AUDIT-2026-08-22 (M6): promote the provisional claim to its real
    // event_type. Call this at EVERY point below where this handler answers
    // with a decision that has been applied — after that point a redelivery
    // must be a no-op replay. Never call it on a path that leaves work undone.
    //
    // The steady state after finalisation is byte-identical to what this route
    // wrote before the fix (same id, same payload_json, same event_type), so
    // every existing reader of payment_events — routes/ops.js's webhook
    // metrics, the amount-mismatch join in routes/api/admin.js,
    // services/payment_event_review — is unaffected.
    //
    // Non-throwing: a failure here leaves the row provisional, so a redelivery
    // re-processes and lands on the already-paid / already-recorded guards
    // downstream. That is the safe direction — the opposite (claiming success
    // we did not achieve) is the bug.
    const finalizeClaim = async function () {
      if (!paymobTxnId || !_claimOwned) return;
      try {
        await execute(
          `UPDATE payment_events
              SET event_type = $2
            WHERE paymob_transaction_id = $1
              AND event_type = $3`,
          [paymobTxnId, _eventType, PROVISIONAL_EVENT_TYPE]
        );
      } catch (finErr) {
        logErrorToDb(finErr, {
          context: 'payment_callback_finalize_claim',
          orderId,
          requestId: req.requestId,
          category: 'payment'
        });
      }
    };

  const order = await queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
  if (!order) {
    // AUDIT-2026-08-22 (M6): deliberately NOT finalised. Money arrived for an
    // order we cannot see (orders_active hides soft-deleted rows, so the 48h
    // unpaid sweep can produce exactly this) — nothing has been applied, so a
    // redelivery must re-run the lookup rather than be swallowed as a replay.
    //
    // AUDIT-2026-08-22 (R7, P1): 503, not 404. Leaving the claim provisional
    // only helps if the delivery actually comes back, and a 404 is terminal
    // under most gateway retry contracts — so "re-run the lookup" never
    // happened and the patient stayed charged on an unpaid order. 503 asks for
    // a redelivery, which is what a soft-deleted-then-restored order or an
    // in-flight write needs. If the order genuinely does not exist the retries
    // stop of their own accord and the provisional row remains as the record.
    //
    // The claim row alone was NOT a working reconciliation signal: nothing
    // reads event_type='webhook_processing' today (routes/ops.js:599 excludes
    // it deliberately), so this now pages on-call directly. sendCriticalAlert
    // throttles per key, so a probe flood cannot spam the founder's phone.
    // HAND-OFF (ops owner): surface webhook_processing rows on /ops — they are
    // the list of deliveries that died mid-flight, and there is currently no
    // view of them anywhere.
    try {
      sendCriticalAlert(
        'Paymob webhook for UNKNOWN order ' + orderId +
        ' (txn ' + (paymobTxnId || 'n/a') + ') — money taken, no order to apply it to',
        'paymob_order_not_found'
      );
    } catch (_) {}
    return res.status(503).json({ ok: false, error: 'order not found' });
  }

  // ── FIX 2: a refund/void is audited and paged, never silently dropped ─────
  //
  // The idempotency INSERT above already stored the full body under
  // event_type='refund_or_void_received'. Here we make it visible on the case
  // timeline and page on-call: there is NO Paymob refund API integration on
  // this platform (refunds are manual InstaPay, see services/admin_refund.js),
  // so an inbound refund/void either means someone actioned one in the Paymob
  // dashboard or someone is probing us. Either way a human must look.
  // The order is deliberately left in whatever payment state it already had —
  // we never mark paid, and we never "unpay" a legitimately paid order from an
  // unsolicited webhook.
  if (isRefundOrVoid) {
    logOrderEvent({
      orderId,
      label: 'Paymob refund/void webhook received — order payment state UNCHANGED',
      meta: JSON.stringify({
        paymob_transaction_id: paymobTxnId,
        paymob_order_id: paymobOrderId,
        is_refunded: txnBody.is_refunded === true,
        is_voided: txnBody.is_voided === true,
        has_parent_transaction: txnBody.has_parent_transaction === true,
        amount_cents: txnBody.amount_cents != null ? Number(txnBody.amount_cents) : null,
        current_payment_status: order.payment_status || null
      }),
      actorRole: 'system'
    });
    try {
      sendCriticalAlert(
        'Paymob refund/void webhook on order ' + orderId +
        ' (txn ' + (paymobTxnId || 'n/a') + ', refunded=' + (txnBody.is_refunded === true) +
        ', voided=' + (txnBody.is_voided === true) + ') — reconcile manually',
        'paymob_refund_or_void'
      );
    } catch (_) {}
    // AUDIT-2026-08-22 (M6): the outcome for a refund/void IS "audited, paged,
    // order untouched" — that is fully applied above, so the claim finalises
    // and a redelivery is a genuine replay.
    await finalizeClaim();
    return res.json({ ok: true, refund_or_void: true });
  }

  // ── FIX 4 (regression F4): has_parent_transaction is an AUDIT signal ──────
  //
  // We are past the refund/void gate, so this transaction is a legitimate
  // inbound payment that happens to descend from an earlier one — a capture of
  // a prior authorisation, or a token/recurring charge. Those must settle
  // normally (and still have to clear the amount check below). But a child
  // transaction on a platform that only ever creates one-shot intentions is
  // unusual enough to want a human to look, so it is recorded on the timeline
  // and paged. Non-blocking by construction: nothing below reads hasParentTxn.
  if (hasParentTxn) {
    logOrderEvent({
      orderId,
      label: 'Paymob child transaction (has_parent_transaction) — processed normally, review',
      meta: JSON.stringify({
        paymob_transaction_id: paymobTxnId,
        paymob_order_id: paymobOrderId,
        signed_status: status,
        amount_cents: txnBody.amount_cents != null ? Number(txnBody.amount_cents) : null,
        current_payment_status: order.payment_status || null
      }),
      actorRole: 'system'
    });
    try {
      sendCriticalAlert(
        'Paymob child transaction (has_parent_transaction=true, not a refund/void) on order ' +
        orderId + ' (txn ' + (paymobTxnId || 'n/a') + ', status ' + (status || 'unknown') +
        ') — processed normally, verify it is a capture and not an unexpected flow',
        'paymob_child_transaction'
      );
    } catch (_) {}
  }

  // ── AUDIT-P0-6: bind the transaction to the intention we created ────────
  //
  // `orderId` above comes from obj.order.merchant_order_id, which is NOT in
  // the HMAC subject — i.e. the order a payment lands on was attacker-
  // choosable. orders.paymob_intention_id is written at intention creation
  // (see POST /paymob/create-intention), so when the webhook carries an
  // intention id it must be the one we minted for THIS order.
  //
  // Defence in depth, not the primary control: the per-transaction-id unique
  // index on payment_events already blocks replaying one settled transaction
  // onto a second order, and the signed-outcome fix above blocks laundering a
  // failed transaction into a success. This closes the remaining seam where
  // a live intention exists for a different order.
  //
  // ── AUDIT 2026-08-17 (FIX 3): the binding is now MANDATORY, not optional ──
  //
  // The old predicate was `if (paymobIntentionId && order.paymob_intention_id
  // && mismatch)`. obj.intention.id is NOT in the signed field set, so an
  // attacker replaying a captured signed body simply DELETED `obj.intention`
  // from the JSON: paymobIntentionId became null, the first conjunct was false,
  // and the entire control was skipped in silence. A guard you can turn off by
  // omitting a field is not a guard. So: when the order has an intention on
  // file, the callback must present a matching one, and a callback that
  // presents none is treated as a failed binding rather than as an exemption.
  //
  // Scope of the MISSING case is deliberately narrower than the MISMATCH case.
  // A mismatch is suspicious whatever the outcome, so it always short-circuits.
  // A missing intention id only blocks the path that MOVES MONEY (marking the
  // order paid) — blocking it on a `failed`/`pending` callback would suppress
  // the patient's "payment failed, try again" notification and page on-call for
  // an event that costs nothing.
  //
  // ── AUDIT 2026-08-17 (regression F3): DEFAULTS TO OFF ─────────────────────
  //
  // The MISSING branch rests on an unverified assumption: that Paymob's live
  // callback carries obj.intention.id at all. It is NOT in the HMAC-signed
  // 19-field set, no captured live payload in this repo demonstrates it, and
  // the comment above literally says to verify it against one real payment
  // first. Defaulting it ON inverted the blast radius: if the assumption is
  // wrong, EVERY payment on an order that has a stored intention id is parked
  // UNPAID while the patient's card is charged — and the operator is not even
  // told, because sendCriticalAlert is a no-op while CRITICAL_ALERT_TEMPLATE_NAME
  // is unset. A whole-platform payment outage, silently, on the first live card.
  //
  // Defaulting OFF costs only the narrow seam this branch closes (an attacker
  // who has a valid signed body AND deletes obj.intention from it), which is
  // still covered by: the per-transaction-id unique index on payment_events,
  // the signed-outcome derivation above, and the B5 amount check below. The
  // MISMATCH branch is unaffected by this flag and stays on — it only fires
  // when BOTH ids are present and differ, which is never an innocent state and
  // cannot be triggered by a payload that simply omits the field.
  //
  // TO TURN IT ON (do this after launch, not before):
  //   1. Take one real test-mode payment end to end.
  //   2. Confirm the callback carried obj.intention.id — the idempotency INSERT
  //      above persists exactly that value into the paymob_intention_id COLUMN:
  //        SELECT received_at, paymob_transaction_id, paymob_intention_id
  //          FROM payment_events WHERE event_type = 'payment_succeeded'
  //          ORDER BY received_at DESC LIMIT 5;
  //   3. paymob_intention_id non-null on every row → set
  //      PAYMOB_REQUIRE_INTENTION_BINDING=true. If it is NULL, the assumption
  //      was wrong and this branch must stay off.
  // Documented at the same three steps in .env.example.
  const _requireBinding =
    String(process.env.PAYMOB_REQUIRE_INTENTION_BINDING || 'false').toLowerCase() === 'true';
  const _wouldMarkPaid = normalizeStatus(status) === 'paid';

  // The stored id is only the LATEST intention for this order. FIX 11b makes a
  // legitimate re-mint succeed where it previously 502'd, so "patient has two
  // tabs open and pays in the older one" is now a reachable, ENTIRELY INNOCENT
  // state: the callback carries intention A while the order row holds B.
  // Rejecting that would take the patient's money and leave the order unpaid.
  //
  // The security property we actually need is "this intention was minted BY US
  // FOR THIS ORDER" — not "this is the newest one". payment_events carries an
  // 'intention_created' row per mint, keyed to the order, so ask that. A stale
  // intention that IS ours is accepted here and still has to clear the B5
  // amount check below, which is what catches a stale intention priced at a
  // pre-discount amount.
  let intentionMismatch = !!(
    order.paymob_intention_id && paymobIntentionId &&
    String(paymobIntentionId) !== String(order.paymob_intention_id)
  );
  if (intentionMismatch) {
    try {
      const ours = await queryOne(
        `SELECT id FROM payment_events
          WHERE order_id = $1
            AND event_type = 'intention_created'
            AND paymob_intention_id = $2
          LIMIT 1`,
        [orderId, paymobIntentionId]
      );
      if (ours) {
        intentionMismatch = false;
        logOrderEvent({
          orderId,
          label: 'Payment callback: settled on a superseded (but own) Paymob intention',
          meta: JSON.stringify({
            received_intention_id: paymobIntentionId,
            current_intention_id: order.paymob_intention_id,
            paymob_transaction_id: paymobTxnId
          }),
          actorRole: 'system'
        });
      }
    } catch (lookupErr) {
      // Fail CLOSED: if we cannot prove the intention is ours, treat it as a
      // mismatch. Leaving an order unpaid pending review is recoverable;
      // marking one paid on an unverified binding is not.
      logErrorToDb(lookupErr, { context: 'payment_callback_intention_history_lookup', orderId });
    }
  }

  const intentionMissing = !!(
    order.paymob_intention_id && !paymobIntentionId && _requireBinding && _wouldMarkPaid
  );
  // obj.order.id IS signed. We can only COMPARE it once the mapping is
  // persisted at intention-creation time (Paymob returns it as
  // `intention_order_id`; services/paymob.js does not surface it yet and
  // orders has no column for it — both specified in the handoff notes). Until
  // then `order.paymob_order_id` is undefined and this conjunct is inert; the
  // value is recorded in the audit payloads below either way, so a forensic
  // trail exists from day one.
  const paymobOrderMismatch = !!(
    order.paymob_order_id && paymobOrderId &&
    String(paymobOrderId) !== String(order.paymob_order_id)
  );

  if (intentionMismatch || intentionMissing || paymobOrderMismatch) {
    const bindingFailure = intentionMismatch ? 'intention_id_mismatch'
      : paymobOrderMismatch ? 'paymob_order_id_mismatch'
      : 'intention_id_absent_from_callback';
    try {
      await execute(
        `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, hmac_verified, received_at)
         VALUES ($1, $2, $3, 'intention_mismatch', $4, true, NOW())`,
        [
          'pe-' + crypto.randomUUID(),
          orderId,
          paymobIntentionId,
          JSON.stringify({
            binding_failure: bindingFailure,
            expected_intention_id: order.paymob_intention_id,
            received_intention_id: paymobIntentionId,
            expected_paymob_order_id: order.paymob_order_id || null,
            received_paymob_order_id: paymobOrderId,
            merchant_order_reference: merchantOrderRef,
            paymob_transaction_id: paymobTxnId,
            signed_status: status,
            ip: req.ip || null
          })
        ]
      );
    } catch (auditErr) {
      logErrorToDb(auditErr, { context: 'payment_callback_intention_mismatch_audit', orderId });
    }
    try {
      // FIX 4: own throttle bucket — see the HMAC-failure site above.
      sendCriticalAlert(
        'Paymob webhook binding failure (' + bindingFailure + ') on order ' + orderId +
        ' (expected intention ' + order.paymob_intention_id +
        ', got ' + (paymobIntentionId || 'NONE') + ')',
        'paymob_intention_mismatch'
      );
    } catch (_) {}
    // Ack 200 so Paymob stops retrying; the order is deliberately left UNPAID.
    // AUDIT-2026-08-22 (M6): "reject and leave unpaid" is an applied outcome —
    // the mismatch row is written and on-call is paged — so the claim
    // finalises. Re-processing a rejected binding would only re-page.
    await finalizeClaim();
    return res.json({ ok: true, intention_mismatch: true });
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
    // AUDIT-2026-08-22 (M6): an unclassifiable status moves no money and needs
    // no further work — recording it IS the outcome.
    await finalizeClaim();
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
        }).catch(function (err) {
      // AUDIT-P0-8: queueMultiChannelNotification is async and awaits a users
      // lookup inside normalizeToUserId, so it can reject on any transient DB
      // error. Un-awaited and un-caught, that rejection reached
      // server.js's unhandledRejection handler, which calls process.exit(1) —
      // crashing the whole server AFTER the order had already been marked paid.
      console.error('[payments] notification queue failed:', err && err.message ? err.message : err);
    });
      } catch (err) {
        console.error('[payment-failed-notify] queue failed:', err && err.message ? err.message : err);
      }
    }

    // AUDIT-2026-08-22 (M6): a failed/cancelled/pending callback moves no money
    // — the timeline row and the retry notification above are the whole
    // outcome, so the claim finalises here.
    await finalizeClaim();
    return res.json({ ok: true });
  }

  // ── B5 (launch audit): AMOUNT VERIFICATION ─────────────────────────────
  // Never mark an order paid unless Paymob charged EXACTLY what we asked for
  // (base price + persisted add-ons — see services/order_pricing). On mismatch:
  // leave the order UNPAID, record an 'amount_mismatch' payment_event, alert
  // admins, and still ack 200 so Paymob stops retrying. Manual review decides
  // whether to honor or refund. Skipped when already paid — a mismatched replay
  // must never "unpay" a legitimately-paid order.
  if (!alreadyPaid) {
    const owedCents = owedCentsForOrder(order);
    const paidCents = Number(txnBody.amount_cents);
    if (!Number.isFinite(paidCents) || paidCents !== owedCents) {
      // Record WITHOUT paymob_transaction_id so we don't collide with the
      // per-txn idempotency row already inserted above (that unique id is
      // taken); the txn id travels in the payload for triage.
      try {
        await execute(
          `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, hmac_verified, received_at)
           VALUES ($1, $2, $3, 'amount_mismatch', $4, true, NOW())`,
          [
            'pe-' + crypto.randomUUID(),
            orderId,
            paymobIntentionId,
            JSON.stringify({
              owed_cents: owedCents,
              paid_cents: Number.isFinite(paidCents) ? paidCents : null,
              currency: txnBody.currency || null,
              paymob_transaction_id: paymobTxnId
            })
          ]
        );
      } catch (auditErr) {
        logErrorToDb(auditErr, { context: 'payment_callback_amount_mismatch_audit', orderId });
      }
      logOrderEvent({
        orderId,
        label: 'Payment amount mismatch — order left UNPAID for manual review',
        meta: JSON.stringify({ owed_cents: owedCents, paid_cents: Number.isFinite(paidCents) ? paidCents : null }),
        actorRole: 'system'
      });
      try {
        await notifyAdmins({
          template: 'payment_amount_mismatch',
          payload: {
            order_id: orderId,
            owed_cents: owedCents,
            paid_cents: Number.isFinite(paidCents) ? paidCents : null,
            paymob_transaction_id: paymobTxnId
          },
          dedupeKey: 'amount_mismatch:' + orderId + ':' + (paymobTxnId || 'no-txn'),
          orderId,
          channel: 'internal'
        });
      } catch (notifyErr) {
        console.error('[callback] amount_mismatch notifyAdmins failed:', notifyErr && notifyErr.message);
      }
      // AUDIT 2026-08-17 — the worst silent state in the system.
      // The patient has been charged by Paymob and the order stays UNPAID, so
      // nothing assigns, nothing broadcasts, no SLA clock starts: from the
      // patient's side they paid and got nothing, and it stays that way until
      // a human reads the internal notifyAdmins row above. Nobody was told on
      // the phone. Both figures go in the body because the gap is what says
      // whether this is a rounding artefact or someone paying a fraction.
      try {
        const { pushOpsEvent } = require('../services/ops_push');
        const owedEgp = (Number(owedCents) / 100).toFixed(2);
        const paidEgp = Number.isFinite(paidCents) ? (paidCents / 100).toFixed(2) : 'unknown';
        // AUDIT — deliberately NOT awaited. This sits in a REQUEST path, and
        // pushOpsEvent makes an outbound HTTPS call to exp.host per registered
        // device. Awaiting it would put a third party's latency in front of
        // Paymob's webhook acknowledgement — a slow push would
        // make Paymob time out and RETRY the callback, duplicating work on a
        // path that has already written a payment_events row.
        // ops_push never throws and logs its own failures; the .catch() is
        // belt-and-braces.
        pushOpsEvent({
          kind: 'payment_mismatch',
          dedupeKey: orderId,
          title: 'Payment mismatch — case left unpaid',
          body: 'Paymob charged EGP ' + paidEgp + ' on ' + String(orderId).slice(0, 12).toUpperCase() +
                ', we asked EGP ' + owedEgp + '. Patient has paid and nothing is moving.',
          data: {
            orderId: orderId,
            owedCents: owedCents,
            paidCents: Number.isFinite(paidCents) ? paidCents : null,
            paymobTransactionId: paymobTxnId || null,
          },
          orderId,
        }).catch(function () { /* logged inside ops_push */ });
      } catch (pushErr) {
        console.error('[callback] amount_mismatch ops push failed:', pushErr && pushErr.message);
      }
      // Ack 200 (Paymob stops retrying); order stays UNPAID — no markCasePaid.
      // AUDIT-2026-08-22 (M6): the mismatch row, the timeline entry, the admin
      // notification and the ops push are the applied outcome; re-processing a
      // redelivery would produce the same rejection, so finalise the claim.
      await finalizeClaim();
      return res.json({ ok: true, amount_mismatch: true });
    }
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
      // AUDIT-2026-08-22 (M6): the order is fully paid and fully transitioned —
      // there is nothing left for a redelivery to do, so finalise.
      await finalizeClaim();
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
    // ── AUDIT 2026-08-17 (FIX 10): this catch used to label EVERY exception
    // "(idempotent)" with no alert and no error_logs row. markCasePaid is the
    // boundary that puts a paid case into the assignment pipeline; when it
    // throws, the patient has been charged and the case simply never enters
    // the queue. That is the single quietest way for this platform to take
    // money and deliver nothing, and it was indistinguishable in the logs from
    // a genuine no-op.
    //
    // markCasePaid's own idempotent path (case_lifecycle.js:1507-1513) RETURNS
    // the existing row — it does not throw — so in practice everything landing
    // here is a hard failure. The classifier below is deliberately narrow and
    // fails towards "alert": anything not positively recognised as a benign
    // re-entry pages on-call.
    const msg = String(e && e.message ? e.message : e);
    const benign = /already\s+(paid|assigned|processed)|idempotent|no[-\s]?op/i.test(msg);

    logOrderEvent({
      orderId,
      label: benign
        ? 'Payment lifecycle transition skipped (idempotent)'
        : 'Payment lifecycle transition FAILED — case may not have entered the pipeline',
      meta: JSON.stringify({ error: msg, benign, status, method, reference }),
      actorRole: 'system'
    });

    if (!benign) {
      try {
        logErrorToDb(e, {
          context: 'payment_callback_markCasePaid',
          orderId,
          requestId: req.requestId,
          category: 'payment',
          // The money HAS been taken at this point — the orders UPDATE above
          // already committed payment_status='paid'.
          payment_captured: true
        });
      } catch (_) {}
      try {
        sendCriticalAlert(
          'markCasePaid FAILED for order ' + orderId + ' AFTER payment was captured: ' +
          msg.slice(0, 300) + ' — case is paid but may not be in the assignment queue',
          'markcasepaid_failed'
        );
      } catch (_) {}
    }
  }

  // AUDIT-2026-08-22 (M6): THE point the claim becomes durable. Everything the
  // webhook is responsible for has now happened — orders.payment_status='paid'
  // committed by the guarded UPDATE above, and markCasePaid has run (or has
  // failed loudly with a critical alert and an error_logs row, which is the
  // pre-existing, deliberate behaviour: a redelivery cannot re-drive it because
  // the order is already paid, so acking is correct and paging is the recovery
  // path). Everything BELOW this line is best-effort fulfilment — notifications,
  // referral flags, add-on rows — each already wrapped in its own catch, and
  // none of it is re-runnable by a redelivery (the already-paid guard above
  // short-circuits first). Finalising later would therefore buy nothing and
  // risk leaving a settled payment looking abandoned.
  await finalizeClaim();

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
  }).catch(function (err) {
      // AUDIT-P0-8: queueMultiChannelNotification is async and awaits a users
      // lookup inside normalizeToUserId, so it can reject on any transient DB
      // error. Un-awaited and un-caught, that rejection reached
      // server.js's unhandledRejection handler, which calls process.exit(1) —
      // crashing the whole server AFTER the order had already been marked paid.
      console.error('[payments] notification queue failed:', err && err.message ? err.message : err);
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
    }).catch(function (err) {
      // AUDIT-P0-8: queueMultiChannelNotification is async and awaits a users
      // lookup inside normalizeToUserId, so it can reject on any transient DB
      // error. Un-awaited and un-caught, that rejection reached
      // server.js's unhandledRejection handler, which calls process.exit(1) —
      // crashing the whole server AFTER the order had already been marked paid.
      console.error('[payments] notification queue failed:', err && err.message ? err.message : err);
    });
  }

  // Mark referral reward as granted now that payment is confirmed
  try {
    await execute(
      'UPDATE referral_redemptions SET reward_granted = true WHERE order_id = $1 AND reward_granted = false',
      [orderId]
    );
  } catch (_) {}

  // === SETTLE SELECTED ADD-ONS ===
  //
  // 2026-08-24: this used to be ~190 lines of inline video + prescription
  // fulfilment, living only here. That was the bug: the Paymob webhook has
  // never fired in production (the integration is rejecting the live
  // credentials), so every paid order on the platform reached 'paid' through
  // an operator pressing Mark paid — a path that ran none of this. Money
  // collected, add-on never recorded, doctor never paid, patient never told.
  //
  // The logic now lives in services/addon_settlement.js and is called from all
  // three payment entry points. It is idempotent, it never throws, and it logs
  // every failure to the order's activity log.
  await settleAddonsForPaidOrder({
    orderId,
    order,
    via: 'paymob_webhook',
    actorRole: 'system',
    notify: queueMultiChannelNotification
  });

  return res.json({ ok: true });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, context: 'payment_callback' });
    return next(err);
  } finally {
    // AUDIT-2026-08-22 (R3): release the serialisation lock on EVERY exit —
    // the 200s, the 4xx/503 early returns and the next(err) above. ROLLBACK is
    // what actually drops the xact lock (nothing else ran in this transaction,
    // so there is nothing to commit); releasing the client without it would
    // hand a pooler backend back mid-transaction. Both are wrapped: a failure
    // here must never turn a delivered webhook into a 500, and destroying the
    // client on error guarantees the backend — and the lock with it — is gone.
    if (_txnLockClient) {
      const c = _txnLockClient;
      _txnLockClient = null;
      try {
        await c.query('ROLLBACK');
        c.release();
      } catch (unlockErr) {
        console.error('[callback] txn lock release failed:', unlockErr && unlockErr.message);
        try { c.release(true); } catch (_) {}
      }
    }
  }
});


module.exports = router;
module.exports.getOrCreatePaymentUrl = getOrCreatePaymentUrl;
