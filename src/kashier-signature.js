// src/kashier-signature.js
// Kashier webhook signature verification (HMAC-SHA256)
//
// Kashier POSTs every transaction event to our callback with a signature in
// the `x-kashier-signature` header. Unlike Paymob — which signs a FIXED list
// of 19 fields — Kashier tells us which fields it signed, in the payload
// itself, via `data.signatureKeys`.
//
// Documented algorithm (https://developers.kashier.io/payment/webhook/):
//   1. Take `data.signatureKeys` (an array of field names).
//   2. Sort it alphabetically.
//   3. Pull those fields out of `data`.
//   4. Join as a query string: key1=value1&key2=value2
//   5. HMAC-SHA256 that string with the Payment API Key.
//   6. Compare, timing-safely, against the x-kashier-signature header.
//   7. Answer 200 or Kashier retries.
//
// ── SECURITY NOTE — read before touching this file ─────────────────────────
// `signatureKeys` arrives INSIDE the attacker-controllable payload. A forged
// webhook could therefore ship `signatureKeys: []`, sign the empty string,
// and present a signature that verifies perfectly over nothing at all. The
// amount, the currency and the order it belongs to would all be unsigned and
// free to forge.
//
// So a valid signature is necessary but NOT sufficient. We additionally
// require that every field in REQUIRED_SIGNED_FIELDS actually appears in
// signatureKeys. If Kashier ever legitimately stops signing one of them this
// fails closed — loudly, in the logs — which is the correct direction to fail
// for a payment webhook. Do not "fix" that by relaxing the list.
//
// This is the same class of bug as the Paymob intention-binding note in
// render.yaml: trusting the callback to tell you what it bound itself to.

'use strict';

const crypto = require('crypto');
const { logErrorToDb } = require('./logger');

const SIGNATURE_HEADER = 'x-kashier-signature';

// Fields that MUST be covered by the signature for us to trust the event.
// These are the facts we act on: how much, in what currency, for which order,
// and whether it succeeded.
const REQUIRED_SIGNED_FIELDS = [
  'amount',
  'currency',
  'merchantOrderId',
  'status'
];

/**
 * Build the string Kashier signed, from the payload's own field list.
 *
 * @param {object} data           - body.data from the webhook
 * @param {string[]} signatureKeys - data.signatureKeys
 * @returns {string} query-string form, alphabetically ordered
 */
function buildSignatureString(data, signatureKeys) {
  return signatureKeys
    .slice()
    .sort()
    .map(function (key) {
      const v = data[key];
      // Kashier joins raw values; it does NOT url-encode. Verified against a
      // live test webhook before go-live — if signatures fail on payloads
      // containing spaces or '&', re-check this line first.
      return key + '=' + (v == null ? '' : String(v));
    })
    .join('&');
}

/**
 * Verify a Kashier webhook.
 *
 * Fails closed on every ambiguity. Never throws — returns a reason instead,
 * so the caller can log it and still answer Kashier with a 200 where that is
 * the right thing to do.
 *
 * @param {object} body       - the parsed webhook body ({ event, data })
 * @param {string} headerSig  - value of the x-kashier-signature header
 * @param {string} apiKey     - Payment API Key (KASHIER_PAYMENT_API_KEY)
 * @returns {{ok: boolean, reason: string|null}}
 */
function verifyKashierSignature(body, headerSig, apiKey) {
  if (!apiKey) {
    return { ok: false, reason: 'no_api_key_configured' };
  }
  if (!headerSig || typeof headerSig !== 'string') {
    return { ok: false, reason: 'missing_signature_header' };
  }
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') {
    return { ok: false, reason: 'malformed_payload' };
  }

  const data = body.data;
  const keys = data.signatureKeys;

  if (!Array.isArray(keys) || keys.length === 0) {
    // See the security note above: an empty list signs nothing.
    return { ok: false, reason: 'empty_signature_keys' };
  }

  const missing = REQUIRED_SIGNED_FIELDS.filter(function (f) {
    return keys.indexOf(f) === -1;
  });
  if (missing.length > 0) {
    return { ok: false, reason: 'unsigned_critical_fields:' + missing.join(',') };
  }

  const subject = buildSignatureString(data, keys);
  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(subject, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(headerSig.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true, reason: null };
}

/**
 * Verify and log. Convenience wrapper for the route.
 */
async function verifyAndLog(body, headerSig, apiKey, ctx) {
  const result = verifyKashierSignature(body, headerSig, apiKey);
  if (!result.ok) {
    try {
      await logErrorToDb({
        level: 'error',
        category: 'kashier_webhook',
        message: 'kashier signature rejected: ' + result.reason,
        context: Object.assign({
          event: body && body.event,
          merchantOrderId: body && body.data && body.data.merchantOrderId
        }, ctx || {})
      });
    } catch (_) { /* logging must never break the webhook path */ }
  }
  return result;
}

module.exports = {
  verifyKashierSignature: verifyKashierSignature,
  verifyAndLog: verifyAndLog,
  SIGNATURE_HEADER: SIGNATURE_HEADER,
  REQUIRED_SIGNED_FIELDS: REQUIRED_SIGNED_FIELDS,
  // Exported for tests.
  buildSignatureString: buildSignatureString
};
