// tests/core/paymob-hmac.test.js
//
// Unit tests for src/paymob-hmac.js — the Paymob HMAC-SHA512 verifier.
//
// History:
//   The 2 stub negative tests previously lived in tests/pg/core.test.js
//   (null-secret, missing-param). They moved here as part of P1-PAY-1
//   commit 6 to give Paymob coverage its own test file. The same 2
//   assertions now live below alongside positive + tampered cases.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const crypto = require('crypto');
const { verifyPaymobHmac, buildHmacString } = require('../../src/paymob-hmac');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔐 paymob-hmac verifier (P1-PAY-1)\n');

// ── Negative: missing signature param ──────────────────────────────
// Migrated from tests/pg/core.test.js — both stub assertions.
try {
  const r = verifyPaymobHmac({ body: {}, headers: {}, query: {} }, 'any-secret');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing_hmac_param');
  t.pass('missing ?hmac= query param → ok=false missing_hmac_param');
} catch (e) { t.fail('missing param', e); }

try {
  // null secret crashes inside crypto.createHmac, falls through to
  // the catch in verifyPaymobHmac → reason='hmac_error'. (Pre-existing
  // behavior; kept asserted to lock it down.)
  const r = verifyPaymobHmac({ body: { obj: {} }, headers: {}, query: { hmac: 'any' } }, null);
  assert.strictEqual(r.ok, false);
  t.pass('null secret with body.obj → ok=false (caught error)');
} catch (e) { t.fail('null secret', e); }

// ── Positive: valid signature over all 19 fields ───────────────────
// Build a representative Paymob transaction object, sign it with a
// known secret using the documented 19-field concatenation, and verify
// the round-trip succeeds.
const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
const obj = {
  amount_cents: 50000,
  created_at: '2026-05-05T10:00:00.000Z',
  currency: 'EGP',
  error_occured: false,
  has_parent_transaction: false,
  id: 12345,
  integration_id: 9999,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: false,
  is_voided: false,
  order: { id: 'ord-abc-123' },
  owner: 1,
  pending: false,
  source_data: { pan: '4111', sub_type: 'Visa', type: 'card' },
  success: true
};
const subject = buildHmacString(obj);
const goodHmac = crypto.createHmac('sha512', SECRET).update(subject, 'utf8').digest('hex');

try {
  const r = verifyPaymobHmac(
    { body: { obj: obj }, headers: {}, query: { hmac: goodHmac } },
    SECRET
  );
  assert.strictEqual(r.ok, true);
  t.pass('valid signature over all 19 fields → ok=true');
} catch (e) { t.fail('valid signature', e); }

// ── Tampered field: changing amount_cents must invalidate ──────────
try {
  const tampered = Object.assign({}, obj, { amount_cents: 99999 });
  const r = verifyPaymobHmac(
    { body: { obj: tampered }, headers: {}, query: { hmac: goodHmac } },
    SECRET
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hmac_mismatch');
  t.pass('tampered amount_cents → ok=false hmac_mismatch');
} catch (e) { t.fail('tampered field', e); }

// ── Tampered signature: flipping bytes must invalidate ─────────────
try {
  const badHmac = goodHmac.slice(0, -2) + 'aa';
  const r = verifyPaymobHmac(
    { body: { obj: obj }, headers: {}, query: { hmac: badHmac } },
    SECRET
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hmac_mismatch');
  t.pass('tampered hmac signature → ok=false hmac_mismatch');
} catch (e) { t.fail('tampered hmac', e); }

// ── Wrong secret: same payload, different secret → mismatch ────────
try {
  const r = verifyPaymobHmac(
    { body: { obj: obj }, headers: {}, query: { hmac: goodHmac } },
    'a-different-secret'
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hmac_mismatch');
  t.pass('wrong secret → ok=false hmac_mismatch');
} catch (e) { t.fail('wrong secret', e); }

// ── Length-mismatch path (timing-safe equal pre-check) ─────────────
// The verifier short-circuits before timingSafeEqual when lengths
// differ — protects against panics on Buffer comparison.
try {
  const r = verifyPaymobHmac(
    { body: { obj: obj }, headers: {}, query: { hmac: 'short' } },
    SECRET
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hmac_mismatch');
  t.pass('signature length mismatch → ok=false hmac_mismatch (no crash)');
} catch (e) { t.fail('length mismatch', e); }
