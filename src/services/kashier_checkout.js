'use strict';
// src/services/kashier_checkout.js
//
// One place that turns "this unpaid order" into "a Kashier checkout URL", used
// by BOTH the web Pay button (routes/payments.js) and the mobile payment read
// (routes/api/cases.js) so the two can never charge different amounts.
//
// Storage reuses what exists rather than adding a migration:
//   orders.paymob_intention_id  ← 'kashier:<sessionId>'
//   payment_events              ← 'intention_created' (carries the session URL,
//                                 amount, currency, mode) / 'intention_failed'
//
// orders.payment_link is deliberately NOT written. A hosted session expires
// after SESSION_TTL_MINUTES, and payment_link is the "canonical payment URL"
// that reminders, the dashboard and the payment-failed message hand out days
// later (routes/payments.getOrCreatePaymentUrl). It must stay the durable
// /portal/patient/pay/<id> page, which mints a fresh session on demand.
//
// Every path that re-prices an order NULLs paymob_intention_id
// (routes/patient.js wizard re-price, routes/referrals.js), which is what
// makes reuse safe: a stored session is only handed back while it is fresh,
// in the same mode, and for exactly the amount still owed.

const crypto = require('crypto');
const kashier = require('./kashier');

const KASHIER_INTENTION_PREFIX = 'kashier:';
const WEBHOOK_PATH = '/payments/kashier/webhook';
const RETURN_PATH_PREFIX = '/portal/patient/payment-return/k/';

// Reuse a session for this long. Comfortably inside the session's own TTL so
// a reused link is never one Kashier has already expired.
const REUSE_MINUTES = Math.max(5, Math.min(60, kashier.SESSION_TTL_MINUTES - 30));

const D = {
  pg: function () { return require('../pg'); },
  logErrorToDb: function () { return require('../logger').logErrorToDb.apply(null, arguments); },
  buildSpecialReference: function (orderId) {
    return require('../routes/payments').buildSpecialReference(orderId);
  }
};
function __setTestDeps(o) { Object.assign(D, o || {}); }

function cerr(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function isKashierIntentionId(v) {
  return typeof v === 'string' && v.indexOf(KASHIER_INTENTION_PREFIX) === 0;
}

/** The public origin Kashier calls back to. Never derived from a request header. */
function publicBaseUrl() {
  const raw = String(process.env.BASE_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(raw)) {
    throw cerr('BASE_URL must be an https origin for Kashier callbacks', 'KASHIER_NOT_CONFIGURED');
  }
  return raw;
}

/**
 * @param {object} a
 * @param {object} a.order        { id, paymob_intention_id }
 * @param {number} a.amountCents  what is owed (owedCentsForOrder) — computed by the caller
 * @param {string} a.currency
 * @param {string} [a.lang]       'ar' | 'en'
 * @param {string} [a.source]     'web_pay_page' | 'mobile_pay_page'
 * @param {object} [a.customer]   { reference: users.id, email? } — passed to Kashier
 * @returns {Promise<{checkoutUrl: string, reused: boolean}>}
 */
async function ensureKashierCheckout(a) {
  const order = a && a.order;
  if (!order || !order.id) throw cerr('order required', 'ORDER_NOT_FOUND');
  const amountCents = Number(a.amountCents);
  const currency = String(a.currency || 'EGP').toUpperCase();
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw cerr('invalid_amount', 'INVALID_AMOUNT');

  const { queryOne, execute } = D.pg();

  // ── Reuse ────────────────────────────────────────────────────────────────
  if (isKashierIntentionId(order.paymob_intention_id)) {
    try {
      const prior = await queryOne(
        `SELECT payload_json
           FROM payment_events
          WHERE order_id = $1
            AND event_type = 'intention_created'
            AND paymob_intention_id = $2
            AND received_at > NOW() - make_interval(mins => $3::int)
          ORDER BY received_at DESC
          LIMIT 1`,
        [order.id, String(order.paymob_intention_id), REUSE_MINUTES]
      );
      const p = prior && prior.payload_json ? prior.payload_json : null;
      if (p && typeof p.checkoutUrl === 'string' && /^https:\/\//i.test(p.checkoutUrl) &&
          Number(p.amountCents) === amountCents &&
          String(p.currency || '').toUpperCase() === currency &&
          p.mode === kashier.readConfig().mode) {
        return { checkoutUrl: p.checkoutUrl, reused: true };
      }
    } catch (reuseErr) {
      // The optimisation must never block a payment — fall through and mint.
      D.logErrorToDb(reuseErr, { context: 'kashier_checkout_reuse_check', orderId: order.id });
    }
  }

  // ── Mint ─────────────────────────────────────────────────────────────────
  const base = publicBaseUrl();
  const orderRef = D.buildSpecialReference(order.id);

  let session;
  try {
    session = await kashier.createSession({
      orderRef: orderRef,
      amountCents: amountCents,
      currency: currency,
      redirectUrl: base + RETURN_PATH_PREFIX + encodeURIComponent(order.id),
      webhookUrl: base + WEBHOOK_PATH,
      lang: a.lang,
      customer: a.customer || null,
      description: 'Tashkheesa ' + String(order.id).slice(0, 12).toUpperCase()
    });
  } catch (e) {
    try {
      await execute(
        `INSERT INTO payment_events (id, order_id, event_type, payload_json, received_at)
         VALUES ($1, $2, 'intention_failed', $3, NOW())`,
        [
          'pe-' + crypto.randomUUID(),
          order.id,
          JSON.stringify({
            provider: 'kashier',
            code: e && e.code || null,
            message: e && e.message || null,
            status: e && e.status || null,
            response: e && e.responseSnippet || null,
            special_reference: orderRef
          })
        ]
      );
    } catch (auditErr) {
      D.logErrorToDb(auditErr, { context: 'kashier_checkout_audit_failed', orderId: order.id });
    }
    D.logErrorToDb(e, { context: 'kashier_create_session', orderId: order.id, category: 'payment' });
    throw cerr('card_unavailable', 'CARD_UNAVAILABLE', { cause: e });
  }

  const intentionId = KASHIER_INTENTION_PREFIX + session.sessionId;
  await execute(
    `UPDATE orders SET paymob_intention_id = $1 WHERE id = $2`,
    [intentionId, order.id]
  );
  try {
    await execute(
      `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, received_at)
       VALUES ($1, $2, $3, 'intention_created', $4, NOW())`,
      [
        'pe-' + crypto.randomUUID(),
        order.id,
        intentionId,
        JSON.stringify({
          provider: 'kashier',
          mode: session.mode,
          checkoutUrl: session.checkoutUrl,
          amountCents: amountCents,
          currency: currency,
          special_reference: orderRef,
          expireAt: session.expireAt,
          source: a.source || null
        })
      ]
    );
  } catch (auditErr) {
    D.logErrorToDb(auditErr, { context: 'kashier_checkout_audit_success', orderId: order.id });
  }

  return { checkoutUrl: session.checkoutUrl, reused: false };
}

module.exports = {
  ensureKashierCheckout,
  isKashierIntentionId,
  KASHIER_INTENTION_PREFIX,
  WEBHOOK_PATH,
  RETURN_PATH_PREFIX,
  REUSE_MINUTES,
  __setTestDeps
};
