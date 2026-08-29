// src/lib/svix_verify.js
//
// Svix webhook signature verification, implemented directly against the spec
// rather than by adding the `svix` package.
//
// The signature is computed over the EXACT bytes Svix sent:
//
//     signedContent = `${svix-id}.${svix-timestamp}.${raw body}`
//     secret        = base64decode(whsec_XXXX  ->  XXXX)
//     expected      = base64(HMAC_SHA256(signedContent, secret))
//
// The `svix-signature` header is a space-delimited list of `v1,<sig>` pairs —
// plural because Svix rotates secrets by signing with both for a window. Any
// one matching is a pass.
//
// Two things this must get right and which are easy to get wrong:
//
//   1. The raw body. JSON.stringify(req.body) is a DIFFERENT string — key
//      order, spacing and unicode escaping all vary — so a verifier built on
//      the parsed body fails every real delivery. middleware.js keeps the
//      original buffer for /webhooks/* precisely for this.
//   2. Timestamp tolerance. Without it a captured payload can be replayed
//      forever. Svix's own tolerance is five minutes; same here.

const crypto = require('crypto');

const TOLERANCE_SECONDS = 5 * 60;

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare lengths first and return the same shape either way.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {object} opts
 * @param {string} opts.secret   the whsec_... signing secret
 * @param {string} opts.rawBody  the exact request body as sent
 * @param {object} opts.headers  request headers (lowercased keys)
 * @param {number} [opts.nowSeconds] injectable for tests
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifySvixSignature({ secret, rawBody, headers, nowSeconds }) {
  if (!secret) return { ok: false, reason: 'no_signing_secret_configured' };
  if (typeof rawBody !== 'string' || !rawBody) return { ok: false, reason: 'no_raw_body' };

  const h = headers || {};
  const id = h['svix-id'] || h['webhook-id'];
  const ts = h['svix-timestamp'] || h['webhook-timestamp'];
  const sigHeader = h['svix-signature'] || h['webhook-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_svix_headers' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad_timestamp' };
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  // whsec_ prefix is a label, not part of the key material.
  const raw = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  let key;
  try {
    key = Buffer.from(raw, 'base64');
  } catch (_) {
    return { ok: false, reason: 'secret_not_base64' };
  }
  if (!key.length) return { ok: false, reason: 'secret_not_base64' };

  const signedContent = `${id}.${ts}.${rawBody}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');

  // "v1,sigA v1,sigB" — any match passes.
  for (const part of String(sigHeader).split(' ')) {
    const idx = part.indexOf(',');
    if (idx === -1) continue;
    const version = part.slice(0, idx);
    const sig = part.slice(idx + 1);
    if (version !== 'v1') continue;
    if (timingSafeEqualStr(expected, sig)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

module.exports = { verifySvixSignature, TOLERANCE_SECONDS };
