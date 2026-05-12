// tests/core/theme13-wizard-coexistence.test.js
//
// Theme 13 Sub-issue B — both upload code paths must coexist in
// patient_new_case.ejs throughout the migration window. This is the
// rollback safety contract per THEME_13_R2_MIGRATION_FIX_PLAN.md §7a:
// flipping UPLOAD_R2_DIRECT_ENABLED back to 'false' must keep the legacy
// Uploadcare widget functional with zero code changes.
//
// Pure source-grep — no DB, no boot. Covers:
//   * The new R2 FormData path is wired (POST /portal/patient/files +
//     hidden file_key field).
//   * The legacy Uploadcare 3.x widget path is preserved (script tag +
//     window.UPLOADCARE_PUBLIC_KEY + hidden file_url field).
//   * The form gate accepts EITHER path being available.
//   * patient.js exposes r2DirectEnabled in the wizard locals.
//   * The /portal/patient/orders/:id/upload handler accepts both file_url
//     (legacy URL) and file_key (R2 key).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 Sub-issue B — wizard upload paths coexist (rollback safety)\n');

const ROOT = path.join(__dirname, '..', '..');
const EJS = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_new_case.ejs'), 'utf8');
const PATIENT_JS = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. New R2 FormData path is wired in the EJS.
try {
  expect(/__r2DirectEnabled/.test(EJS), 'EJS must reference __r2DirectEnabled local');
  expect(/<%\s*if\s*\(\s*__r2DirectEnabled\s*\)\s*{\s*%>/.test(EJS), 'EJS must branch on __r2DirectEnabled');
  expect(/fetch\(['"]\/portal\/patient\/files['"]/.test(EJS), 'EJS must POST to /portal/patient/files (Sub-issue A endpoint)');
  expect(/name="file_key"/.test(EJS), 'EJS must include hidden file_key input');
  expect(/file_key_input/.test(EJS), 'EJS must reference file_key_input id');
  t.pass('new R2 FormData path is wired (fetch endpoint + hidden file_key field + branch gate)');
} catch (e) { t.fail('R2 path wiring', e); }

// 2. Legacy Uploadcare path is preserved (rollback safety).
try {
  expect(/ucarecdn\.com\/libs\/widget\/3\.x\/uploadcare\.full\.min\.js/.test(EJS), 'EJS must keep the Uploadcare 3.x script tag for rollback');
  expect(/window\.UPLOADCARE_PUBLIC_KEY/.test(EJS), 'EJS must keep window.UPLOADCARE_PUBLIC_KEY assignment');
  expect(/window\.uploadcare\.fileFrom/.test(EJS), 'EJS must keep window.uploadcare.fileFrom call');
  expect(/name="file_url"/.test(EJS), 'EJS must keep hidden file_url input (legacy)');
  expect(/file_url_input/.test(EJS), 'EJS must keep file_url_input id (legacy)');
  t.pass('legacy Uploadcare 3.x path preserved (script tag + window globals + file_url field)');
} catch (e) { t.fail('legacy Uploadcare preserved', e); }

// 3. Form gate accepts EITHER path.
try {
  expect(/\(__uploaderConfigured\s*\|\|\s*__r2DirectEnabled\)/.test(EJS), 'form gate must be (__uploaderConfigured || __r2DirectEnabled)');
  // Two occurrences expected: one on the form/no-uploader branch, one on the script gate
  const matches = EJS.match(/\(__uploaderConfigured\s*\|\|\s*__r2DirectEnabled\)/g) || [];
  expect(matches.length >= 2, 'gate condition must appear at both the form-render and script-render call sites; got ' + matches.length);
  t.pass('form + script gates accept either uploader (count=' + matches.length + ')');
} catch (e) { t.fail('form gate', e); }

// 4. patient.js exposes r2DirectEnabled in the wizard locals.
try {
  expect(/uploadcareLocals\s*=\s*{[^}]*r2DirectEnabled\s*:/s.test(PATIENT_JS), 'uploadcareLocals must include r2DirectEnabled');
  expect(/UPLOAD_R2_DIRECT_ENABLED/.test(PATIENT_JS), 'patient.js must read UPLOAD_R2_DIRECT_ENABLED env var');
  t.pass('patient.js exposes r2DirectEnabled in uploadcareLocals (auto-spreads to all 7 render sites)');
} catch (e) { t.fail('locals expose flag', e); }

// 4b. (Sub-issue C) patient_order render call site spreads uploadcareLocals
//     so the order-detail view also receives r2DirectEnabled. The widget on
//     that page (messages-attach paperclip) doesn't yet branch on the flag —
//     C2 handles that. This assertion locks in the locals-consistency change
//     so a future C2 commit doesn't have to re-touch the render call site.
try {
  // Find the res.render('patient_order', {...}) call and check it contains the spread.
  const renderMatch = PATIENT_JS.match(/res\.render\(\s*['"]patient_order['"]\s*,\s*{([\s\S]*?)\n\s*}\s*\)/);
  expect(renderMatch, "could not locate res.render('patient_order', {...}) call in patient.js");
  expect(/\.\.\.uploadcareLocals/.test(renderMatch[1]), 'patient_order render call must spread ...uploadcareLocals (Sub-issue C)');
  t.pass('Sub-issue C: patient_order render call spreads ...uploadcareLocals (r2DirectEnabled now reaches the order-detail view)');
} catch (e) { t.fail('Sub-issue C: order-detail locals', e); }

// 5. /portal/patient/orders/:id/upload handler accepts file_key alongside file_url.
try {
  // The handler reads file_key from req.body
  expect(/const\s*{\s*file_url\s*,\s*file_urls\s*,\s*file_key\s*,/.test(PATIENT_JS), 'upload handler must destructure file_key from req.body');
  // The handler validates R2 keys (matches the orders/draft/<id>/<file> shape from Sub-issue A)
  expect(/orders\\\/draft\\\/\[A-Za-z0-9_-\]\+\\\/\[A-Za-z0-9_\.-\]\+/.test(PATIENT_JS), 'upload handler must validate R2 keys against the orders/draft/<id>/<file> regex');
  t.pass('/portal/patient/orders/:id/upload handler accepts both file_url (legacy) and file_key (R2) wire formats');
} catch (e) { t.fail('handler dual-mode', e); }
