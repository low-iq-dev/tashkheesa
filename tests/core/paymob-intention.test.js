// tests/core/paymob-intention.test.js
//
// Unit tests for src/services/paymob.js — Intention API client.
// Mocks global.fetch so the suite runs without live Paymob credentials.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💳 paymob.createIntention (P1-PAY-1)\n');

// Required env so the module's config checks pass under test.
process.env.PAYMOB_MODE = 'test';
process.env.PAYMOB_SECRET_KEY = 'test-secret-key';
process.env.PAYMOB_PUBLIC_KEY = 'pk_test_public';
process.env.PAYMOB_CARD_INTEGRATION_ID = '12345';
process.env.PAYMOB_NOTIFICATION_URL = 'https://test.example.com/payments/callback';

const paymob = require('../../src/services/paymob');

const VALID_PATIENT = {
  name: 'Ahmed Hassan',
  email: 'ahmed@example.com',
  phone: '+201234567890',
  country: 'EG'
};

const REDIRECTION = 'https://test.example.com/portal/patient/payment-return';

// Stash + restore fetch so each test gets a fresh impl.
const _origFetch = global.fetch;
function setMockFetch(impl) { global.fetch = impl; }
function restoreFetch() { global.fetch = _origFetch; }

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(body)); }
  });
}

// ── _splitName ──────────────────────────────────────────────────
try {
  assert.deepStrictEqual(paymob._splitName(''),         { first: 'NA', last: 'NA' });
  assert.deepStrictEqual(paymob._splitName('Ahmed'),    { first: 'Ahmed', last: 'Ahmed' });
  assert.deepStrictEqual(paymob._splitName('A B'),      { first: 'A', last: 'B' });
  assert.deepStrictEqual(paymob._splitName('A B C D'),  { first: 'A', last: 'B C D' });
  t.pass('_splitName handles 0/1/2/3+ word inputs');
} catch (e) { t.fail('_splitName', e); }

// ── _validatePatient ────────────────────────────────────────────
try {
  assert.throws(() => paymob._validatePatient(null),
    e => e.code === 'PATIENT_PROFILE_INCOMPLETE' && e.fields.indexOf('patient') !== -1);
  assert.throws(() => paymob._validatePatient({}),
    e => e.code === 'PATIENT_PROFILE_INCOMPLETE' && e.fields.length === 3); // name, email, phone
  assert.throws(() => paymob._validatePatient({ name: 'A', email: 'not-an-email', phone: '+201234567890' }),
    e => e.fields.indexOf('email_format') !== -1);
  assert.throws(() => paymob._validatePatient({ name: 'A', email: 'a@b.co', phone: '01234567890' }),
    e => e.fields.indexOf('phone_format') !== -1);
  paymob._validatePatient(VALID_PATIENT); // must NOT throw
  t.pass('_validatePatient catches null, missing fields, bad email, bad phone (E.164)');
} catch (e) { t.fail('_validatePatient', e); }

// ── _assertTestMode ─────────────────────────────────────────────
try {
  process.env.PAYMOB_MODE = 'test';
  paymob._assertTestMode(); // ok
  process.env.PAYMOB_MODE = 'live';
  assert.throws(() => paymob._assertTestMode(), e => e.code === 'PAYMOB_MODE_NOT_TEST');
  process.env.PAYMOB_MODE = ''; // empty defaults to test
  paymob._assertTestMode(); // ok
  process.env.PAYMOB_MODE = 'test';
  t.pass('_assertTestMode passes test/empty, throws on live');
} catch (e) {
  process.env.PAYMOB_MODE = 'test';
  t.fail('_assertTestMode', e);
}

// ── createIntention happy path ──────────────────────────────────
(async function happyPath() {
  let captured = null;
  setMockFetch(function (url, opts) {
    captured = { url: url, opts: opts };
    return jsonResponse(200, {
      id: 'int_abc_999',
      client_secret: 'cs_test_xyz',
      payment_keys: [],
      intention_detail: {}
    });
  });

  try {
    const result = await paymob.createIntention({
      orderId: 'order-1',
      amountCents: 50000,
      currency: 'EGP',
      patient: VALID_PATIENT,
      redirectionUrl: REDIRECTION
    });
    assert.strictEqual(result.intentionId, 'int_abc_999');
    assert.strictEqual(result.clientSecret, 'cs_test_xyz');
    assert.ok(result.checkoutUrl.indexOf('https://accept.paymob.com/unifiedcheckout/') === 0);
    assert.ok(result.checkoutUrl.indexOf('publicKey=pk_test_public') !== -1);
    assert.ok(result.checkoutUrl.indexOf('clientSecret=cs_test_xyz') !== -1);

    assert.strictEqual(captured.url, 'https://accept.paymob.com/v1/intention/');
    assert.strictEqual(captured.opts.method, 'POST');
    assert.strictEqual(captured.opts.headers['Authorization'], 'Token test-secret-key');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.amount, 50000);
    assert.strictEqual(body.currency, 'EGP');
    assert.deepStrictEqual(body.payment_methods, [12345]);
    assert.strictEqual(body.special_reference, 'order-1');
    assert.strictEqual(body.notification_url, 'https://test.example.com/payments/callback');
    assert.strictEqual(body.redirection_url, REDIRECTION);
    assert.strictEqual(body.billing_data.email, VALID_PATIENT.email);
    assert.strictEqual(body.billing_data.phone_number, VALID_PATIENT.phone);
    assert.strictEqual(body.billing_data.first_name, 'Ahmed');
    assert.strictEqual(body.billing_data.last_name, 'Hassan');
    assert.strictEqual(body.billing_data.country, 'EG');
    t.pass('createIntention happy path: correct request shape + checkoutUrl returned');
  } catch (e) { t.fail('createIntention happy path', e); }
  finally { restoreFetch(); }

  // ── PATIENT_PROFILE_INCOMPLETE thrown BEFORE any network call ───
  let networkHit = false;
  setMockFetch(function () { networkHit = true; return jsonResponse(200, {}); });
  try {
    await paymob.createIntention({
      orderId: 'order-2', amountCents: 50000, currency: 'EGP',
      patient: { name: '', email: '', phone: '' },
      redirectionUrl: REDIRECTION
    });
    t.fail('PII gate should have thrown', new Error('did not throw'));
  } catch (e) {
    if (e.code === 'PATIENT_PROFILE_INCOMPLETE' && !networkHit) {
      t.pass('PII gate throws PATIENT_PROFILE_INCOMPLETE before any network call');
    } else {
      t.fail('PII gate', e);
    }
  } finally { restoreFetch(); }

  // ── HTTP error mapping ──────────────────────────────────────────
  setMockFetch(function () { return jsonResponse(400, { detail: 'Bad request' }); });
  try {
    await paymob.createIntention({
      orderId: 'order-3', amountCents: 50000, currency: 'EGP',
      patient: VALID_PATIENT, redirectionUrl: REDIRECTION
    });
    t.fail('HTTP 400 should throw', new Error('did not throw'));
  } catch (e) {
    if (e.code === 'PAYMOB_HTTP_ERROR' && e.status === 400) {
      t.pass('HTTP non-2xx → PAYMOB_HTTP_ERROR with status preserved');
    } else { t.fail('HTTP error', e); }
  } finally { restoreFetch(); }

  // ── Malformed response (missing client_secret) ─────────────────
  setMockFetch(function () { return jsonResponse(200, { id: 'int_only' }); });
  try {
    await paymob.createIntention({
      orderId: 'order-4', amountCents: 50000, currency: 'EGP',
      patient: VALID_PATIENT, redirectionUrl: REDIRECTION
    });
    t.fail('malformed should throw', new Error('did not throw'));
  } catch (e) {
    if (e.code === 'PAYMOB_MALFORMED_RESPONSE') {
      t.pass('200 missing client_secret → PAYMOB_MALFORMED_RESPONSE');
    } else { t.fail('malformed response', e); }
  } finally { restoreFetch(); }

  // ── MODE=live runtime guard ─────────────────────────────────────
  process.env.PAYMOB_MODE = 'live';
  try {
    await paymob.createIntention({
      orderId: 'order-5', amountCents: 50000, currency: 'EGP',
      patient: VALID_PATIENT, redirectionUrl: REDIRECTION
    });
    t.fail('MODE=live should throw', new Error('did not throw'));
  } catch (e) {
    if (e.code === 'PAYMOB_MODE_NOT_TEST') {
      t.pass('MODE=live throws PAYMOB_MODE_NOT_TEST (hard gate)');
    } else { t.fail('mode guard', e); }
  } finally { process.env.PAYMOB_MODE = 'test'; }

  // ── Timeout: fetch hangs forever, AbortController fires ────────
  // Set a short timeout for the test by spying on the abort signal.
  setMockFetch(function (_url, opts) {
    return new Promise((_resolve, reject) => {
      // Mimic real fetch: when AbortController aborts, throw AbortError.
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
      // Never resolve.
    });
  });
  try {
    // The module's internal timeout is 8s. We don't want to wait that
    // long in a unit test, so we trigger the abort manually via a
    // lower-effort simulation: monkey-patch AbortController to abort
    // synchronously after construction.
    const OrigAC = global.AbortController;
    global.AbortController = function () {
      const ac = new OrigAC();
      // Fire abort on next tick so the await fetch starts before abort
      setImmediate(() => ac.abort());
      return ac;
    };
    try {
      await paymob.createIntention({
        orderId: 'order-6', amountCents: 50000, currency: 'EGP',
        patient: VALID_PATIENT, redirectionUrl: REDIRECTION
      });
      t.fail('timeout should throw', new Error('did not throw'));
    } catch (e) {
      if (e.code === 'PAYMOB_TIMEOUT') {
        t.pass('fetch abort → PAYMOB_TIMEOUT mapped');
      } else { t.fail('timeout mapping', e); }
    } finally { global.AbortController = OrigAC; }
  } finally { restoreFetch(); }
})();
