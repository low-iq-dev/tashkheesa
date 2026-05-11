// tests/core/theme8-route-errlog-coverage.test.js
//
// Theme 8 Phase 2 regression guard — every console.error / console.warn
// in the three top-traffic route files must be paired with a
// logErrorToDb call so ops sees the error in /ops/errors.
//
// Files audited:
//   src/routes/patient.js
//   src/routes/doctor.js
//   src/routes/superadmin.js
//
// Pairing rule: for each console.(error|warn)(...) call, a logErrorToDb(
// call must appear within ±200 chars (typically immediately above, per the
// Phase 2 wrap pattern).
//
// Exemptions: a `THEME8-LINT-EXEMPT-HELPER` comment within ±200 chars
// declares the site as intentionally not wrapped. Use this for:
//   - helper functions with no `req` available (format fallbacks)
//   - schema-cache retry paths (defensive boot-time patterns)
//   - downstream diagnostic logs whose originating error is already
//     wrapped at an upstream catch
//   - dev-only NODE_ENV-gated guard breach warnings
//   - multer error-callback parameters (not in a try/catch; user-input
//     validation; the redirect IS the response surface)
//   - instrumentation diagnostics that emit on non-error code paths
//
// Sentinel-based exemption (not path allowlist) follows the Theme 7b
// pattern: when a helper function is eventually deleted, the sentinel
// goes with it — no orphan lint exemptions left behind.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern. No real DB,
// no server boot.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🪵 Theme 8 Phase 2 — every console.error/warn in patient/doctor/superadmin.js is wrapped\n');

const SRC = path.join(__dirname, '..', '..', 'src');
const FILES = [
  path.join(SRC, 'routes', 'patient.js'),
  path.join(SRC, 'routes', 'doctor.js'),
  path.join(SRC, 'routes', 'superadmin.js'),
];

// Strip JS comments so audit-narrative comments quoting the OLD shape
// don't trigger false positives. BUT: keep the sentinel marker visible
// (it lives inside `//` or `/* */` comments).
//
// Two-pass strategy:
//   1. Find sentinel locations from the RAW text (sentinels live in
//      comments).
//   2. Find console-call locations from the STRIPPED text (so console
//      calls inside string literals or comments don't false-positive).
//   3. For each console-call location, map back to a raw-text offset
//      so we can search for sentinel/logErrorToDb within ±200 chars of
//      the actual position.
//
// We approximate by working entirely in the raw text. False positives
// from console.error mentions inside comments are eliminated by
// requiring `console.(error|warn)(` followed by an open paren — which
// only matches actual calls (or comment text that looks identical to a
// call, but that's rare and operators can sentinel it).
function findCalls(raw, fnName) {
  const re = new RegExp('\\bconsole\\.' + fnName + '\\s*\\(', 'g');
  const out = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push({ offset: m.index, kind: fnName });
  }
  return out;
}

function findSentinel(raw, offset, radius) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(raw.length, offset + radius);
  return raw.slice(start, end).indexOf('THEME8-LINT-EXEMPT-HELPER') !== -1;
}

function findLogErrorToDb(raw, offset, radius) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(raw.length, offset + radius);
  return raw.slice(start, end).indexOf('logErrorToDb(') !== -1;
}

function offsetToLine(raw, offset) {
  return raw.slice(0, offset).split('\n').length;
}

// RADIUS — how many characters before/after a console.(error|warn) call
// to search for a paired logErrorToDb or sentinel.
//
// The canonical Phase 2 wrap shape is ~250-300 chars long (multiline block
// with context/requestId/userId/url/method/category keys), and sentinels
// are ~300-400 chars (multiline justifications). 200 (the figure from the
// fix plan) only fits a single-line wrap. 500 fits the multiline shape
// with safe margin while still confining the search to the enclosing
// catch block in practice. A catch with both a wrap-block AND a console
// call separated by >500 chars almost certainly contains unrelated logic
// in between — worth flagging.
const RADIUS = 500;
const offenders = [];
const exemptCount = { total: 0, byFile: {} };
const wrappedCount = { total: 0, byFile: {} };

for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  exemptCount.byFile[rel] = 0;
  wrappedCount.byFile[rel] = 0;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { t.fail(fileTag + ': read ' + rel, e); continue; }

  const calls = findCalls(raw, 'error').concat(findCalls(raw, 'warn'));
  for (const c of calls) {
    const lineNo = offsetToLine(raw, c.offset);
    const exempt = findSentinel(raw, c.offset, RADIUS);
    const wrapped = findLogErrorToDb(raw, c.offset, RADIUS);
    if (exempt) {
      exemptCount.total++;
      exemptCount.byFile[rel]++;
    } else if (wrapped) {
      wrappedCount.total++;
      wrappedCount.byFile[rel]++;
    } else {
      offenders.push({ file: rel, line: lineNo, kind: c.kind });
    }
  }
}

function reportFile(rel) {
  console.log('  ' + rel + ':   ' +
    wrappedCount.byFile[rel] + ' wrapped, ' +
    exemptCount.byFile[rel] + ' exempt');
}

try {
  reportFile('src/routes/patient.js');
  reportFile('src/routes/doctor.js');
  reportFile('src/routes/superadmin.js');
} catch (_) { /* never throw from reporter */ }

// ── Assertion 1: no unpaired console calls ────────────────────────────
try {
  if (offenders.length) {
    const detail = offenders.map(function (o) {
      return '    ' + o.file + ':' + o.line + ' [console.' + o.kind + ']';
    }).join('\n');
    throw new Error(
      offenders.length + ' unpaired console call(s):\n' + detail +
      '\n    → fix: wrap with logErrorToDb(err, {context, requestId, userId, url, method, category}) within ±' + RADIUS + ' chars,' +
      '\n    or add `// THEME8-LINT-EXEMPT-HELPER: <reason>` if intentional.'
    );
  }
  t.pass(fileTag + ': every console.error/warn in 3 route files is wrapped or exempt');
} catch (e) { t.fail(fileTag + ': every console.error/warn in 3 route files is wrapped or exempt', e); }

// ── Assertion 2: import is present in each file ───────────────────────
for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const hasImport = /require\(['"]\.\.\/logger['"]\)/.test(raw)
    && /logErrorToDb/.test(raw);
  try {
    if (!hasImport) {
      throw new Error(rel + ' does not require logErrorToDb from ../logger');
    }
    t.pass(fileTag + ': ' + rel + ' imports logErrorToDb from ../logger');
  } catch (e) { t.fail(fileTag + ': ' + rel + ' imports logErrorToDb from ../logger', e); }
}

// ── Assertion 3: minimum logErrorToDb coverage per file (regression guard) ──
//
// Phase 2 added 71 logErrorToDb call sites across the 3 files. Of those,
// 59 are paired with a console.error/warn (and counted by `wrappedCount`
// above) and 12 are pure additions (catches that had no console output
// at all — e.g. patient.js POST /patient/profile, the 6 instagram
// routes in superadmin.js). The pure-addition wraps are real coverage
// and should not be lost in a refactor, so this assertion counts every
// `logErrorToDb(` token directly. Numbers are lower bounds — adding
// more wraps is always fine.
const MIN_LOGERR_PER_FILE = {
  'src/routes/patient.js': 18,     // 20 wraps − 2 slack
  'src/routes/doctor.js': 32,      // 34 wraps − 2 slack
  'src/routes/superadmin.js': 15,  // 17 wraps − 2 slack
};
for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const count = (raw.match(/logErrorToDb\s*\(/g) || []).length;
  try {
    const min = MIN_LOGERR_PER_FILE[rel];
    if (count < min) {
      throw new Error(
        rel + ' has ' + count + ' logErrorToDb call(s); expected ≥ ' + min +
        ' (re-check the inventory in THEME_08_OPS_BLINDNESS_FIX_PLAN.md §2-A)'
      );
    }
    t.pass(fileTag + ': ' + rel + ' has ≥ ' + min + ' logErrorToDb calls (saw ' + count + ')');
  } catch (e) { t.fail(fileTag + ': ' + rel + ' has ≥ minimum logErrorToDb calls', e); }
}

try {
  const MIN_EXEMPT = 5;     // 7 sentinels, allowing 2 slack
  if (exemptCount.total < MIN_EXEMPT) {
    throw new Error(
      'sentinel count regressed: ' + exemptCount.total +
      ' < ' + MIN_EXEMPT +
      ' (a sentinel was likely deleted alongside an unwrapped console call — verify with grep)'
    );
  }
  t.pass(fileTag + ': sentinel count ≥ ' + MIN_EXEMPT + ' (saw ' + exemptCount.total + ')');
} catch (e) { t.fail(fileTag + ': sentinel count ≥ minimum', e); }
