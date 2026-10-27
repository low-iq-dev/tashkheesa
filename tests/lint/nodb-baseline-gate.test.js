'use strict';
// tests/lint/nodb-baseline-gate.test.js
//
// 2026-10-27 — the no-database baseline gate.
//
// tests/baseline-nodb-failures.txt lists the failures a no-database run of the
// whole suite is known to have. tests/run.js runs this file LAST and hands it
// every earlier file's failures (TEST_RUNNER_FAILURES); any failure not in the
// baseline is NEW and fails here, by name. Baseline entries that now pass are
// listed so the baseline can shrink — they are not failures.
//
// This does not make a red suite green: tests/run.js exits non-zero while ANY
// test fails, known or not. It tells "the same known failures" apart from "a
// new one", which is what a reviewer needs while the known list is non-empty.
//
// Runner-harness style (global._testRunner), not node:test, on purpose: this
// file must be counted even by a runner that is blind to node:test.

const fs   = require('fs');
const path = require('path');
const baseline = require('../_helpers/baseline');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (skipped: ' + r + ')'); }
};
function check(name, fn) {
  try { const problem = fn(); if (problem) t.fail(name, new Error(problem)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const ROOT = path.join(__dirname, '..', '..');
const TESTS = path.join(__dirname, '..');

console.log('\n📒 no-database baseline: no failure that is not already known\n');

// ── The comparison, on made-up failure sets ─────────────────────────────────
check('compare: a failure missing from the baseline is NEW', () => {
  const r = baseline.compare(['a.test.js :: x'], ['a.test.js :: x', 'b.test.js :: y']);
  if (r.fresh.join('|') !== 'b.test.js :: y' || r.known !== 1) return 'got ' + JSON.stringify(r);
});
check('compare: a baseline entry that now passes is reported as passing, never as NEW', () => {
  const r = baseline.compare(['a.test.js :: x', 'b.test.js :: y'], ['a.test.js :: x']);
  if (r.fresh.length || r.passing.join('|') !== 'b.test.js :: y') return 'got ' + JSON.stringify(r);
});
check('compare: a second failure under an already-known name is NEW (counts, not just names)', () => {
  const r = baseline.compare(['a.test.js :: x'], ['a.test.js :: x', 'a.test.js :: x']);
  if (r.fresh.join('|') !== 'a.test.js :: x') return 'got ' + JSON.stringify(r);
});
check('compare: an empty baseline makes every failure NEW', () => {
  const r = baseline.compare([], ['a.test.js :: x']);
  if (r.fresh.length !== 1) return 'got ' + JSON.stringify(r);
});
check('failureKey: whitespace and line breaks in a test name do not change the key', () => {
  const a = baseline.failureKey('a.test.js', 'x  y\n z ');
  if (a !== 'a.test.js :: x y z') return 'got ' + JSON.stringify(a);
});

// ── The baseline file ───────────────────────────────────────────────────────
const exists = fs.existsSync(baseline.BASELINE_PATH);
check('tests/baseline-nodb-failures.txt exists', () => exists ? null : 'missing — run: node tests/run.js --update-baseline');
if (exists) {
  const keys = baseline.read();
  check('every baseline entry names a test file that still exists', () => {
    const gone = keys.map((k) => k.split(' :: ')[0])
      .filter((f, i, all) => all.indexOf(f) === i)
      .filter((f) => !fs.existsSync(f.startsWith('src/') ? path.join(ROOT, f) : path.join(TESTS, f)));
    if (gone.length) return 'no such file: ' + gone.join(', ');
  });
  check('every baseline entry is a `<file> :: <test name>` line', () => {
    const bad = keys.filter((k) => !/^\S+\.test\.js :: \S/.test(k));
    if (bad.length) return 'malformed: ' + bad.slice(0, 5).join(' | ');
  });
  check('the baseline is sorted (as --update-baseline writes it)', () => {
    const sorted = keys.slice().sort();
    const i = keys.findIndex((k, n) => k !== sorted[n]);
    if (i >= 0) return 'out of order at entry ' + (i + 1) + ': ' + keys[i];
  });
}

// ── The gate: this run's failures against the baseline ─────────────────────
if (!process.env.TEST_RUNNER_FAILURES) {
  t.skip('no-database baseline gate', 'only under tests/run.js, which runs this file last and passes it the run\'s failures');
} else if (process.env.TEST_RUNNER_BASELINE_APPLIES !== '1') {
  t.skip('no-database baseline gate', 'this run has a database, or is not the whole suite — the no-database baseline does not describe it');
} else {
  check('no failure in this run is missing from tests/baseline-nodb-failures.txt', () => {
    const current = baseline.parse(fs.readFileSync(process.env.TEST_RUNNER_FAILURES, 'utf8'));
    const r = baseline.compare(exists ? baseline.read() : [], current);
    console.log(`  ${r.known} known failure(s) · ${r.fresh.length} NEW · ${r.passing.length} baseline entr${r.passing.length === 1 ? 'y' : 'ies'} now passing`);
    r.passing.forEach((k) => console.log('  ✓ now passing — remove it from the baseline: ' + k));
    if (r.fresh.length) return r.fresh.length + ' NEW failure(s) not in the baseline:\n' + r.fresh.map((k) => '      ' + k).join('\n');
  });
}
