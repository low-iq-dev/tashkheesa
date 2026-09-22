'use strict';
// tests/services/kashier-signature.test.js
//
// 2026-09-22
//
// Kashier signs its webhooks differently from Paymob. Paymob signs a fixed
// list of 19 fields, so a forged payload cannot change what was covered.
// Kashier lets the PAYLOAD declare which fields were signed, in
// data.signatureKeys.
//
// That means a correct HMAC is not, by itself, proof of anything. Forge a
// webhook with signatureKeys: [] and you sign the empty string — a signature
// that verifies perfectly while the amount, the currency and the order it
// belongs to are all unsigned. Same again with signatureKeys: ['transactionId']:
// sign one harmless field, forge the amount to 1.00, collect a free report.
//
// src/kashier-signature.js therefore requires the critical fields to appear
// in signatureKeys before it will accept the event. These tests exist so a
// future refactor cannot quietly drop that check — which would look like a
// passing signature and read, in the logs, like a real payment.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🔏 kashier webhook signature verification\n');

const k = require('../../src/kashier-signature.js');
const API_KEY = 'test_payment_api_key';

function sign(subject, key) {
  return crypto.createHmac('sha256', key || API_KEY).update(subject, 'utf8').digest('hex');
}

function goodData(over) {
  return Object.assign({
    amount: '1600.00',
    currency: 'EGP',
    merchantOrderId: 'abc-123',
    status: 'SUCCESS',
    transactionId: 'tx_1',
    signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status']
  }, over || {});
}

function check(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── the happy path ─────────────────────────────────────────────────────────

check('accepts a correctly signed webhook', () => {
  const data = goodData();
  const sig = sign(k.buildSignatureString(data, data.signatureKeys));
  const r = k.verifyKashierSignature({ event: 'pay', data }, sig, API_KEY);
  assert(r.ok === true, 'expected ok, got ' + r.reason);
});

check('signature subject is alphabetical query-string form', () => {
  const data = goodData();
  const s = k.buildSignatureString(data, ['status', 'amount', 'merchantOrderId', 'currency']);
  assert(s === 'amount=1600.00&currency=EGP&merchantOrderId=abc-123&status=SUCCESS', 'got: ' + s);
});

// ── forgery: the attacker controls signatureKeys ───────────────────────────

check('rejects an empty signatureKeys array (signs nothing)', () => {
  const data = goodData({ signatureKeys: [], amount: '1.00' });
  const r = k.verifyKashierSignature({ event: 'pay', data }, sign(''), API_KEY);
  assert(r.ok === false, 'an empty key list must never verify');
  assert(r.reason === 'empty_signature_keys', 'got: ' + r.reason);
});

check('rejects a payload that signs only harmless fields', () => {
  const data = goodData({ signatureKeys: ['transactionId'], amount: '1.00' });
  const r = k.verifyKashierSignature({ event: 'pay', data }, sign('transactionId=tx_1'), API_KEY);
  assert(r.ok === false, 'a partial key list must never verify');
  assert(/unsigned_critical_fields/.test(r.reason), 'got: ' + r.reason);
});

k.REQUIRED_SIGNED_FIELDS.forEach((field) => {
  check('rejects when "' + field + '" is left out of signatureKeys', () => {
    const keys = k.REQUIRED_SIGNED_FIELDS.filter((f) => f !== field);
    const data = goodData({ signatureKeys: keys });
    const r = k.verifyKashierSignature({ event: 'pay', data }, sign(k.buildSignatureString(data, keys)), API_KEY);
    assert(r.ok === false, field + ' must be covered by the signature');
    assert(r.reason.indexOf(field) !== -1, 'reason should name it; got: ' + r.reason);
  });
});

// ── ordinary rejections ────────────────────────────────────────────────────

check('rejects a wrong signature', () => {
  const data = goodData();
  const r = k.verifyKashierSignature({ event: 'pay', data }, 'deadbeef', API_KEY);
  assert(r.ok === false && r.reason === 'signature_mismatch', 'got: ' + r.reason);
});

check('rejects a signature made with the wrong key', () => {
  const data = goodData();
  const sig = sign(k.buildSignatureString(data, data.signatureKeys), 'someone_elses_key');
  const r = k.verifyKashierSignature({ event: 'pay', data }, sig, API_KEY);
  assert(r.ok === false && r.reason === 'signature_mismatch', 'got: ' + r.reason);
});

check('rejects a missing signature header', () => {
  const data = goodData();
  const r = k.verifyKashierSignature({ event: 'pay', data }, null, API_KEY);
  assert(r.ok === false && r.reason === 'missing_signature_header', 'got: ' + r.reason);
});

check('rejects when no API key is configured', () => {
  const data = goodData();
  const r = k.verifyKashierSignature({ event: 'pay', data }, sign('x'), '');
  assert(r.ok === false && r.reason === 'no_api_key_configured', 'got: ' + r.reason);
});

check('rejects a malformed payload without throwing', () => {
  [null, undefined, {}, { event: 'pay' }, { event: 'pay', data: 'nope' }].forEach((b) => {
    const r = k.verifyKashierSignature(b, sign('x'), API_KEY);
    assert(r.ok === false, 'malformed payload must not verify');
  });
});

check('uses a timing-safe comparison', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/kashier-signature.js'), 'utf8');
  assert(/timingSafeEqual/.test(src), 'signature comparison must use crypto.timingSafeEqual');
  assert(!/expected\s*===\s*headerSig/.test(src), 'must not compare signatures with ===');
});

check('the required-fields list still covers what we act on', () => {
  ['amount', 'currency', 'merchantOrderId', 'status'].forEach((f) => {
    assert(k.REQUIRED_SIGNED_FIELDS.indexOf(f) !== -1,
      f + ' was removed from REQUIRED_SIGNED_FIELDS — read the note in kashier-signature.js before doing that');
  });
});
