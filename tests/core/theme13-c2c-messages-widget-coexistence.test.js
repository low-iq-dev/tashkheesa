// tests/core/theme13-c2c-messages-widget-coexistence.test.js
//
// Theme 13 Sub-issue C2.C — both messages-attach upload code paths must
// coexist in patient_order.ejs throughout the migration window. Same
// rollback safety contract as Phase 2's wizard coexistence test
// (THEME_13_R2_MIGRATION_FIX_PLAN.md §7a) — flipping
// MESSAGES_R2_ENABLED back to 'false' (or UPLOAD_R2_DIRECT_ENABLED back
// to 'false', since both are AND-gated) must keep the legacy Uploadcare
// widget functional with zero code change.
//
// Pure source-grep — no DB, no boot. Covers:
//   * The new R2 FormData path is wired (POST to /portal/patient/files
//     with folder=messages-attach, hidden msg-file-key field, hidden
//     native file picker).
//   * The legacy Uploadcare 3.x widget path is preserved (script tag +
//     window.UPLOADCARE_PUBLIC_KEY + Uploadcare.openDialog call +
//     hidden msg-file-url field).
//   * The AND-gate is in place (`__r2DirectEnabled && __messagesR2Enabled`)
//     — neither flag alone activates R2.
//   * Both flags propagate from patient.js uploadcareLocals.
//   * The form gate accepts EITHER uploader being available.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 Sub-issue C2.C — messages-attach widget paths coexist (rollback safety)\n');

const ROOT = path.join(__dirname, '..', '..');
const EJS = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_order.ejs'), 'utf8');
const PATIENT_JS = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. AND-gate: __useR2ForMessages requires BOTH flags.
try {
  expect(/__useR2ForMessages\s*=\s*__r2DirectEnabled\s*&&\s*__messagesR2Enabled/.test(EJS),
    'EJS must define __useR2ForMessages = __r2DirectEnabled && __messagesR2Enabled (AND-gate)');
  expect(/<%\s*if\s*\(\s*__useR2ForMessages\s*\)\s*{\s*%>/.test(EJS),
    'EJS must branch the script block on __useR2ForMessages');
  t.pass('AND-gate: __useR2ForMessages requires both UPLOAD_R2_DIRECT_ENABLED && MESSAGES_R2_ENABLED');
} catch (e) { t.fail('AND-gate', e); }

// 2. New R2 FormData path is wired in the EJS.
try {
  expect(/fetch\(['"]\/portal\/patient\/files['"]/.test(EJS),
    'EJS must POST to /portal/patient/files (Sub-issue A endpoint)');
  expect(/fd\.append\(['"]folder['"]\s*,\s*['"]messages-attach['"]\)/.test(EJS),
    "EJS must append folder='messages-attach' to FormData (Sub-issue C2.B allowlist value)");
  expect(/name="msg-file-key"|id="msg-file-key"/.test(EJS),
    'EJS must include hidden msg-file-key input');
  expect(/id="msg-native-file"/.test(EJS),
    'EJS must include hidden native file picker (R2 path uses native picker, not Uploadcare dialog)');
  t.pass('new R2 FormData path is wired (fetch + folder=messages-attach + hidden file_key + native picker)');
} catch (e) { t.fail('R2 path wiring', e); }

// 3. Legacy Uploadcare path preserved (rollback safety — must be byte-equivalent
//    to pre-C2.C main for clean rollback).
try {
  expect(/ucarecdn\.com\/libs\/widget\/3\.x\/uploadcare\.full\.min\.js/.test(EJS),
    'EJS must keep the Uploadcare 3.x script tag for rollback');
  expect(/window\.UPLOADCARE_PUBLIC_KEY/.test(EJS),
    'EJS must keep window.UPLOADCARE_PUBLIC_KEY assignment in legacy branch');
  expect(/window\.uploadcare\.openDialog/.test(EJS),
    'EJS must keep window.uploadcare.openDialog call (legacy widget entry)');
  expect(/name="msg-file-url"|id="msg-file-url"/.test(EJS),
    'EJS must keep hidden msg-file-url input (legacy field)');
  t.pass('legacy Uploadcare 3.x path preserved (script tag + openDialog + msg-file-url field)');
} catch (e) { t.fail('legacy preserved', e); }

// 4. Form gate accepts EITHER uploader being available (button enabled).
try {
  expect(/__attachAvailable\s*=\s*__ucPk\s*\|\|\s*__useR2ForMessages/.test(EJS),
    'EJS must define __attachAvailable = __ucPk || __useR2ForMessages');
  expect(/<%\s*if\s*\(\s*__attachAvailable\s*\)\s*{\s*%>/.test(EJS),
    'EJS must gate the script block on __attachAvailable (either path)');
  t.pass('form gate accepts EITHER uploader being available (legacy UC OR R2 messages)');
} catch (e) { t.fail('form gate', e); }

// 5. patient.js exposes messagesR2Enabled in uploadcareLocals.
try {
  expect(/uploadcareLocals\s*=\s*{[^}]*messagesR2Enabled\s*:/s.test(PATIENT_JS),
    'uploadcareLocals must include messagesR2Enabled');
  expect(/MESSAGES_R2_ENABLED/.test(PATIENT_JS),
    'patient.js must read MESSAGES_R2_ENABLED env var');
  t.pass('patient.js exposes messagesR2Enabled in uploadcareLocals (auto-spreads to all 7+ render sites)');
} catch (e) { t.fail('locals expose flag', e); }
