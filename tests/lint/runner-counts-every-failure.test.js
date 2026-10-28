'use strict';
// tests/lint/runner-counts-every-failure.test.js
//
// 2026-10-27 — guard for tests/run.js itself.
//
// Until today the runner counted only its own harness: a node:test file could
// fail and the suite still said "Failed: 0" and exited 0. This builds tiny test
// suites in a temp dir, runs the real runner on them (`--dir`), and checks:
//   1. a suite of passing files exits 0 — the control, so a runner that always
//      exits 1 cannot pass the rest;
//   2. ONE failing node:test file is enough to exit non-zero;
//   3. every other way a file can go wrong — failing subtest, load crash,
//      unhandled rejection, non-zero exit, a hang, no results — is counted as a
//      failure against that file.
//
// Runner-harness style (global._testRunner), not node:test, on purpose: if the
// runner ever goes blind to node:test again, this file must still be counted.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (skipped: ' + r + ')'); }
};
function check(name, fn) {
  try { const problem = fn(); if (problem) t.fail(name, new Error(problem)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const RUNNER = path.join(__dirname, '..', 'run.js');

console.log('\n🛡️  tests/run.js counts every failure, node:test included\n');

const FILES = {
  passing: {
    'node-test-pass.test.js':
      "const test = require('node:test');\n" +
      "test('adds', () => { if (1 + 1 !== 2) throw new Error('math'); });\n" +
      "test('parent', async (t) => { await t.test('child', () => {}); });\n",
    'harness-pass.test.js':
      "global._testRunner.pass('harness pass');\n",
  },
  oneNodeTestFailure: {
    'node-test-fail.test.js':
      "const test = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "test('passes', () => {});\n" +
      "test('deliberately fails', () => { assert.strictEqual(1, 2); });\n",
  },
  everyKind: {
    'subtest-fail.test.js':
      "const test = require('node:test');\n" +
      "test('parent', async (t) => { await t.test('ok', () => {}); await t.test('bad', () => { throw new Error('x'); }); });\n",
    'load-crash.test.js':
      "global._testRunner.pass('reached before the crash');\n" +
      "throw new Error('deliberate load crash');\n",
    'node-test-load-crash.test.js':
      "require('node:test');\n" +
      "throw new Error('deliberate load crash');\n",
    'unhandled-rejection.test.js':
      "global._testRunner.pass('looks fine');\n" +
      "Promise.reject(new Error('deliberately unhandled'));\n",
    'exit-nonzero.test.js':
      "global._testRunner.pass('looks fine');\n" +
      "process.exitCode = 2;\n",
    'hang.test.js':
      "global._testRunner.pass('then never exits');\n" +
      "setInterval(() => {}, 1000);\n",
    'no-results.test.js':
      "console.log('this file tests nothing');\n",
  },
};

function strip(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

function runSuite(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-guard-'));
  try {
    Object.keys(files).forEach((name) => fs.writeFileSync(path.join(dir, name), files[name]));
    const r = spawnSync(process.execPath, [RUNNER, '--dir', dir], {
      encoding: 'utf8', timeout: 90000,
      env: Object.assign({}, process.env, { TEST_FILE_TIMEOUT_MS: '3000', TEST_RUNNER_KEEP_RESULTS: '' }),
    });
    const out = strip((r.stdout || '') + (r.stderr || ''));
    const perFile = {};
    out.replace(/↳ (\S+) · (\d+) passed · (\d+) failed · (\d+) skipped/g, (_, f, p, x, s) => {
      perFile[f] = { passed: +p, failed: +x, skipped: +s };
      return _;
    });
    const total = (label) => { const m = out.match(new RegExp(label + ':\\s+(\\d+)')); return m ? +m[1] : null; };
    return { status: r.status, error: r.error, perFile, failed: total('Failed'), passed: total('Passed'), out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ok = runSuite(FILES.passing);
check('control: a suite of passing files (node:test and harness) exits 0 with Failed: 0', () => {
  if (ok.error) return ok.error.message;
  if (ok.status !== 0 || ok.failed !== 0) return 'exit ' + ok.status + ', Failed: ' + ok.failed + '\n' + ok.out.slice(-1500);
});
check('control: the passing results are counted — 2 node:test leaves (a parent is not counted on top of its subtest) + 1 harness', () => {
  if (ok.passed !== 3) return 'Passed: ' + ok.passed;
});

const one = runSuite(FILES.oneNodeTestFailure);
check('one failing node:test file makes the runner exit non-zero', () => {
  if (one.error) return one.error.message;
  if (one.status === 0) return 'exited 0:\n' + one.out.slice(-1500);
});
check('the failing node:test test is in the Failed tally, and its file line says 1 failed', () => {
  const f = one.perFile['node-test-fail.test.js'];
  if (one.failed !== 1 || !f || f.failed !== 1 || f.passed !== 1) return 'Failed: ' + one.failed + ', file line: ' + JSON.stringify(f);
});

const all = runSuite(FILES.everyKind);
check('a suite where every file goes wrong a different way exits non-zero', () => {
  if (all.error) return all.error.message;
  if (all.status === 0) return 'exited 0';
});
Object.keys(FILES.everyKind).forEach((name) => {
  check('counted as a failure: ' + name.replace('.test.js', ''), () => {
    const f = all.perFile[name];
    if (!f) return 'no per-file line for ' + name + ' (a file the runner did not report is a silently skipped file)';
    if (f.failed < 1) return JSON.stringify(f) + '\n' + all.out.slice(-2000);
  });
});
check('a failing subtest counts once, not again for its parent', () => {
  const f = all.perFile['subtest-fail.test.js'];
  if (!f || f.failed !== 1 || f.passed !== 1) return JSON.stringify(f);
});
