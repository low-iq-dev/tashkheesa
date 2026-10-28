// tests/_helpers/run-one.js
//
// 2026-10-27 — runs ONE runner-harness test file (global._testRunner style) in
// its own process, for tests/run.js. Not a *.test.js file, so it is never
// discovered as a test itself.
//
//   node tests/_helpers/run-one.js <file>     (env TEST_RUNNER_RESULTS=<results.ndjson>)
//
// Every pass / fail / skip is printed exactly as the runner always printed it
// AND appended to the results file synchronously, so a file that calls
// process.exit() part-way still leaves every result it reached on disk. The
// parent counts the results file, never the printed lines.
//
// A file that throws while loading, rejects its exported promise, or lets an
// exception / rejection escape is recorded as a failure here. A file that sets a
// non-zero exit code without recording one is caught by the parent.

'use strict';

const fs   = require('fs');
const path = require('path');

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

const file = path.resolve(process.argv[2] || '');
const out  = process.env.TEST_RUNNER_RESULTS;
// After an exported promise settles, how long to let stragglers report before
// leaving (an open pool or server must not hold the process forever).
const SETTLE_MS = Number(process.env.TEST_RUNNER_SETTLE_MS || 2000);

function errText(err) { return String((err && err.message) || err).split('\n')[0]; }
function record(line) {
  if (!out) return;
  fs.appendFileSync(out, JSON.stringify(line) + '\n');
}

global._testRunner = {
  pass: (name) => { record({ r: 'pass', name: String(name) }); console.log(`  ${GREEN}✅${RESET} ${name}`); },
  fail: (name, err) => { record({ r: 'fail', name: String(name), err: errText(err) }); console.error(`  ${RED}❌${RESET} ${name}: ${(err && err.message) || err}`); },
  skip: (name, reason) => { record({ r: 'skip', name: String(name), err: String(reason) }); console.log(`  ${YELLOW}⏭️${RESET}  ${name} (skipped: ${reason})`); },
};

function crashed(label, err) {
  record({ r: 'fail', name: '(file) ' + label, err: errText(err) });
  console.error(`  ${RED}❌${RESET} ${label}: ${(err && err.stack) || err}`);
  process.exitCode = 1;
}
process.on('uncaughtException', (err) => crashed('uncaught exception', err));
process.on('unhandledRejection', (err) => crashed('unhandled rejection', err));

(async function main() {
  let exported;
  try {
    exported = require(file);
  } catch (err) {
    crashed('crashed while loading', err);
    process.exit(1);
  }
  if (!exported || typeof exported.then !== 'function') return; // the process ends when the file's work does
  try { await exported; } catch (err) { crashed('exported promise rejected', err); }
  setTimeout(() => process.exit(), SETTLE_MS).unref();
})();
