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
// RFC 3986 strict encoding — what the `query-string` package (Kashier's own
// Node sample) and PHP_QUERY_RFC3986 (their PHP sample) both produce.
function strictEncode(v) {
  return encodeURIComponent(v).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function buildSignatureString(data, signatureKeys) {
  return signatureKeys
    .slice()
    .sort()
    .map(function (key) {
      const v = data[key];
      // 2026-10-05 — Kashier URL-ENCODES THE VALUES (keys are left as they
      // are). This used to join raw values, which verifies only while no
      // signed value contains a space or a reserved character; `channel` is
      // "online | e-commerce" on real card payments, so every real webhook
      // would have failed. Pinned by the documented test vector in
      // tests/services/kashier-signature.test.js
      // (developers.kashier.io/docs/webhooks, key 11111).
      return key + '=' + (v == null ? '' : strictEncode(String(v)));
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

/**
 * Is this delivery genuinely from Kashier, regardless of WHICH fields it signs?
 *
 * 7 Oct 2026 — Kashier sends events whose signatureKeys do not cover amount,
 * currency and status (seen live from 6 Oct 13:00 UTC, user agent KASHIER).
 * verifyKashierSignature rightly refuses to treat those as payment
 * confirmations, but answering 401 made Kashier retry the same delivery ten
 * times over a day, each raising a critical "signature failure" alert for
 * something that was not an attack.
 *
 * This checks only the HMAC over the keys the delivery names. A true result
 * means "Kashier sent this"; it NEVER means "this may mark an order paid" —
 * only verifyKashierSignature can say that. The caller uses it to acknowledge
 * and record an authentic event it cannot act on.
 */
function verifyKashierAuthenticity(body, headerSig, apiKey) {
  if (!apiKey || !headerSig || typeof headerSig !== 'string') return false;
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return false;
  const keys = body.data.signatureKeys;
  if (!Array.isArray(keys) || keys.length === 0) return false;
  const expected = crypto.createHmac('sha256', apiKey)
    .update(buildSignatureString(body.data, keys), 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(headerSig.trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Work out HOW an unactionable delivery was signed, if at all.
 *
 * 7 Oct 2026 — the delivery Kashier kept retrying (it arrives eight minutes
 * after an unpaid live payment session expires) names no amount, currency or
 * status, AND does not verify under the one documented scheme. Kashier does
 * not document that event. Rather than guess, try the plausible ways of
 * signing the same delivery and report WHICH one matched.
 *
 * A match means only "Kashier sent this". It is used solely to acknowledge and
 * record a delivery we were already refusing to act on. It can never mark an
 * order paid: that path goes through verifyKashierSignature and nothing else.
 *
 * @returns {string|null} the name of the matching scheme, or null
 */
function probeKashierAuthenticity(body, rawBody, headerSig, secrets) {
  try {
    if (!headerSig || typeof headerSig !== 'string') return null;
    if (!body || typeof body !== 'object') return null;
    const data = (body.data && typeof body.data === 'object') ? body.data : {};
    const keys = Array.isArray(data.signatureKeys) ? data.signatureKeys.map(String) : [];
    const want = headerSig.trim();
    const named = [];
    const s = secrets || {};
    if (s.apiKey) named.push(['api', s.apiKey]);
    if (s.secretKey) named.push(['secret', s.secretKey]);
    if (named.length === 0) return null;

    const val = function (v, mode) {
      if (v == null) return '';
      const str = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      return mode === 'enc' ? strictEncode(str) : str;
    };
    const join = function (order, mode) {
      return order.map(function (k) { return k + '=' + val(data[k], mode); }).join('&');
    };
    const subjects = [];
    if (keys.length > 0) {
      const sorted = keys.slice().sort();
      subjects.push(['sorted_encoded', join(sorted, 'enc')]);
      subjects.push(['sorted_plain', join(sorted, 'raw')]);
      subjects.push(['listed_encoded', join(keys, 'enc')]);
      subjects.push(['listed_plain', join(keys, 'raw')]);
    }
    if (rawBody && rawBody.length) subjects.push(['raw_body', rawBody]);
    subjects.push(['data_json', JSON.stringify(data)]);

    const same = function (a, b) {
      const x = Buffer.from(String(a), 'utf8');
      const y = Buffer.from(String(b), 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    for (let i = 0; i < named.length; i++) {
      for (let j = 0; j < subjects.length; j++) {
        const mac = crypto.createHmac('sha256', named[i][1]).update(subjects[j][1]);
        const hex = mac.digest('hex');
        if (same(hex, want.toLowerCase())) return named[i][0] + ':' + subjects[j][0] + ':hex';
        const b64 = Buffer.from(hex, 'hex').toString('base64');
        if (same(b64, want)) return named[i][0] + ':' + subjects[j][0] + ':base64';
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  verifyKashierSignature: verifyKashierSignature,
  verifyKashierAuthenticity: verifyKashierAuthenticity,
  probeKashierAuthenticity: probeKashierAuthenticity,
  verifyAndLog: verifyAndLog,
  SIGNATURE_HEADER: SIGNATURE_HEADER,
  REQUIRED_SIGNED_FIELDS: REQUIRED_SIGNED_FIELDS,
  // Exported for tests.
  buildSignatureString: buildSignatureString
};
