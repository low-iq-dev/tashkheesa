#!/usr/bin/env node
// tests/run.js — Tashkheesa test runner
// Runs all test files, skips any that require SQLite (legacy)
// Compatible with PostgreSQL-only setup

const path = require('path');
const fs   = require('fs');

// Load .env before anything else. The individual test files each call
// dotenv.config() themselves, but the readiness probe below runs BEFORE any of
// them — without this it would report "DATABASE_URL is not set" on a machine
// where it is set in .env, and skip every integration test unconditionally.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

// ── Shared test helpers exported to test files ─────────────────────────────
global._testRunner = {
  pass: (name) => { totalPassed++; console.log(`  ${GREEN}✅${RESET} ${name}`); },
  fail: (name, err) => { totalFailed++; console.error(`  ${RED}❌${RESET} ${name}: ${err.message || err}`); },
  skip: (name, reason) => { totalSkipped++; console.log(`  ${YELLOW}⏭️${RESET}  ${name} (skipped: ${reason})`); },
};

// ── Discover test files ────────────────────────────────────────────────────
// tests/pin/ is excluded: those tests need a real Postgres with the app's
// schema and are designed for the long-running async pattern that the
// require()-based runner here doesn't await. Run them with
// `npm run test:pin` after migrations.
function findTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'pin') {
      results.push(...findTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

const testsDir = path.join(__dirname);
const testFiles = findTests(testsDir).filter(f => !f.includes('run.js'));

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
// dozens of misleading assertion failures.
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

// ── Async straggler drain ──────────────────────────────────────────────────
//
// AUDIT (2026-08-16). The file loop below is synchronous: it require()s each
// file and moves on. Source-grep tests finish inside that require; database
// tests do not — they kick off promises that resolve long after. The summary
// was printed the instant the loop ended, so those results landed in an
// already-printed tally and an already-decided exit code. The suite could and
// did report "Failed: 0" while 47 assertions had failed, and exit 0 with it.
// tests/run.js even carried a comment acknowledging this pattern (it is why
// tests/pin is excluded) — these files were simply never covered by it.
//
// Wait for the counters to stop moving before reporting. Bounded, so a hung
// connection cannot make the suite hang forever — and a timeout is reported
// as a failure rather than passed over.
function counterTotal() { return totalPassed + totalFailed + totalSkipped; }

async function drainAsyncResults({ quietMs = 2000, maxMs = 120000 }) {
  const startedAt = Date.now();
  const before = counterTotal();
  let last = before;
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < maxMs) {
    await new Promise((r) => setTimeout(r, 250));
    const now = counterTotal();
    if (now !== last) { last = now; lastChangeAt = Date.now(); continue; }
    if (Date.now() - lastChangeAt >= quietMs) {
      return { late: counterTotal() - before, timedOut: false };
    }
  }
  return { late: counterTotal() - before, timedOut: true };
}

(async function main() {
  dbSkipReason = await probeDatabase();
  if (dbSkipReason) {
    // Every DB-gated file already skips cleanly on an absent DATABASE_URL.
    process.env.DATABASE_URL = '';
    console.log(`${YELLOW}⚠  Database integration tests will be SKIPPED:${RESET} ${dbSkipReason}.`);
    console.log(`   Run the migrations against your local Postgres to exercise them.\n`);
  }

  // ── Run each test file ───────────────────────────────────────────────────
  for (const file of testFiles) {
    const rel = path.relative(testsDir, file);
    console.log(`\n📋 ${rel}`);
    try {
      // AUDIT (2026-08-16) — await the file before starting the next one.
      //
      // Async test files now `module.exports = (async function () { … })()`, so
      // the runner can wait for them. Previously they were fire-and-forget:
      // the runner require()d a file, the file's async body started, and the
      // runner immediately loaded the NEXT file while it was still running.
      // Test files share process.env and the require cache, so they were
      // racing each other through global state — tests/core/email-stub-mode
      // sets EMAIL_TEST_STUB=true and restores it in a `finally`, but by then
      // emailService.guard had already run against the flipped flag and failed
      // on a condition its own code never created. Both files pass alone.
      //
      // Serialising them removes a whole class of phantom failure.
      const exported = require(file);
      if (exported && typeof exported.then === 'function') await exported;
    } catch (err) {
      // If it's a SQLite/legacy error, skip gracefully
      if (err.message && (err.message.includes('better-sqlite3') || err.message.includes('sqlite3') || err.message.includes('portal.db'))) {
        totalSkipped++;
        console.log(`  ${YELLOW}⏭️${RESET}  Skipped (SQLite legacy test — not applicable with PostgreSQL)`);
      } else {
        totalFailed++;
        console.error(`  ${RED}❌${RESET} Test file crashed: ${err.message}`);
      }
    }
  }

  const drain = await drainAsyncResults({});
  if (drain.late > 0) {
    console.log(`\n${YELLOW}⏳ ${drain.late} result(s) arrived asynchronously after the last file loaded${RESET}`);
    console.log(`   (counted below — before 2026-08-16 these were printed but never tallied)`);
  }
  if (drain.timedOut) {
    totalFailed++;
    console.error(`\n  ${RED}❌${RESET} async test results were still arriving after 120s — the suite gave up waiting. Some results may be missing from the tally below.`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${GREEN}Passed:${RESET}  ${totalPassed}`);
  console.log(`${RED}Failed:${RESET}  ${totalFailed}`);
  console.log(`${YELLOW}Skipped:${RESET} ${totalSkipped}`);
  if (dbSkipReason) {
    console.log(`${YELLOW}Note:${RESET}   database integration tests skipped — ${dbSkipReason}`);
  }
  console.log(`${'─'.repeat(50)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
})();
