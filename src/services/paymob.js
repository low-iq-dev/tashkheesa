// src/services/paymob.js
//
// Paymob Unified Intention API client. Card-only.
//
// API surface:
//   POST https://accept.paymob.com/v1/intention/
//     headers: Authorization: Token <PAYMOB_SECRET_KEY>, Content-Type: application/json
//     body:    { amount, currency, payment_methods, items, billing_data,
//                special_reference, notification_url, redirection_url, extras }
//     response: { id, client_secret, payment_keys, intention_detail, ... }
//
// Checkout URL is constructed client-side from the response:
//   https://accept.paymob.com/unifiedcheckout/?publicKey=<PUB>&clientSecret=<CS>
//
// Mode safety:
//   This module refuses to operate when PAYMOB_MODE != 'test'. Belt-and-
//   suspenders against accidental config drift. Every public entry point
//   asserts test mode. Switching to live requires editing this file
//   intentionally.
//
// HMAC verification:
//   Lives at src/paymob-hmac.js and is unchanged. Re-exported below so
//   callers have a single import surface.

'use strict';

const { logErrorToDb } = require('../logger');
const { verifyPaymobHmac } = require('../paymob-hmac');

const PAYMOB_API_BASE = 'https://accept.paymob.com';
const INTENTION_PATH  = '/v1/intention/';
const CHECKOUT_PATH   = '/unifiedcheckout/';
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Mode guard
// ---------------------------------------------------------------------------

function _assertTestMode() {
  const mode = String(process.env.PAYMOB_MODE || 'test').toLowerCase();
  if (mode !== 'test') {
    const e = new Error('PAYMOB_MODE=' + mode + ' not permitted — services/paymob.js is gated to test mode.');
    e.code = 'PAYMOB_MODE_NOT_TEST';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Patient PII validation
// Per the integration brief, billing_data fields are required by Paymob for
// card payments. Validate up-front so we surface a specific actionable error
// (PATIENT_PROFILE_INCOMPLETE) instead of letting Paymob respond with a
// generic 400. Caller can prompt the patient to update their profile.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE  = /^\+[1-9]\d{6,14}$/;

function _validatePatient(patient) {
  if (!patient || typeof patient !== 'object') {
    const e = new Error('paymob.createIntention: patient object required');
    e.code = 'PATIENT_PROFILE_INCOMPLETE';
    e.fields = ['patient'];
    throw e;
  }
  const missing = [];
  const name = String(patient.name || '').trim();
  if (!name) missing.push('name');

  const email = String(patient.email || '').trim();
  if (!email) missing.push('email');
  else if (!EMAIL_RE.test(email)) missing.push('email_format');

  const phone = String(patient.phone || patient.phone_number || '').trim();
  if (!phone) missing.push('phone');
  else if (!E164_RE.test(phone)) missing.push('phone_format');

  if (missing.length) {
    const e = new Error('paymob.createIntention: invalid patient profile (' + missing.join(', ') + ')');
    e.code = 'PATIENT_PROFILE_INCOMPLETE';
    e.fields = missing;
    throw e;
  }
}

function _splitName(fullName) {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'NA', last: 'NA' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------------------
// Low-level HTTP wrapper — single fetch surface for timeout + structured
// error logging. All Paymob HTTP calls go through here.
// ---------------------------------------------------------------------------

async function _paymobFetch(path, opts) {
  _assertTestMode();
  const secretKey = process.env.PAYMOB_SECRET_KEY;
  if (!secretKey) {
    const e = new Error('PAYMOB_SECRET_KEY not set');
    e.code = 'PAYMOB_CONFIG_MISSING';
    throw e;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PAYMOB_API_BASE + path, {
      method: opts.method || 'POST',
      headers: Object.assign({
        'Authorization': 'Token ' + secretKey,
        'Content-Type': 'application/json'
      }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
    if (!res.ok) {
      const e = new Error('Paymob ' + path + ' returned HTTP ' + res.status);
      e.code = 'PAYMOB_HTTP_ERROR';
      e.status = res.status;
      e.body = parsed;
      throw e;
    }
    return parsed;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('Paymob ' + path + ' timed out after ' + FETCH_TIMEOUT_MS + 'ms');
      e.code = 'PAYMOB_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Public: createIntention
// ---------------------------------------------------------------------------

/**
 * Create a Paymob Unified Intention for a card payment.
 *
 * @param {object} args
 * @param {string} args.orderId          Tashkheesa order id (becomes special_reference)
 * @param {number} args.amountCents      Positive integer, in EGP cents
 * @param {string} [args.currency]       'EGP' (default; only EGP supported)
 * @param {object} args.patient          { name, email, phone, country?, city?, state? }
 * @param {string} args.redirectionUrl   Patient post-checkout return URL
 * @param {Array}  [args.items]          Optional override of the default single-line item
 * @returns {Promise<{ intentionId, clientSecret, checkoutUrl }>}
 */
async function createIntention(args) {
  _assertTestMode();

  args = args || {};
  if (!args.orderId) {
    throw new Error('paymob.createIntention: orderId required');
  }
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new Error('paymob.createIntention: amountCents must be a positive integer');
  }
  const currency = String(args.currency || 'EGP').toUpperCase();
  if (currency !== 'EGP') {
    throw new Error('paymob.createIntention: only EGP supported');
  }
  if (!args.redirectionUrl) {
    throw new Error('paymob.createIntention: redirectionUrl required');
  }

  // PII gate — throws PATIENT_PROFILE_INCOMPLETE before any network call
  // when the patient profile is missing or malformed.
  _validatePatient(args.patient);

  const cardIntegrationId = parseInt(process.env.PAYMOB_CARD_INTEGRATION_ID || '', 10);
  if (!Number.isInteger(cardIntegrationId) || cardIntegrationId <= 0) {
    const e = new Error('PAYMOB_CARD_INTEGRATION_ID not set or invalid');
    e.code = 'PAYMOB_CONFIG_MISSING';
    throw e;
  }
  const publicKey = process.env.PAYMOB_PUBLIC_KEY;
  if (!publicKey) {
    const e = new Error('PAYMOB_PUBLIC_KEY not set');
    e.code = 'PAYMOB_CONFIG_MISSING';
    throw e;
  }
  const notificationUrl = process.env.PAYMOB_NOTIFICATION_URL;
  if (!notificationUrl) {
    const e = new Error('PAYMOB_NOTIFICATION_URL not set');
    e.code = 'PAYMOB_CONFIG_MISSING';
    throw e;
  }

  const { first, last } = _splitName(args.patient.name);

  const body = {
    amount: args.amountCents,
    currency: currency,
    payment_methods: [cardIntegrationId],
    special_reference: args.orderId,
    notification_url: notificationUrl,
    redirection_url: args.redirectionUrl,
    items: (Array.isArray(args.items) && args.items.length) ? args.items : [{
      name: 'Tashkheesa medical second opinion',
      amount: args.amountCents,
      description: 'Specialist medical second-opinion service',
      quantity: 1
    }],
    billing_data: {
      first_name: first,
      last_name: last,
      email: args.patient.email,
      phone_number: args.patient.phone || args.patient.phone_number,
      country: args.patient.country || 'EG',
      // Paymob requires these address fields on the API even though they
      // are irrelevant for digital products. Placeholders satisfy validation.
      street: 'NA',
      building: 'NA',
      floor: 'NA',
      apartment: 'NA',
      city: args.patient.city || 'NA',
      state: args.patient.state || 'NA'
    },
    extras: { merchant_order_id: args.orderId }
  };

  let resp;
  try {
    resp = await _paymobFetch(INTENTION_PATH, { method: 'POST', body: body });
  } catch (err) {
    try {
      logErrorToDb(err, { context: 'paymob.createIntention', orderId: args.orderId, code: err.code, status: err.status });
    } catch (_) {}
    throw err;
  }

  if (!resp || resp.id == null || !resp.client_secret) {
    const e = new Error('paymob.createIntention: malformed response (missing id or client_secret)');
    e.code = 'PAYMOB_MALFORMED_RESPONSE';
    e.body = resp;
    throw e;
  }

  const checkoutUrl = PAYMOB_API_BASE + CHECKOUT_PATH +
    '?publicKey=' + encodeURIComponent(publicKey) +
    '&clientSecret=' + encodeURIComponent(resp.client_secret);

  return {
    intentionId: String(resp.id),
    clientSecret: String(resp.client_secret),
    checkoutUrl: checkoutUrl
  };
}

module.exports = {
  createIntention: createIntention,
  // HMAC verifier re-exported so callers have one import surface.
  verifyPaymobHmac: verifyPaymobHmac,
  // Exported for tests.
  _splitName: _splitName,
  _validatePatient: _validatePatient,
  _assertTestMode: _assertTestMode
};
