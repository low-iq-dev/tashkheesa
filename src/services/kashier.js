'use strict';
// src/services/kashier.js
//
// Kashier card gateway — hosted Payment Sessions (2026-10-05).
//
// Docs: https://developers.kashier.io/docs/accept-payments/payment-sessions
//
// WHAT THIS FILE IS. The thin client: read the configuration, create one
// payment session, hand back the hosted checkout URL. It never writes
// payment_status and never decides that money arrived — POST
// /payments/kashier/webhook (routes/payments_kashier.js) is the only place
// that does, after verifying Kashier's signature AND the amount.
//
// CONFIGURATION (all on Render; nothing is read at module load, so a change
// takes effect on the next request without a restart being required for the
// flags, and tests can set them per case):
//
//   CARD_PROVIDER             'kashier' turns this path on. Anything else (or
//                             unset) leaves the card path exactly as it was.
//   KASHIER_MODE              'live' | 'test'. Default 'test'.
//   KASHIER_MERCHANT_ID       MID-xxxx-xxx
//   KASHIER_PAYMENT_API_KEY   "Payment API Key" — sent as the `api-key` header
//                             AND the HMAC key for webhook signatures.
//   KASHIER_SECRET_KEY        "Secret Key" — sent as the Authorization header.
//   KASHIER_TEST_PATIENT_IDS  comma-separated users.id list. In TEST mode the
//                             card button is shown ONLY to these accounts.
//
// WHY THE TEST ALLOWLIST. A test-mode session takes no money, but the webhook
// it produces is correctly signed and would mark a real case PAID. On
// production, test mode open to everyone is a free-report button. So in test
// mode the card path exists only for the accounts named here; every other
// patient keeps seeing the transfer flow, unchanged.

const TEST_BASE = 'https://test-api.kashier.io';
const LIVE_BASE = 'https://api.kashier.io';
const SESSION_PATH = '/v3/payment/sessions';
const REQUEST_TIMEOUT_MS = 15000;

// How long a hosted session stays payable. Long enough for 3-D Secure and a
// trip to find the card; short enough that a stale tab cannot pay yesterday's
// price (every re-price nulls the stored link — see routes/patient.js).
const SESSION_TTL_MINUTES = 120;

// Injectable for tests.
let _fetch = null;
function __setFetch(fn) { _fetch = fn; }
function doFetch(url, opts) {
  const f = _fetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw kerr('fetch is not available', 'KASHIER_NOT_CONFIGURED');
  return f(url, opts);
}

function kerr(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function clean(v) {
  return v == null ? '' : String(v).trim();
}

function readConfig() {
  const provider = clean(process.env.CARD_PROVIDER).toLowerCase();
  const mode = clean(process.env.KASHIER_MODE).toLowerCase() === 'live' ? 'live' : 'test';
  const merchantId = clean(process.env.KASHIER_MERCHANT_ID);
  const apiKey = clean(process.env.KASHIER_PAYMENT_API_KEY);
  const secretKey = clean(process.env.KASHIER_SECRET_KEY);
  const testIds = clean(process.env.KASHIER_TEST_PATIENT_IDS)
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    selected: provider === 'kashier',
    mode: mode,
    baseUrl: mode === 'live' ? LIVE_BASE : TEST_BASE,
    merchantId: merchantId,
    apiKey: apiKey,
    secretKey: secretKey,
    configured: !!(merchantId && apiKey && secretKey),
    testPatientIds: testIds
  };
}

/** CARD_PROVIDER=kashier — regardless of whether the keys are in yet. */
function isSelected() {
  return readConfig().selected;
}

/**
 * Is the Kashier card path available to THIS patient right now?
 * live  → everyone, once the three credentials are present.
 * test  → only the accounts in KASHIER_TEST_PATIENT_IDS.
 */
function isAvailableForPatient(patientId) {
  const cfg = readConfig();
  if (!cfg.selected || !cfg.configured) return false;
  if (cfg.mode === 'live') return true;
  return patientId != null && cfg.testPatientIds.indexOf(String(patientId)) !== -1;
}

/** 75000 → "750.00". Kashier takes a decimal STRING in major units. */
function centsToAmountString(cents) {
  const n = Number(cents);
  if (!Number.isInteger(n) || n <= 0) throw kerr('invalid amount', 'KASHIER_INVALID_AMOUNT');
  return (n / 100).toFixed(2);
}

/**
 * Kashier reports `amount` in major units, as a number or a numeric string
 * (11334, 750, "750.00"). Returns integer cents, or NaN when it is not a
 * clean money value — the caller treats NaN as an amount mismatch.
 */
function amountToCents(amount) {
  if (amount == null || amount === '') return NaN;
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

/**
 * Create one hosted payment session.
 *
 * @param {object} a
 * @param {string} a.orderRef      unique per attempt (Kashier rejects a reused
 *                                 `order` with ERR_ORD_02) — build it with
 *                                 routes/payments.buildSpecialReference
 * @param {number} a.amountCents
 * @param {string} a.currency      'EGP'
 * @param {string} a.redirectUrl   absolute https URL, NO query string
 * @param {string} a.webhookUrl    absolute https URL
 * @param {string} [a.lang]        'ar' | 'en'
 * @param {string} [a.description] ≤120 chars, shown on the checkout
 * @param {object} [a.customer]    { reference: users.id, email? }
 * @returns {Promise<{sessionId: string, checkoutUrl: string, expireAt: string, mode: string}>}
 */
async function createSession(a) {
  const cfg = readConfig();
  if (!cfg.selected || !cfg.configured) {
    throw kerr('Kashier is not configured', 'KASHIER_NOT_CONFIGURED');
  }
  const args = a || {};
  if (!args.orderRef) throw kerr('orderRef required', 'KASHIER_BAD_REQUEST');
  if (!/^https:\/\//i.test(String(args.redirectUrl || ''))) throw kerr('redirectUrl must be https', 'KASHIER_BAD_REQUEST');
  if (!/^https:\/\//i.test(String(args.webhookUrl || ''))) throw kerr('webhookUrl must be https', 'KASHIER_BAD_REQUEST');

  const expireAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();
  const body = {
    merchantId: cfg.merchantId,
    order: String(args.orderRef),
    amount: centsToAmountString(args.amountCents),
    currency: String(args.currency || 'EGP').toUpperCase(),
    expireAt: expireAt,
    paymentType: 'credit',
    type: 'one-time',
    maxFailureAttempts: 3,
    allowedMethods: 'card,wallet',
    display: String(args.lang || '').toLowerCase() === 'en' ? 'en' : 'ar',
    merchantRedirect: String(args.redirectUrl),
    redirectMethod: 'get',
    serverWebhook: String(args.webhookUrl),
    interactionSource: 'ECOMMERCE',
    brandColor: '#0B6B5F'
  };
  if (args.description) body.description = String(args.description).slice(0, 120);
  // `customer` is REQUIRED by the live API (400 '"customer" is required' on the
  // first real call, 6 Oct 2026) although the guide lists it as optional.
  // `reference` is our users.id; e-mail only when the account has one —
  // name + phone signups do not.
  const cust = args.customer || {};
  body.customer = { reference: String(cust.reference || args.orderRef) };
  if (cust.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(cust.email))) {
    body.customer.email = String(cust.email).trim();
  }

  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
  let res;
  try {
    res = await doFetch(cfg.baseUrl + SESSION_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': cfg.secretKey,
        'api-key': cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw kerr('Kashier request timed out', 'KASHIER_TIMEOUT');
    }
    throw kerr('Kashier request failed: ' + (e && e.message ? e.message : e), 'KASHIER_HTTP_ERROR');
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json = null;
  let text = '';
  try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

  if (!res.ok) {
    // Never log the request (it carries no secrets in the body, but the
    // headers do); the response body is Kashier's own error text.
    throw kerr('Kashier responded ' + res.status, 'KASHIER_HTTP_ERROR', {
      status: res.status,
      responseSnippet: String(text || '').slice(0, 300)
    });
  }

  const sessionId = json && (json._id || json.sessionId || json.id);
  const sessionUrl = json && json.sessionUrl;
  if (!sessionId || typeof sessionUrl !== 'string' || !/^https:\/\//i.test(sessionUrl)) {
    throw kerr('Kashier response missing sessionUrl', 'KASHIER_MALFORMED_RESPONSE', {
      responseSnippet: String(text || '').slice(0, 300)
    });
  }

  return {
    sessionId: String(sessionId),
    checkoutUrl: sessionUrl,
    expireAt: expireAt,
    mode: cfg.mode
  };
}

module.exports = {
  readConfig,
  isSelected,
  isAvailableForPatient,
  createSession,
  centsToAmountString,
  amountToCents,
  SESSION_TTL_MINUTES,
  __setFetch
};
