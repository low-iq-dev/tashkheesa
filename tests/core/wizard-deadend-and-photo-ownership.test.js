// tests/core/wizard-deadend-and-photo-ownership.test.js
//
// A12 (AUDIT 2026-09-09) — two of the three A12 fixes:
//   (b) GET /portal/doctor/profile/photo/:id had no ownership check, so any
//       authenticated doctor could pull a signed URL for any other doctor's
//       photo by id. The sibling signature route already had the check; copy it.
//   (a) Wizard steps 4 and 5 redirected back with ?err=unsupported_currency /
//       submit_failed but nothing built an error block, so the step re-rendered
//       with no message — a silent dead end. The view now maps those codes to
//       the per-step error block, bilingually.
//
// Source-grep. Verified NEGATIVELY: removing the photo ownership check fails its
// assertion; removing the queryErr map fails the wizard assertion.
//
// NOT covered here (see the audit doc): (c) the English-only failure strings in
// server.js / auth.js / middleware.js — several sit inside the /files/:id
// authorization path (a DO-NOT-TOUCH zone), so that sub-item is noted, not done.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🚪 A12 — no photo leak, no silent wizard dead ends\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// (b) photo ownership
const doc = code('src/routes/doctor.js');
check('(b) the profile-photo route enforces ownership like the signature route', () => {
  const start = doc.indexOf("router.get('/portal/doctor/profile/photo/:id'");
  if (start < 0) return 'photo route not found';
  const body = doc.slice(start, start + 700);
  if (!/String\(req\.params\.id\) !== String\(req\.user\.id\)/.test(body)) return 'no ownership check';
  if (!/403/.test(body)) return 'ownership check does not 403';
});
check('(b) the signature route still has its ownership check (parity)', () => {
  const start = doc.indexOf("router.get('/portal/doctor/profile/signature/:id'");
  const body = start >= 0 ? doc.slice(start, start + 700) : '';
  if (!/String\(req\.params\.id\) !== String\(req\.user\.id\)/.test(body)) return 'signature route lost its check';
});

// (a) wizard error blocks
const view = code('src/views/patient_new_case.ejs');
check('(a) the wizard maps step-4/5 failure codes to a rendered error', () => {
  if (!/unsupported_currency:/.test(view)) return 'unsupported_currency has no error block';
  if (!/submit_failed:/.test(view)) return 'submit_failed has no error block';
  // Both must be bilingual (carry an Arabic branch via __isAr) and tie to a step.
  if (!/step:\s*4/.test(view) || !/step:\s*5/.test(view)) return 'error codes not tied to steps 4/5';
  if (!/__isAr[\s\S]{0,200}unsupported_currency|unsupported_currency[\s\S]{0,200}__isAr/.test(view)) {
    return 'the mapped errors are not bilingual';
  }
});
check('(a) the per-step error block still renders __error for the current step', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/views/patient_new_case.ejs'), 'utf8');
  if (!/__error && __error\.step === __step/.test(raw)) return 'the step error block was lost';
});
