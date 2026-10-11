// tests/core/app-payment-return.test.js
//
// 2026-10-11 — card checkout in the mobile app's browser sheet (Part B).
//
// The app asks for a card session with `?return=app`; that session sends the
// browser to /portal/patient/payment-return/k/:id/app, whose page hands the
// patient back to the app through tashkheesa://payment-return.
//
// What must hold:
//   * the hand-back link never claims a payment succeeded, and never echoes
//     anything but a plain case id;
//   * the page is a display page: no database write, no payment_status;
//   * the existing web landing is untouched, and a caller that does not pass
//     `return=app` (the website, every installed app build) gets it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};

console.log('\n↩️  App payment return — browser-sheet hand-back\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appReturn = require('../../src/services/app_payment_return');

function test(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

const ID = '3f2b8c1e-9a4d-4c3e-8b1a-0d9e7f6a5b4c';

test('the link is the app\'s own scheme, with the case id and a returned/failed hint', () => {
  assert.strictEqual(appReturn.APP_PAYMENT_RETURN_URL, 'tashkheesa://payment-return');
  assert.strictEqual(appReturn.buildAppReturnLink(ID, false), 'tashkheesa://payment-return?status=returned&caseId=' + ID);
  assert.strictEqual(appReturn.buildAppReturnLink(ID, true), 'tashkheesa://payment-return?status=failed&caseId=' + ID);
});

test('the link NEVER says paid or success, whatever Kashier put on the return URL', () => {
  for (const q of [
    { paymentStatus: 'SUCCESS' }, { status: 'SUCCESS' }, { paymentStatus: 'PAID' },
    { paymentStatus: 'SUCCESS', signature: 'abc', merchantOrderId: 'x' }, {}, undefined,
  ]) {
    const failed = appReturn.isFailedReturn(q);
    assert.strictEqual(failed, false);
    const link = appReturn.buildAppReturnLink(ID, failed);
    assert.ok(/[?&]status=returned(&|$)/.test(link), link);
    assert.ok(!/paid|success/i.test(link), 'the link must carry no success claim: ' + link);
  }
});

test('failure markers are read exactly as the web landing reads them', () => {
  for (const s of ['FAILURE', 'failed', 'Cancelled', 'CANCELED']) {
    assert.strictEqual(appReturn.isFailedReturn({ paymentStatus: s }), true, s);
    assert.strictEqual(appReturn.isFailedReturn({ status: s }), true, s);
  }
  for (const s of ['SUCCESS', 'PENDING', '', 'DECLINED-ish']) {
    assert.strictEqual(appReturn.isFailedReturn({ paymentStatus: s }), false, s);
  }
  // …and the web route still carries the same list (kept in step by hand).
  const web = read('src/routes/patient.js');
  assert.ok(web.includes("kStatus === 'FAILURE' || kStatus === 'FAILED' || kStatus === 'CANCELLED' || kStatus === 'CANCELED'"));
});

test('only a plain id is echoed into the link', () => {
  for (const bad of ['../../admin', 'a b', '<script>alert(1)</script>', '"onload="x', 'x'.repeat(65), '', null, undefined, 'id&status=paid']) {
    const link = appReturn.buildAppReturnLink(bad, false);
    assert.strictEqual(link, 'tashkheesa://payment-return?status=returned', 'leaked: ' + link);
  }
});

test('the page: three ways back (refresh, script, button), noindex, right language and direction', () => {
  const en = appReturn.renderAppReturnPage({ orderId: ID, failed: false, isAr: false, nonce: 'abc123==' });
  const link = 'tashkheesa://payment-return?status=returned&amp;caseId=' + ID;
  assert.ok(en.includes('<meta http-equiv="refresh" content="0;url=' + link + '">'));
  assert.ok(en.includes('<a id="back" href="' + link + '"'));
  assert.ok(en.includes('<script nonce="abc123==">'));
  assert.ok(en.includes('window.location.replace('));
  assert.ok(en.includes('<meta name="robots" content="noindex">'));
  assert.ok(en.includes('<html lang="en" dir="ltr">'));
  assert.ok(en.includes('Return to the app'));

  const ar = appReturn.renderAppReturnPage({ orderId: ID, failed: true, isAr: true });
  assert.ok(ar.includes('<html lang="ar" dir="rtl">'));
  assert.ok(ar.includes('ارجع للتطبيق'));
  assert.ok(ar.includes('status=failed'));
  assert.ok(ar.includes('<script>'), 'no nonce given → a plain script tag, never nonce=""');
});

test('the page cannot be made to carry markup through the id or the nonce', () => {
  const html = appReturn.renderAppReturnPage({
    orderId: '"><img src=x onerror=alert(1)>', failed: false, isAr: false, nonce: '"><script>alert(2)</script>',
  });
  assert.ok(!/<img/i.test(html));
  assert.ok(!/alert\(/.test(html));
  assert.strictEqual((html.match(/<script/g) || []).length, 1);
});

test('the page says nothing about money having moved', () => {
  for (const failed of [true, false]) {
    for (const isAr of [true, false]) {
      const html = appReturn.renderAppReturnPage({ orderId: ID, failed, isAr });
      assert.ok(!/charged|خصم|refund|استرداد|paid successfully|تم الدفع/i.test(html), 'money claim on the hand-back page');
    }
  }
});

// ── wiring ────────────────────────────────────────────────────────────────
const patient = read('src/routes/patient.js');
const appRouteAt = patient.indexOf("router.get('/portal/patient/payment-return/k/:id/app'");
const webRouteAt = patient.indexOf("router.get('/portal/patient/payment-return/k/:id',");
const appRoute = patient.slice(appRouteAt, patient.indexOf('// GET /portal/patient/orders/:id/payment-success'));

test('the app route exists beside the web route, which is still there', () => {
  assert.ok(webRouteAt > 0, 'web Kashier return route missing');
  assert.ok(appRouteAt > webRouteAt, 'app hand-back route missing');
});

test('the app route is display-only: no write, no payment_status, no mark-paid', () => {
  assert.ok(!/\bexecute\(|withTransaction\(|UPDATE |INSERT |markCasePaid|payment_status/.test(appRoute),
    'the hand-back route must not touch payment state');
  assert.ok(/SELECT id FROM orders_active WHERE id = \$1 AND patient_id = \$2/.test(appRoute), 'ownership check missing');
});

test('a web session that owns the order gets the web behaviour from the app route too', () => {
  assert.ok(appRoute.includes("res.redirect('/portal/patient/pay/' + encodeURIComponent(orderId) + '?failed=1')"));
  assert.ok(appRoute.includes("res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success')"));
  assert.ok(appRoute.indexOf('if (owned) {') < appRoute.indexOf('renderAppReturnPage('), 'the web branch must be decided before the hand-back page');
});

test('the web landing page is byte-for-byte what it was (no hand-back in it)', () => {
  const webRoute = patient.slice(webRouteAt, patient.indexOf('// GET /portal/patient/payment-return/k/:id/app'));
  assert.ok(!/tashkheesa:\/\/|app_payment_return/.test(webRoute), 'the web landing must not hand back to the app');
  assert.ok(webRoute.includes("(isAr ? 'حسابي' : 'My account')"));
});

test('GET /cases/:id/payment passes return=app through, and only "app"', () => {
  const cases = read('src/routes/api/cases.js');
  assert.ok(/returnTo: String\(\(req\.query && req\.query\.return\) \|\| ''\)\.toLowerCase\(\) === 'app' \? 'app' : 'web'/.test(cases));
  const mint = read('src/services/paymob_intention.js');
  assert.ok(/async function ensurePaymentLinkForOrder\(\{ orderId, patientId, redirectionUrl, returnTo \}\)/.test(mint));
  assert.ok(/returnTo: returnTo === 'app' \? 'app' : 'web'/.test(mint));
});

test('the web Pay button never asks for an app-return session', () => {
  const pay = read('src/routes/payments.js');
  const at = pay.indexOf("source: 'web_pay_page'");
  assert.ok(at > 0);
  const call = pay.slice(pay.lastIndexOf('ensureKashierCheckout({', at), pay.indexOf('});', at));
  assert.ok(!/returnTo/.test(call), 'routes/payments.js must not pass returnTo');
});
