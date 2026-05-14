// tests/core/theme13-c2b-folder-allowlist.test.js
//
// Theme 13 Sub-issue C2.B — POST /portal/patient/files allowlists the
// optional `folder` form field. Allowlist is the only thing standing
// between the client and arbitrary R2 path-traversal (the patient-id
// segment is server-controlled, but the prefix is client-supplied) — so
// the validation contract gets a static-grep lock-in here. The actual
// folder-routing behaviour gets exercised end-to-end in C2.G's auth-bound
// tests (which need the C2.C widget rewrite to ship first).
//
// Pure source-grep — no DB, no boot.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 C2.B — POST /portal/patient/files folder allowlist\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient_files.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. Allowlist Set is defined with exactly two entries: orders/draft + messages-attach.
try {
  expect(/ALLOWED_FOLDERS\s*=\s*new\s+Set\(\s*\[\s*['"]orders\/draft['"]\s*,\s*['"]messages-attach['"]\s*\]\s*\)/.test(SRC),
    'patient_files.js must define ALLOWED_FOLDERS = new Set([\'orders/draft\', \'messages-attach\'])');
  t.pass('allowlist Set is defined with both expected entries (orders/draft + messages-attach)');
} catch (e) { t.fail('allowlist set', e); }

// 2. The folder is read from req.body.folder (so the wizard can stay default-pathed
//    and the messages widget can opt into 'messages-attach').
try {
  expect(/req\.body\s*&&\s*req\.body\.folder/.test(SRC), 'patient_files.js must read req.body.folder');
  expect(/['"]orders\/draft['"]/.test(SRC), 'patient_files.js must default to \'orders/draft\' when no folder provided');
  t.pass('folder field read from req.body with orders/draft default (preserves Sub-issue A behaviour)');
} catch (e) { t.fail('req.body.folder default', e); }

// 3. Rejection path returns 400 with a typed error mentioning both allowed values.
try {
  expect(/!ALLOWED_FOLDERS\.has\(/.test(SRC), 'patient_files.js must reject folders not in the allowlist');
  expect(/Invalid folder/i.test(SRC), 'patient_files.js must use a typed "Invalid folder" error message');
  expect(/orders\/draft.*messages-attach/.test(SRC), 'error message must list both allowed folders for client clarity');
  t.pass('rejection path returns 400 with typed error listing both allowed folders');
} catch (e) { t.fail('rejection path', e); }

// 4. patient-id segment is server-controlled (never from req.body) — defends against
//    path-traversal even if the allowlist were ever expanded.
try {
  // Match: const folder = requestedFolder + '/' + req.user.id;
  expect(/folder\s*=\s*requestedFolder\s*\+\s*['"]\/['"]\s*\+\s*req\.user\.id/.test(SRC),
    'patient-id segment must be hardcoded to req.user.id (no client-supplied path components)');
  t.pass('patient-id segment is server-controlled (req.user.id, not req.body)');
} catch (e) { t.fail('server-controlled patient id', e); }
