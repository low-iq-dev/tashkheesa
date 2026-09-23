// tests/notifications/case-url-audience.test.js
//
// Patient emails (patient-refund-*, patient sla-reminder)
// render {{caseUrl}} but no caller passes one, so the worker's fallback decides.
// That fallback pointed every recipient at the DOCTOR case page. It is now
// chosen by the recipient's role.

'use strict';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔗 caseUrl fallback is audience-aware\n');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments } = require('../_helpers/strip-comments');
const { caseUrlForRecipient } = require('../../src/notify/case_url');

const APP = 'https://tashkheesa.com';

function check(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

check('patient recipient → absolute /portal/patient/orders/:id', () => {
  assert.strictEqual(caseUrlForRecipient('patient', 'ord-1', APP), `${APP}/portal/patient/orders/ord-1`);
  assert.strictEqual(caseUrlForRecipient('PATIENT', 'ord-1', APP + '/'), `${APP}/portal/patient/orders/ord-1`);
});

check('doctor (and any other role) keeps /portal/doctor/case/:id', () => {
  assert.strictEqual(caseUrlForRecipient('doctor', 'ord-1', APP), `${APP}/portal/doctor/case/ord-1`);
  assert.strictEqual(caseUrlForRecipient('admin', 'ord-1', APP), `${APP}/portal/doctor/case/ord-1`);
});

check('no order → empty string ({{#if caseUrl}} drops the button)', () => {
  assert.strictEqual(caseUrlForRecipient('patient', null, APP), '');
});

check('notification_worker builds caseUrl from the recipient role, not a hard-coded doctor path', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'notification_worker.js'), 'utf8'));
  assert.ok(/caseUrl:\s*data\.caseUrl\s*\|\|\s*caseUrlForRecipient\(user\.role/.test(src), 'caseUrl fallback does not use caseUrlForRecipient(user.role, …)');
  assert.ok(!/caseUrl:[^\n]*\/portal\/doctor\/case\//.test(src), 'caseUrl still hard-codes the doctor case page');
});

check('patient refund templates use {{caseUrl}} (so the fallback is what they link to)', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'templates', 'email');
  for (const lang of ['en', 'ar']) {
    for (const f of ['patient-refund-approved', 'patient-refund-denied', 'patient-refund-requested', 'patient-refund-opened-by-operator']) {
      const html = fs.readFileSync(path.join(dir, lang, f + '.hbs'), 'utf8');
      assert.ok(html.includes('{{caseUrl}}'), `${lang}/${f}.hbs no longer uses {{caseUrl}}`);
    }
  }
});
