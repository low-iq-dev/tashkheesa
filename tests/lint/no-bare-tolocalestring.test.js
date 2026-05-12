// tests/lint/no-bare-tolocalestring.test.js
//
// Theme 10b Sub-issue C / T3 — guard against bare locale-formatter
// regressions on patient-facing surfaces.
//
// Bare .toLocaleString() (no locale arg) is browser-locale-dependent —
// an AR-locale browser will produce Arabic-Indic digits next to English
// copy, an EN browser produces Western digits. Across patient + jobs
// surfaces, the OQ-2 hybrid policy applies: money always Western
// (forced 'en-GB'), dates respect lang. The audit Executive Summary
// flagged patient_new_case.ejs as the prime offender (4 callsites).
//
// Phase 2 (commit 30ea413) fixed the 6 patient-facing bare callsites
// (4 in patient_new_case.ejs + 2 in services.ejs) and threaded
// per-recipient lang through jobs/appointment_reminders.js.
//
// Admin + superadmin views are intentionally exempted per Sub-issue E
// §4 ground rule ("ops surface is en-only"). These are tracked as side
// issue #57 (Sub-issue C2 sweep) for a future commit; allowlisted here
// so the lint doesn't BLOCK a launch fix on follow-up work.
//
// Rule: 0 bare .toLocaleString() / .toLocaleDateString() /
// .toLocaleTimeString() in patient-facing src/views/ and in src/jobs/.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n💱 Theme 10b Sub-issue C — no bare .toLocaleString() in patient/jobs surface\n');

const ROOT = path.join(__dirname, '..', '..');

// Allowlist: admin/superadmin/doctor-analytics views are en-only by
// Sub-issue E §4 ground rule. Tracked as side issue #57 (Sub-issue C2
// sweep).
const ALLOWLIST_PREFIXES = [
  'src/views/admin',
  'src/views/superadmin',
  'src/views/doctor_analytics.ejs',
  // case_lifecycle.js uses toLocaleString('en-US') with explicit locale
  // and timeZone for the Cairo-time computation — not "bare". Skip.
  'src/case_lifecycle.js',
  // routes/patient.js + routes/ops.js may contain server-side bare
  // callsites for admin-facing UI; sub-issue #57 cleanup covers them.
  'src/routes/patient.js',
  'src/routes/ops.js',
  // The helper itself contains the canonical bare-form definition.
  'src/utils/formatNumber.js',
];

function isAllowed(rel) {
  return ALLOWLIST_PREFIXES.some(p => rel === p || rel.startsWith(p));
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.isFile()
             && (entry.name.endsWith('.ejs') || entry.name.endsWith('.js'))
             && !entry.name.endsWith('.bak')) {
      out.push(full);
    }
  }
  return out;
}

// "Bare" forms: no locale argument supplied.
//   .toLocaleString()
//   .toLocaleDateString()
//   .toLocaleTimeString()
// Plus the explicit-undefined form `.toLocaleString(undefined, ...)`
// (which falls back to browser-locale identically).
const BARE_RES = [
  /\.toLocaleString\(\s*\)/g,
  /\.toLocaleDateString\(\s*\)/g,
  /\.toLocaleTimeString\(\s*\)/g,
  /\.toLocaleString\(\s*undefined\b/g,
  /\.toLocaleDateString\(\s*undefined\b/g,
  /\.toLocaleTimeString\(\s*undefined\b/g,
];

const violations = [];
let scannedFiles = 0;

for (const dirRel of ['src/views', 'src/jobs']) {
  const dirAbs = path.join(ROOT, dirRel);
  if (!fs.existsSync(dirAbs)) continue;
  for (const file of walk(dirAbs)) {
    const rel = path.relative(ROOT, file);
    if (isAllowed(rel)) continue;
    scannedFiles++;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const re of BARE_RES) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          violations.push(rel + ':' + (i + 1) + ' — ' + lines[i].trim());
        }
      }
    }
  }
}

try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' bare .toLocale*String() call(s) in patient/jobs surface:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: pass an explicit locale per OQ-2 hybrid:\n' +
      '  - money     → .toLocaleString("en-GB", { maximumFractionDigits: 0 })  (always Western)\n' +
      '  - dates     → use formatDate(d, lang) or .toLocaleDateString(isAr ? "ar-EG" : "en-GB", ...)\n' +
      '\nSee src/utils/formatNumber.js for the canonical helper (commit 30ea413).'
    );
  }
  t.pass(fileTag + ': 0 bare .toLocale*String() in patient/jobs surface (scanned ' + scannedFiles + ' files; admin/superadmin allowlisted)');
} catch (e) {
  t.fail(fileTag + ': bare .toLocaleString regression', e);
}

// Sanity floor — assert the test actually walked something.
try {
  if (scannedFiles < 20) {
    throw new Error('only scanned ' + scannedFiles + ' files — expected ≥20 patient/doctor/jobs files. Lint may be silently passing on a path bug.');
  }
  t.pass(fileTag + ': scanned ' + scannedFiles + ' files outside the admin/superadmin allowlist (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
