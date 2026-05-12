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
// Side issue #57 (2026-05-12) — admin + superadmin + doctor_analytics
// views were swept onto explicit 'en-GB' locales. The allowlist that
// previously exempted them has been removed; T3 now enforces the
// "no bare .toLocale*String()" invariant across ALL views and jobs,
// not just patient-facing surfaces.
//
// Rule: 0 bare .toLocaleString() / .toLocaleDateString() /
// .toLocaleTimeString() anywhere in src/views/ or src/jobs/.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n💱 Theme 10b Sub-issue C — no bare .toLocaleString() in src/views/ + src/jobs/\n');

const ROOT = path.join(__dirname, '..', '..');

// Allowlist (post side issue #57 cleanup): only files whose
// "bare" call is intentional and non-bare in practice — e.g.,
// `.toLocaleString('en-US', { timeZone: ... })` looks bare to a
// dumb regex because the regex match width covers the parens, but
// the locale arg IS present. These files are checked manually.
const ALLOWLIST_PREFIXES = [
  // case_lifecycle.js uses toLocaleString('en-US') with explicit locale
  // and timeZone for the Cairo-time computation — not "bare". Skip.
  'src/case_lifecycle.js',
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
      'Found ' + violations.length + ' bare .toLocale*String() call(s) in src/views/ + src/jobs/:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: pass an explicit locale per OQ-2 hybrid:\n' +
      '  - money         → .toLocaleString("en-GB", { maximumFractionDigits: 0 })  (always Western)\n' +
      '  - patient dates → use formatDate(d, lang) or .toLocaleDateString(isAr ? "ar-EG" : "en-GB", ...)\n' +
      '  - admin/ops     → .toLocaleString("en-GB") (en-only per Sub-issue E §4 ground rule)\n' +
      '\nSee src/utils/formatNumber.js for the canonical server-side helper (commit 30ea413).'
    );
  }
  t.pass(fileTag + ': 0 bare .toLocale*String() in src/views/ + src/jobs/ (scanned ' + scannedFiles + ' files)');
} catch (e) {
  t.fail(fileTag + ': bare .toLocaleString regression', e);
}

// Sanity floor — assert the test actually walked something.
try {
  if (scannedFiles < 100) {
    throw new Error('only scanned ' + scannedFiles + ' files — expected ≥100 view+job files post-#57 (was ≥20 with admin allowlisted). Lint may be silently passing on a path bug.');
  }
  t.pass(fileTag + ': scanned ' + scannedFiles + ' files across src/views/ + src/jobs/ (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
