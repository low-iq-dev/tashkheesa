// tests/core/paymob-return-failure.test.js
//
// AUDIT-RETURN-2026-09-06 — a failed payment must not be reported as a success.
//
// GET /portal/patient/payment-return ignored every parameter Paymob puts on the
// browser redirect and unconditionally forwarded to /payment-success, a page
// with no failure state: "We're confirming your payment", a three-minute poll,
// then "you can safely close this page". A patient whose card was declined was
// told for three minutes that their payment was going through and then told to
// close the tab. The retry banner keyed on ?failed=1 already existed; the flag
// was emitted nowhere in src/ or public/.
//
// Two halves, both pinned here:
//   * the OUTCOME READER (pure, table-driven) — including that it never claims
//     success on a shape it does not recognise, and that it is never allowed to
//     mark anything paid;
//   * the ROUTE — that 'failed' lands on the pay page with the flag, that the
//     pay page renders the banner, and that the timeout state offers a retry.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n↩️  Paymob return — a declined card reads as declined\n');

const ROOT = path.join(__dirname, '..', '..');
const { readPaymobReturnOutcome } = require('../../src/routes/payments');

// ── 1. The outcome reader ──────────────────────────────────────────────────
// Query-string values are STRINGS ('true'/'false'), never booleans — reading
// them as truthy JS is its own classic way to turn 'false' into success.
try {
  expect(typeof readPaymobReturnOutcome === 'function',
    'routes/payments must export readPaymobReturnOutcome');

  const cases = [
    // [query, expected, why]
    [{ success: 'true' },                          'success', 'an approved card'],
    [{ success: 'false' },                         'failed',  'THE BUG: a declined card'],
    [{ success: 'false', pending: 'true' },        'pending', '3DS still in flight — Paymob sends success=false WITH pending=true; calling that a failure would panic a patient mid-authentication'],
    [{ pending: 'true' },                          'pending', 'explicitly pending'],
    [{ success: 'true', error_occured: 'true' },   'failed',  'error_occured outranks success'],
    [{ success: 'true', is_refunded: 'true' },     'failed',  'a refund is money going the other way, whatever success says'],
    [{ success: 'true', is_voided: 'true' },       'failed',  'a void is not a payment'],
    [{ txn_response_code: 'APPROVED' },            'unknown', 'no success flag: an approval code alone must not claim success'],
    [{ txn_response_code: '00' },                  'unknown', "Paymob's numeric approval code, same rule"],
    [{ txn_response_code: '11' },                  'failed',  'a decline code with no success flag is still a decline'],
    [{ txn_response_code: 'DECLINED' },            'failed',  'ditto, textual'],
    [{},                                           'unknown', 'no parameters at all'],
    [{ success: 'yes' },                           'unknown', 'an unrecognised value must not be read as either answer'],
    [{ success: 'TRUE' },                          'success', 'case-insensitive'],
    [{ success: ' false ' },                       'failed',  'whitespace-tolerant']
  ];
  cases.forEach(function (c) {
    const got = readPaymobReturnOutcome(c[0]);
    expect(got === c[1],
      JSON.stringify(c[0]) + ' → expected ' + c[1] + ', got ' + got + ' (' + c[2] + ')');
  });
  expect(readPaymobReturnOutcome(undefined) === 'unknown', 'a missing query object must not throw');
  t.pass('outcome reader: ' + cases.length + ' shapes, and an unrecognised one never claims success');
} catch (e) { t.fail('outcome reader', e); }

// ── 2. The route branches on it ────────────────────────────────────────────
try {
  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  const start = PATIENT.indexOf("router.get('/portal/patient/payment-return'");
  expect(start !== -1, 'GET /portal/patient/payment-return must exist');
  const handler = PATIENT.slice(start, PATIENT.indexOf("router.get('/portal/patient/orders/:id/payment-success'", start));
  expect(handler.length > 200, 'failed to slice the handler — this guard would pass over nothing');

  expect(/readPaymobReturnOutcome\s*\(/.test(handler),
    'the handler must actually read the return parameters; it used to ignore all of them');
  expect(/'failed'/.test(handler),
    'the handler must branch on a failed outcome');
  expect(/failed=1/.test(handler),
    "the failed branch must emit ?failed=1 — the flag the retry banner keys on, which was " +
    'emitted nowhere in src/ or public/');
  expect(/\/portal\/patient\/pay\//.test(handler),
    'a failed return goes to the PAY page: by this point the case is SUBMITTED, and the wizard ' +
    'refuses to load anything but a DRAFT, so a wizard redirect would bounce to /dashboard');

  // The display/money boundary. This handler may never write payment state.
  expect(!/UPDATE\s+orders/i.test(handler) && !/markCasePaid/.test(handler),
    'the redirect is attacker-controlled: it may choose a PAGE and nothing else. ' +
    'POST /payments/callback remains the only writer of payment state');
  t.pass('failed returns route to the pay page with ?failed=1, and the handler writes no payment state');
} catch (e) { t.fail('payment-return route', e); }

// ── 3. The pay page renders the banner ─────────────────────────────────────
try {
  const PAY_VIEW = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_payment_required.ejs'), 'utf8');
  expect(/paymentFailed/.test(PAY_VIEW),
    'patient_payment_required must render the failure banner; emitting ?failed=1 at a page that ' +
    'ignores it would be the same dead end with an extra query parameter');
  expect(/didn’t go through|didn't go through/.test(PAY_VIEW),
    'the banner must carry the "your previous payment didn’t go through" copy');
  expect(/still saved|محفوظة/.test(PAY_VIEW),
    'the banner must say the case is still saved — the single fact that stops a patient starting over');

  const PATIENT = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8'));
  expect(/paymentFailed:\s*!!\(req\.query && req\.query\.failed\)/.test(PATIENT),
    'the pay route must pass paymentFailed from the query string');
  t.pass('the pay page reads ?failed=1 and shows the retry banner');
} catch (e) { t.fail('pay page banner', e); }

// ── 4. The success page is no longer a dead end ────────────────────────────
try {
  const SUCCESS = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_payment_success.ejs'), 'utf8');
  expect(/confirm-retry/.test(SUCCESS),
    'the 3-minute timeout state must offer a retry action');
  expect(/\/portal\/patient\/pay\//.test(SUCCESS),
    'the retry must link back to the pay page');
  expect(!/You can safely close this page/.test(SUCCESS),
    '"you can safely close this page" was the terminal message on a screen a patient reaches ' +
    'when their payment FAILED — it told them to walk away from an unpaid case');
  // Hidden until the poller gives up: a retry shown during confirmation invites
  // a second charge on a payment that is about to succeed.
  const retryIdx = SUCCESS.indexOf('id="confirm-retry"');
  expect(/hidden/.test(SUCCESS.slice(retryIdx, retryIdx + 120)),
    'the retry must start hidden and be revealed only once polling stops');
  t.pass('timeout state offers a retry, revealed only after polling gives up');
} catch (e) { t.fail('success page retry', e); }
