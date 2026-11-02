// tests/lint/sms-templates-fit.test.js
//
// Part B (patient recovery, 2 Nov 2026) — every SMS body fits its budget, in
// the build, before anyone pays for a third segment:
//   English  ≤ 160 characters, GSM-7 only (one character outside it — an em
//            dash, a curly quote — turns the whole message UCS-2 at 70 a
//            segment);
//   Arabic   ≤ 134 characters (two UCS-2 segments).
// Bodies are rendered with the LONGEST real values: a 15-character reference,
// a 36-character order id, a 22-character resume token, the production
// APP_URL. A body without a reference (an app draft has none until submit) is
// checked too.
//
// It also pins the allowlist (SMS is used for nothing else) and that no payload
// field other than the reference reaches a body.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
};
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

delete process.env.APP_URL; // the production default, https://tashkheesa.com
const sms = require('../../src/notify/sms_templates');

const ORDER = 'fb92814a-d2b3-426d-b259-e6456df1e1a8';
const WORST = { caseReference: 'TSH-2026-000027', resume_token: 'A'.repeat(22) };
const NO_REF = { resume_token: 'A'.repeat(22) };

console.log('\n📏  SMS templates fit (Part B)\n');

check('the allowlist is exactly the Part B set (+ the Part C coverage notice)', () => {
  assert.deepStrictEqual(sms.ALLOWLIST.slice().sort(), [
    'additional_files_requested_patient', 'coverage_lead_open',
    'draft_resume_1h', 'draft_resume_24h',
    'patient_refund_approved', 'patient_refund_denied', 'patient_refund_paid',
    'payment_reminder_24h', 'payment_reminder_30m', 'payment_reminder_6h',
    'report_ready_patient',
  ]);
  assert.strictEqual(sms.renderSms('order_assigned_doctor', 'en', WORST, ORDER), null);
});

for (const template of sms.ALLOWLIST) {
  check(template + ': English ≤ 160 and GSM-7, Arabic ≤ 134, with and without a reference', () => {
    for (const payload of [WORST, NO_REF]) {
      const en = sms.renderSms(template, 'en', payload, ORDER);
      const ar = sms.renderSms(template, 'ar', payload, ORDER);
      assert.ok(en.body.length <= 160, 'EN ' + en.body.length + ': ' + en.body);
      assert.ok(sms.isGsm7(en.body), 'EN leaves GSM-7: ' + en.body);
      assert.ok(ar.body.length <= 134, 'AR ' + ar.body.length + ': ' + ar.body);
      assert.ok(/^https:\/\/tashkheesa\.com\//.test(en.link), 'absolute link: ' + en.link);
      assert.ok(en.body.indexOf(en.link) !== -1 && ar.body.indexOf(ar.link) !== -1, 'the link is in both bodies');
      assert.ok(!/undefined|null/.test(en.body + ar.body), 'no undefined/null: ' + en.body + ' | ' + ar.body);
    }
  });
}

check('nothing from the payload but the reference reaches a body (no clinical text, no names)', () => {
  const loaded = Object.assign({}, WORST, {
    clinical_question: 'CLINICAL-SENTINEL', patientName: 'NAME-SENTINEL', doctorName: 'DOCTOR-SENTINEL',
    denialReason: 'REASON-SENTINEL', specialty: 'SPECIALTY-SENTINEL', notes: 'NOTES-SENTINEL',
  });
  for (const template of sms.ALLOWLIST) {
    for (const l of ['en', 'ar']) {
      const body = sms.renderSms(template, l, loaded, ORDER).body;
      assert.ok(!/SENTINEL/.test(body), template + ' ' + l + ': ' + body);
    }
  }
});

check('isGsm7 catches the characters that would force UCS-2', () => {
  assert.strictEqual(sms.isGsm7('Tashkheesa: case TSH-1 is saved: https://x/y'), true);
  for (const bad of ['—', '’', '“', '€', 'تشخيصة']) assert.strictEqual(sms.isGsm7('a' + bad), false, bad);
});
