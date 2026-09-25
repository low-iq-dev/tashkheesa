// tests/core/launch-day-accept-stamps-accepted-at.test.js
//
// Soft-launch day regression guard (25 Sep 2026).
//
// 3f9de9c made assertCanonicalDbStatus return the LOWERCASE spelling for the
// database. transitionCase assigned that return value back into
// `desiredStatus`, so every comparison below it — === CASE_STATUS.PAID,
// SLA_BREACH, IN_REVIEW — went false: a case entering IN_REVIEW got no
// accepted_at and no deadline_at, and file_access (doctor gate = accepted_at)
// 403'd the accepting doctor's own files. Two practice cases hit it within
// the first hour of launch day.
//
// Two pins, same source-grep style as the theme7 tests:
//   1. transitionCase never reassigns desiredStatus from the DB-spelling
//      function; it validates only.
//   2. The doctor case template's `files` guard survives a render that omits
//      `files` (renderAccessDenied), which used to throw ReferenceError and
//      turn every refused Accept into an error page.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩹 Launch day — accept stamps accepted_at; denied page renders without files\n');

const LIFECYCLE = path.join(__dirname, '..', '..', 'src', 'case_lifecycle.js');
const src = fs.readFileSync(LIFECYCLE, 'utf8');
const fnStart = src.indexOf('async function transitionCase(');
const body = fnStart >= 0 ? src.slice(fnStart, src.indexOf('\n// -----', fnStart)) : '';

try {
  if (!body) throw new Error('transitionCase not found');
  if (/desiredStatus\s*=\s*assertCanonicalDbStatus\(/.test(body)) {
    throw new Error('transitionCase reassigns desiredStatus from assertCanonicalDbStatus (lowercase) — IN_REVIEW/PAID/SLA_BREACH comparisons go false');
  }
  if (!/assertCanonicalDbStatus\(desiredStatus\)/.test(body)) {
    throw new Error('transitionCase must still validate the status via assertCanonicalDbStatus');
  }
  if (!/desiredStatus === CASE_STATUS\.IN_REVIEW/.test(body)) {
    throw new Error('IN_REVIEW branch (accepted_at stamp) missing');
  }
  t.pass('transitionCase validates the status but keeps the uppercase canonical for its comparisons');
} catch (e) { t.fail('transitionCase status comparison', e); }

// 2. Template guard: the line must not evaluate a bare `files` when absent.
const VIEW = path.join(__dirname, '..', '..', 'src', 'views', 'portal_doctor_case.ejs');
const view = fs.readFileSync(VIEW, 'utf8');
try {
  const m = view.match(/var _files = ([^\n]+)/);
  if (!m) throw new Error('_files guard not found');
  const expr = m[1];
  // Evaluate the guard exactly as EJS would, inside with(locals) where
  // `files` is absent: must yield [] rather than throw.
  const fn = new Function('locals', 'with (locals) { ' + 'var _files = ' + expr + ' return _files; }');
  const out = fn({});
  if (!Array.isArray(out) || out.length !== 0) throw new Error('guard did not yield [] when files is absent');
  const out2 = fn({ files: [{ id: 'x' }] });
  if (!Array.isArray(out2) || out2.length !== 1) throw new Error('guard dropped a real files array');
  t.pass('portal_doctor_case _files guard tolerates an absent `files` local');
} catch (e) { t.fail('portal_doctor_case files guard', e); }
