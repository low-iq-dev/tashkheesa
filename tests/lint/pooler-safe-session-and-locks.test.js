// tests/lint/pooler-safe-session-and-locks.test.js
//
// Part B item 12 (2026-09-13) — verified present, pinned so it stays.
//
// DATABASE_URL on Render is Supabase's TRANSACTION-mode pooler, where nothing
// session-scoped survives: a SET in pool.on('connect') lands on one arbitrary
// backend, a session advisory lock taken on one client can be "unlocked" on
// another, and any pool without a `max` eats the project-wide connection
// budget. All three were audited fixed (AUDIT-2026-08-22); this lint keeps
// them fixed.
//
//   1. src/pg.js — timezone / statement_timeout are NOT sent as startup
//      `options` by default (Supavisor consumes that parameter for tenant
//      routing; sending it makes every connection fail at boot). The
//      guarantee is ALTER ROLE … SET, documented in render.yaml, with an
//      explicit PG_STARTUP_OPTIONS opt-in for non-Supavisor poolers. The
//      per-connection SETs remain only as a documented fallback.
//   2. src/services/worker_watchdog.js — pg_try_advisory_XACT_lock inside an
//      explicit BEGIN/COMMIT on a pinned client; no pg_advisory_unlock.
//   3. src/job_queue.js — pg-boss is constructed with an explicit `max`.
//
// Verified NEGATIVELY: making _withStartupOptions send options by default
// fails (1); swapping the xact lock for pg_try_advisory_lock fails (2);
// removing `max:` from the PgBoss constructor fails (3).

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🧵 Part B-12 — pooler-safe session settings, locks and pool sizes\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function raw(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const PG = code('src/pg.js');
const WD = code('src/services/worker_watchdog.js');
const JQ = code('src/job_queue.js');

check('pg.js: startup options are opt-in (PG_STARTUP_OPTIONS), never sent by default', () => {
  const fn = PG.slice(PG.indexOf('function _withStartupOptions('), PG.indexOf('var PG_CONNECTION_STRING'));
  if (!fn) return '_withStartupOptions not found';
  if (!/if \(!override \|\| lowered === 'off' \|\| lowered === 'false' \|\| lowered === '0'\) return url;/.test(fn)) return 'the default-off branch is gone — Supavisor consumes `options` and the process would fail at boot';
  if (!/PG_STARTUP_OPTIONS/.test(fn)) return 'opt-in env var removed';
});
check('pg.js: the pooler-independent guarantee (ALTER ROLE … SET) is documented in render.yaml', () => {
  const ry = raw('render.yaml');
  if (!/ALTER ROLE[\s\S]{0,200}SET (timezone|statement_timeout)/i.test(ry)) return 'render.yaml no longer documents the ALTER ROLE step';
});
check('pg.js: the pool.on(\'connect\') SETs are still marked as a fallback, not the guarantee', () => {
  if (!/pool\.on\('connect'/.test(PG)) return 'connect hook gone (fine only if the ALTER ROLE step is the sole mechanism — update this lint)';
  if (!/RETAINED AS A FALLBACK/.test(raw('src/pg.js'))) return 'the fallback caveat comment was removed';
});
check('worker_watchdog: claims with pg_try_advisory_xact_lock inside BEGIN/COMMIT, never a session lock', () => {
  if (!/pg_try_advisory_xact_lock\(\$1\)/.test(WD)) return 'xact lock gone';
  if (/pg_try_advisory_lock\(/.test(WD) || /pg_advisory_unlock\(/.test(WD)) return 'a session-scoped advisory lock/unlock is back — on a transaction pooler the unlock can land on another backend';
  const i = WD.indexOf('pg_try_advisory_xact_lock');
  const around = WD.slice(i - 400, i + 2500);
  if (!/query\('BEGIN'\)/.test(around) || !/query\('COMMIT'\)/.test(around)) return 'the lock is not inside an explicit BEGIN … COMMIT';
});
check('job_queue: pg-boss is constructed with an explicit max', () => {
  const i = JQ.indexOf('new PgBoss({');
  if (i < 0) return 'PgBoss constructor not found';
  if (!/max:\s*PG_BOSS_POOL_MAX/.test(JQ.slice(i, i + 400))) return 'no `max` on the pg-boss pool — it would eat the project-wide connection budget';
});
