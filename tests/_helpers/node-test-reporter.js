// tests/_helpers/node-test-reporter.js
//
// 2026-10-27 — the node:test half of tests/run.js's tally.
//
// tests/run.js runs every node:test file as
//   node --test --test-reporter=spec        --test-reporter-destination=stdout
//               --test-reporter=<this file> --test-reporter-destination=<results.ndjson>
// The spec reporter is what a human reads; this one writes one JSON line per
// counted result, in the same shape tests/_helpers/run-one.js writes for
// runner-harness files: { r: 'pass' | 'fail' | 'skip', name, err? }.
//
// What counts (so one broken assertion is one failure, not three):
//   - leaf tests only. A test that had subtests is not counted when it passes,
//     and not counted when it failed only because a subtest did
//     (failureType 'subtestsFailed') — the subtest is the failure. A parent that
//     failed for its own reason (a hook threw, its body threw, it timed out) IS
//     counted.
//   - describe() suites the same way.
//   - skip and todo count as skipped, whatever a todo's body did.
//   - every other failure type counts: testCodeFailure, hookFailed,
//     testTimeoutFailure, cancelledByParent, uncaughtException,
//     unhandledRejection, and a file that failed outside any test.
// Written against the event fields present since Node 20; anything missing is
// read as "a plain test".

'use strict';

const path = require('path');

function errText(details) {
  const e = details && details.error;
  if (!e) return '';
  const cause = e.cause && (e.cause.message || String(e.cause));
  return String(cause || e.message || e).split('\n')[0];
}

module.exports = async function* countingReporter(source) {
  const childrenAt = []; // childrenAt[n] = results seen at nesting n since the last result at n-1
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    const n = d.nesting || 0;
    const hadChildren = (childrenAt[n + 1] || 0) > 0;
    childrenAt[n + 1] = 0;
    childrenAt[n] = (childrenAt[n] || 0) + 1;

    const details = d.details || {};
    const failureType = details.error && details.error.failureType;
    const isSuite = details.type === 'suite';

    // A failure outside any test (load crash, non-zero exit) is reported as a
    // test named after the file — an absolute path, different on every
    // machine. Give it a stable name (older nodes may not send d.file).
    let name = String(d.name);
    if ((d.file && path.resolve(name) === d.file) || (path.isAbsolute(name) && /\.[cm]?js$/.test(name))) {
      name = '(file) failed outside any test';
    }

    let r;
    if (d.skip || d.todo) r = 'skip';
    else if (ev.type === 'test:pass') r = (hadChildren || isSuite) ? null : 'pass';
    else r = ((hadChildren || isSuite) && failureType === 'subtestsFailed') ? null : 'fail';
    if (!r) continue;

    const line = { r, name };
    if (r === 'fail') line.err = (failureType ? failureType + ': ' : '') + errText(details);
    yield JSON.stringify(line) + '\n';
  }
};
