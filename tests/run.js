#!/usr/bin/env node
// tests/run.js — Tashkheesa test runner
//
// Runs every test file in its OWN process, one at a time, and counts what each
// one reported. A file passes only if it reported at least one result, none of
// them failed, and it exited cleanly in time.
//
//   node tests/run.js                    the suite (tests/ and src/**/*.test.js)
//   node tests/run.js --dir <path>       every *.test.js under <path> instead
//   node tests/run.js --update-baseline  rewrite tests/baseline-nodb-failures.txt
//
// 2026-10-27 — why every file gets its own process. The runner used to
// require() all files into one process and tally only its own harness
// (global._testRunner). Files written with node:test were invisible to it: their
// failures were printed and never counted, and most of them never even ran —
// node:test schedules its tests asynchronously, the runner waited only for its
// own counters to go quiet, then called process.exit() underneath them. On
// origin/main that produced "Failed: 5" while node:test files held dozens of
// failing tests, and a "no database" run that still wrote fixtures into a local
// Postgres. The AUDIT 2026-08-16 drain fixed the same blind spot for the
// harness's own late results; node:test was never covered.
//
// Now, per file:
//   - node:test files run under `node --test` with a counting reporter
//     (tests/_helpers/node-test-reporter.js) next to the usual spec output;
//   - every other file runs under tests/_helpers/run-one.js, which records each
//     global._testRunner result to disk as it happens;
//   - a failing test or subtest, a hook failure, an uncaught exception, an
//     unhandled rejection, a file that throws while loading, a file that exits
//     non-zero, a file that reports nothing and a file that outlives its timeout
//     are all failures. Nothing is skipped unless a test skipped itself, or the
//     whole file needs a database this run does not have — and then it is
//     printed and counted as skipped.
//
// Process-per-file also ends the cross-file leaks the old runner had to patch
// around (require.cache stubs, process.env flips, ejs.cache): no file can see
// another file's state.

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn, spawnSync } = require('child_process');

// Load .env before anything else. The individual test files each call
// dotenv.config() themselves, but the readiness probe below runs BEFORE any of
// them — without this it would report "DATABASE_URL is not set" on a machine
// where it is set in .env, and skip every integration test unconditionally.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const baseline = require('./_helpers/baseline');

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

const ROOT      = path.join(__dirname, '..');
const TESTS_DIR = __dirname;
const RUN_ONE   = path.join(__dirname, '_helpers', 'run-one.js');
const REPORTER  = path.join(__dirname, '_helpers', 'node-test-reporter.js');
const NO_DB_GUARD = path.join(__dirname, '_helpers', 'no-db-guard.js');
// Runs last: it compares every earlier file's failures with the baseline.
const GATE_FILE = path.join(__dirname, 'lint', 'nodb-baseline-gate.test.js');
// Whole directories that cannot run, or skip themselves, without a migrated
// database. Skipped — visibly — when there is none.
const NEEDS_DB_DIRS = [path.join(__dirname, 'pin')];

// A file that has not exited after this long is killed and counted as failed.
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS || 120000);
// A single node:test test that runs longer than this fails (and does not hang the file).
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 60000);

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir') >= 0 ? argv[argv.indexOf('--dir') + 1] : null;
const updateBaseline = argv.includes('--update-baseline');
const customDir = dirArg ? path.resolve(dirArg) : null;

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

// ── Discover test files ────────────────────────────────────────────────────
function findTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results.sort();
}

// The name a file is printed (and keyed in the baseline) under: relative to
// tests/ for the files there, as it always was; relative to the repo for src/.
function displayName(file) {
  if (customDir) return path.relative(customDir, file);
  return file.startsWith(TESTS_DIR + path.sep) ? path.relative(TESTS_DIR, file) : path.relative(ROOT, file);
}

const testFiles = customDir
  ? findTests(customDir)
  : findTests(TESTS_DIR).concat(findTests(path.join(ROOT, 'src')));
// The baseline gate goes last, so it sees every other file's result.
if (testFiles.includes(GATE_FILE)) testFiles.push(testFiles.splice(testFiles.indexOf(GATE_FILE), 1)[0]);

// A statement that loads node:test — at the start of a line, so a test that
// merely mentions require('node:test') in a string or comment (the runner's own
// guard writes such files) is not mistaken for one. A file put in the wrong
// mode cannot pass silently either way: it reports no results, or exits
// non-zero, and both are failures.
const NODE_TEST_RE = /^\s*(?:(?:const|let|var)\s+[^=\n]+=\s*require\(\s*['"](?:node:)?test['"]\s*\)|import\s[^\n]*from\s+['"](?:node:)?test['"])/m;
function usesNodeTest(file) {
  try { return NODE_TEST_RE.test(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
}

console.log(`\n🧪 Tashkheesa Test Suite\n${'─'.repeat(50)}`);
console.log(`Found ${testFiles.length} test files\n`);

// ── Database readiness probe ───────────────────────────────────────────────
//
// AUDIT (2026-08-16). ~64 test files guard themselves with
// `if (!process.env.DATABASE_URL) { skip }`. That guard checks whether a
// connection string EXISTS — not whether the database behind it has the app's
// schema. On a developer machine with a local Postgres and no migrations run,
// DATABASE_URL is set, the guard passes, and dozens of integration tests run
// against a database with no orders_active view and no error_logs.category,
// producing a wall of failures that say nothing about the code.
//
// Probe the schema once, up front. If it isn't there, blank DATABASE_URL for
// the run so every one of those files takes its own existing skip path, and
// say plainly why — once, at the top and again in the summary — instead of
// dozens of misleading assertion failures. Files that open their own pool
// regardless are refused a connection (tests/_helpers/no-db-guard.js).
let dbSkipReason = null;

async function probeDatabase() {
  if (!process.env.DATABASE_URL) return 'DATABASE_URL is not set';
  let queryOne;
  try {
    ({ queryOne } = require('../src/pg'));
  } catch (err) {
    return `the pg client could not be loaded (${err.message})`;
  }
  // Two markers, chosen because they are late-migration objects: if these are
  // present the schema is broadly current, and if they are missing the
  // integration tests cannot pass no matter how correct the code is.
  try {
    const view = await queryOne("SELECT to_regclass('public.orders_active') AS v");
    if (!view || !view.v) return 'the orders_active view is missing (migrations 043-045 have not been run)';
    const col = await queryOne(
      "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'error_logs' AND column_name = 'category'"
    );
    if (!col) return 'error_logs.category is missing (the schema is behind the migrations)';
  } catch (err) {
    return `the database could not be queried (${err.message})`;
  }
  return null;
}

// ── Run one file in its own process ────────────────────────────────────────
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tashkheesa-tests-'));
const failuresSoFar = path.join(workDir, 'failures.txt');
let current = null;

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* gone */ } }
}
process.on('SIGINT', () => { if (current) killGroup(current); process.exit(130); });

// Whether this node accepts a flag (--test-force-exit arrived in 20.14 and
// --test-timeout in 20.11; CI pins Node 20). allowedNodeEnvironmentFlags is
// no use here: it lists NODE_OPTIONS flags, and these are not among them.
const flagSupport = {};
function has(flag) {
  if (!(flag in flagSupport)) flagSupport[flag] = spawnSync(process.execPath, [flag, '-e', ''], { stdio: 'ignore' }).status === 0;
  return flagSupport[flag];
}

function nodeTestArgs(resultsFile) {
  return ['--test']
    // End the file when its tests have finished, even if a pool or server is still open.
    .concat(has('--test-force-exit') ? ['--test-force-exit'] : [])
    .concat(has(`--test-timeout=${TEST_TIMEOUT_MS}`) ? [`--test-timeout=${TEST_TIMEOUT_MS}`] : [])
    .concat([
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER}`, `--test-reporter-destination=${resultsFile}`,
    ]);
}

function childEnv(resultsFile, file) {
  const env = Object.assign({}, process.env, { TEST_RUNNER_RESULTS: resultsFile });
  if (dbSkipReason) {
    env.DATABASE_URL = '';
    env.TEST_RUNNER_NO_DB = dbSkipReason;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require "${NO_DB_GUARD}"`.trim();
  }
  if (file === GATE_FILE) {
    env.TEST_RUNNER_FAILURES = failuresSoFar;
    if (dbSkipReason && !customDir) env.TEST_RUNNER_BASELINE_APPLIES = '1';
  }
  return env;
}

function readResults(resultsFile) {
  let text = '';
  try { text = fs.readFileSync(resultsFile, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a torn last line is not a result */ }
  }
  return out;
}

function runFile(file, index) {
  const resultsFile = path.join(workDir, `${index}.ndjson`);
  fs.writeFileSync(resultsFile, '');
  const args = usesNodeTest(file) ? nodeTestArgs(resultsFile).concat([file]) : [RUN_ONE, file];
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: childEnv(resultsFile, file),
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true, // its own process group, so a timeout takes its children with it
      });
    } catch (err) {
      resolve({ code: null, signal: null, timedOut, spawnError: err, results: [] });
      return;
    }
    current = child;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, FILE_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); current = null; resolve({ code: null, signal: null, timedOut, spawnError: err, results: readResults(resultsFile) }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); current = null; resolve({ code, signal, timedOut, results: readResults(resultsFile) }); });
  });
}

(async function main() {
  dbSkipReason = await probeDatabase();
  if (dbSkipReason) {
    console.log(`${YELLOW}⚠  Database integration tests will be SKIPPED:${RESET} ${dbSkipReason}.`);
    console.log(`   Run the migrations against your local Postgres to exercise them.\n`);
  }

  const failureKeys = [];
  let filesWithFailures = 0;

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];
    const rel = displayName(file);
    console.log(`\n📋 ${rel}`);

    let passed = 0, failed = 0, skipped = 0;
    const fail = (name, why) => {
      failed++;
      failureKeys.push(baseline.failureKey(rel, name));
      if (why) console.error(`  ${RED}❌${RESET} ${name}: ${why}`);
    };

    if (dbSkipReason && NEEDS_DB_DIRS.some((d) => file.startsWith(d + path.sep))) {
      skipped++;
      console.log(`  ${YELLOW}⏭️${RESET}  whole file skipped: it needs a migrated database (${dbSkipReason})`);
    } else {
      const run = await runFile(file, i);
      for (const r of run.results) {
        if (r.r === 'pass') passed++;
        else if (r.r === 'skip') skipped++;
        else if (r.r === 'fail') fail(r.name);
      }
      if (run.spawnError) fail('(file) could not be started', run.spawnError.message);
      else if (run.timedOut) fail('(file) timed out', `still running after ${FILE_TIMEOUT_MS / 1000}s — killed`);
      else if ((run.code !== 0 || run.signal) && failed === 0) fail('(file) exited non-zero', `exit ${run.signal || run.code} with no failing test recorded`);
      else if (run.results.length === 0 && failed === 0) fail('(file) reported no results', 'it ran, passed nothing, failed nothing and skipped nothing');
    }

    totalPassed += passed;
    totalFailed += failed;
    totalSkipped += skipped;
    if (failed) filesWithFailures++;
    console.log(`  ${failed ? RED : DIM}↳ ${rel} · ${passed} passed · ${failed} failed · ${skipped} skipped${RESET}`);
    fs.writeFileSync(failuresSoFar, failureKeys.join('\n') + '\n');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${GREEN}Passed:${RESET}  ${totalPassed}`);
  console.log(`${RED}Failed:${RESET}  ${totalFailed}`);
  console.log(`${YELLOW}Skipped:${RESET} ${totalSkipped}`);
  console.log(`Files:   ${testFiles.length} (${filesWithFailures} with failures)`);
  if (dbSkipReason) {
    console.log(`${YELLOW}Note:${RESET}   database integration tests skipped — ${dbSkipReason}`);
  }
  console.log(`${'─'.repeat(50)}\n`);

  if (updateBaseline) {
    if (!dbSkipReason || customDir) {
      console.error(`${RED}--update-baseline needs a no-database run of the whole suite; nothing written.${RESET}`);
      totalFailed++;
    } else {
      const gateRel = displayName(GATE_FILE);
      const keys = failureKeys.filter((k) => !k.startsWith(gateRel + ' :: '));
      fs.writeFileSync(baseline.BASELINE_PATH, baseline.format(keys));
      console.log(`Baseline written: ${keys.length} failure(s) → ${path.relative(ROOT, baseline.BASELINE_PATH)}\n`);
    }
  }

  // TEST_RUNNER_KEEP_RESULTS=1 keeps every file's results (<n>.ndjson, indexed
  // by files.json) for triage, instead of deleting them.
  if (process.env.TEST_RUNNER_KEEP_RESULTS === '1') {
    fs.writeFileSync(path.join(workDir, 'files.json'), JSON.stringify(testFiles.map(displayName), null, 2));
    console.log(`Results kept in ${workDir}\n`);
  } else {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  }
  process.exit(totalFailed > 0 ? 1 : 0);
})();
