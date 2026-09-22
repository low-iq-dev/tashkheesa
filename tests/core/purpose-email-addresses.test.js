'use strict';
// tests/core/purpose-email-addresses.test.js
//
// One address per purpose (2026-09-22)
//
// Eight aliases now exist on info@tashkheesa.com, each with a Gmail filter
// putting it under its own label. That only buys anything if the product
// actually hands out the right one: a PDPL erasure request, a vulnerability
// report, a refund question and a doctor's application have different
// urgencies and different readers, and they were all arriving as "info@".
//
// These pin the routing. They are deliberately about WHERE each address is
// used rather than about the strings themselves — the failure mode worth
// catching is a future edit quietly collapsing everything back to info@.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n📬 each address is used where it belongs\n');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

const routes = read('src/routes/static-pages.js');

check('BUSINESS_INFO carries the whole address book', () => {
  for (const k of ['privacyEmail', 'supportEmail', 'billingEmail', 'legalEmail', 'doctorsEmail', 'securityEmail']) {
    if (!new RegExp(k + ":\\s*'[a-z]+@tashkheesa\\.com'").test(routes)) return k + ' is missing';
  }
  return null;
});

check('info@ is still the general address, not deleted', () => (
  /email:\s*'info@tashkheesa\.com'/.test(routes) ? null : 'the general address was removed'
));

const cases = [
  ['the privacy policy points at privacy@',        'src/views/privacy.ejs',        'privacy@tashkheesa.com'],
  ['the deletion page points at privacy@',         'src/views/delete_account_request.ejs', 'privacy@tashkheesa.com'],
  ['the terms point at legal@',                    'src/views/terms.ejs',          'legal@tashkheesa.com'],
  ['the refund policy points at billing@',         'src/views/refund_policy.ejs',  'billing@tashkheesa.com'],
  ['the delivery policy points at support@',       'src/views/delivery_policy.ejs','support@tashkheesa.com'],
  ['the patient help card points at support@',     'src/views/partials/patient/need-help-card.ejs', 'support@tashkheesa.com'],
  ['the patient profile points at support@',       'src/views/patient_profile.ejs','support@tashkheesa.com'],
];
for (const [name, file, addr] of cases) {
  check(name, () => (read(file).includes(addr) ? null : 'not found in ' + file));
}

check('a deletion request notifies privacy@, not the general inbox', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  const handler = body.slice(0, body.indexOf("router.get('/faq'"));
  if (!/PRIVACY_NOTIFY_EMAIL/.test(handler)) return 'no dedicated privacy recipient';
  if (!/'privacy@tashkheesa\.com'/.test(handler)) return 'the fallback is not privacy@';
  return null;
});

check('doctor applications notify doctors@', () => (
  /APPLICATIONS_NOTIFY_EMAIL \|\| 'doctors@tashkheesa\.com'/.test(read('src/routes/apply.js'))
    ? null : 'applications still default to the general inbox'
));

check('a patient replying to a case email reaches support@', () => (
  /SMTP_REPLY_TO_EMAIL \|\| 'support@tashkheesa\.com'/.test(read('src/services/emailService.js'))
    ? null : 'transactional reply-to still defaults to the general inbox'
));

check('the policy pages no longer fall back to the general address', () => {
  const bad = [];
  for (const f of ['src/views/privacy.ejs', 'src/views/terms.ejs',
                   'src/views/refund_policy.ejs', 'src/views/delivery_policy.ejs']) {
    if (read(f).includes('info@tashkheesa.com')) bad.push(f);
  }
  return bad.length ? 'still present in: ' + bad.join(', ') : null;
});

check('the footer, About and Contact still show the general address', () => {
  for (const f of ['src/views/partials/footer.ejs', 'src/views/about.ejs', 'src/views/contact.ejs']) {
    if (!read(f).includes('info@tashkheesa.com')) return f + ' lost the general address';
  }
  return null;
});
