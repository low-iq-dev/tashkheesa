// tests/notifications/payment-reminder-link.test.js
//
// Patient recovery follow-up (2 Nov 2026) — the payment-reminder WhatsApp
// carried a bare path. orders.payment_link holds '/portal/patient/pay/<id>'
// (routes/patient.js), the worker hands it to the composer as `link`, and the
// body that went to the Mac mini on 14 Oct read "Whenever you're ready:
// /portal/patient/pay/fb92814a-…" — nothing a phone can open. The composer now
// makes every link absolute (notify/case_url.absoluteAppUrl); the email's
// paymentUrl goes through the same helper. The end-to-end check, with the
// body the fake mini receives, is scenario 2 of whatsapp-single-attempt.test.js.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
};
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

delete process.env.APP_URL; // the production default, https://tashkheesa.com
const { getOpenClawBody } = require('../../src/notify/openclawTemplates');
const { absoluteAppUrl } = require('../../src/notify/case_url');

const ORDER = 'fb92814a-d2b3-426d-b259-e6456df1e1a8';
const BARE = '/portal/patient/pay/' + ORDER;
const FULL = 'https://tashkheesa.com' + BARE;

console.log('\n🔗  payment-reminder links are absolute\n');

check('every payment-reminder body, EN and AR, carries the absolute pay link — never the bare path', () => {
  for (const level of ['30m', '6h', '24h']) {
    for (const lang of ['en', 'ar']) {
      const body = getOpenClawBody('payment_reminder_' + level, lang, { caseReference: 'TSH-2026-000020', link: BARE, hoursRemaining: 144 }, { orderId: ORDER });
      assert.ok(body.indexOf(FULL) !== -1, level + ' ' + lang + ': ' + body);
      assert.ok(!/(^|\s)\/portal\//.test(body), level + ' ' + lang + ' still has a bare path: ' + body);
    }
  }
});

check('an absolute link is left exactly as it was; no link falls back to the patient\'s order page', () => {
  const kashier = 'https://checkout.kashier.io/?merchantId=x&orderId=' + ORDER;
  assert.ok(getOpenClawBody('payment_reminder_30m', 'en', { caseReference: 'TSH-1', link: kashier }).indexOf(kashier) !== -1);
  const none = getOpenClawBody('payment_reminder_30m', 'en', { caseReference: 'TSH-1' }, { orderId: ORDER });
  assert.ok(none.indexOf('https://tashkheesa.com/portal/patient/orders/' + ORDER) !== -1, none);
});

check('absoluteAppUrl: a path gets the base; absolute, empty and protocol-relative are untouched', () => {
  assert.strictEqual(absoluteAppUrl(BARE), FULL);
  assert.strictEqual(absoluteAppUrl(BARE, 'https://staging.tashkheesa.com/'), 'https://staging.tashkheesa.com' + BARE);
  assert.strictEqual(absoluteAppUrl(FULL), FULL);
  assert.strictEqual(absoluteAppUrl(''), '');
  assert.strictEqual(absoluteAppUrl(null), '');
  assert.strictEqual(absoluteAppUrl('//cdn.example/x'), '//cdn.example/x');
});

check('the email\'s paymentUrl goes through the same helper (the payment-reminder email button)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'notification_worker.js'), 'utf8');
  assert.ok(/paymentUrl: absoluteAppUrl\(paymentUrlResolved\),/.test(src));
});
