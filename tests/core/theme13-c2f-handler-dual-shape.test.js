// tests/core/theme13-c2f-handler-dual-shape.test.js
//
// Theme 13 Sub-issue C2.F — POST /portal/patient/orders/:id/messages
// accepts file_key alongside file_url + mirrors to order_additional_files
// with the right column. Locks in the dual-shape contract that the C2.E
// resolver depends on.
//
// Pure source-grep — no DB, no boot. Runtime exercise comes from manual
// UAT post-flag-flip (per THEME_13_C2_FIX_PLAN.md §6 manual UAT list).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 C2.F — messages handler dual-shape + mirror\n');

const ROOT = path.join(__dirname, '..', '..');
const PATIENT_JS = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. Handler destructures file_key alongside file_url.
try {
  expect(/const fileKey\s*=\s*String\(body\.file_key\s*\|\|\s*['"]['"]\)\.trim\(\)/.test(PATIENT_JS),
    'messages handler must read file_key from body');
  t.pass('handler destructures file_key alongside file_url');
} catch (e) { t.fail('1. file_key destructure', e); }

// 2. XOR validation: rejects both-set + validates messages-attach regex shape.
try {
  expect(/if\s*\(fileUrl\s*&&\s*fileKey\)/.test(PATIENT_JS),
    'must reject both-set with redirect to ?err=invalid_file');
  expect(/messages-attach\\\/\[A-Za-z0-9_-\]\+\\\/\[A-Za-z0-9_\.-\]\+/.test(PATIENT_JS),
    'must validate fileKey shape against ^messages-attach/<patient>/<file>$ regex (matches C2.B allowlist)');
  t.pass('XOR validation + R2-key regex shape pinned to messages-attach folder');
} catch (e) { t.fail('2. XOR + regex', e); }

// 3. Mirror handles both shapes — URL via file_url path, key via 6th-arg key path.
try {
  expect(/insertAdditionalFile\(orderId,\s*fileUrl,/.test(PATIENT_JS),
    'mirror must call insertAdditionalFile(orderId, fileUrl, ...) for legacy URL shape');
  expect(/insertAdditionalFile\(orderId,\s*null,\s*fileName[^,]*,\s*nowIso,\s*null,\s*fileKey\)/.test(PATIENT_JS),
    'mirror must call insertAdditionalFile(orderId, null, fileName, nowIso, null, fileKey) for R2 key shape');
  t.pass('mirror to order_additional_files handles both shapes (file_url AND file_key)');
} catch (e) { t.fail('3. dual-shape mirror', e); }

// 4. Message INSERT writes to BOTH file_url and file_key columns (one is non-null per row).
try {
  expect(/INSERT INTO messages[\s\S]*?file_url[\s\S]*?file_key/.test(PATIENT_JS),
    'message INSERT must list both file_url and file_key columns');
  t.pass('message INSERT writes both file_url + file_key (XOR enforced by validation above)');
} catch (e) { t.fail('4. dual-column INSERT', e); }

// 5. insertAdditionalFile helper accepts a 6th-arg `key` and routes to file_key column.
try {
  expect(/async function insertAdditionalFile\(orderId, url, labelValue, nowIso, client, key\)/.test(PATIENT_JS),
    'helper signature must include 6th-arg key for the R2-key path');
  expect(/targetCol\s*=\s*useKey\s*\?\s*['"]file_key['"]\s*:\s*['"]file_url['"]/.test(PATIENT_JS),
    'helper must route to file_key column when key is provided');
  t.pass('insertAdditionalFile helper accepts key 6th-arg + routes to file_key column');
} catch (e) { t.fail('5. helper signature', e); }

// 6. Upload handler at :3433 disambiguates URL vs key when calling insertAdditionalFile
//    (Phase 2 merged URLs+keys into `filtered`; C2.F splits by scheme).
try {
  expect(/insertAdditionalFile\(orderId,\s*u,\s*cleanLabel,\s*now,\s*client\)/.test(PATIENT_JS),
    'upload handler must keep the URL-path call (legacy)');
  expect(/insertAdditionalFile\(orderId,\s*null,\s*cleanLabel,\s*now,\s*client,\s*u\)/.test(PATIENT_JS),
    'upload handler must add the R2-key-path call (new C2.F)');
  t.pass('upload handler disambiguates URL vs key in the post-doctor-request mirror loop');
} catch (e) { t.fail('6. upload handler disambiguation', e); }
