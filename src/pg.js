// src/pg.js
// PostgreSQL connection pool and query helpers (replaces better-sqlite3 db).
//
// ============================================================================
// PRODUCTION DEPLOYMENT (Render) — Steps to migrate from SQLite to PostgreSQL:
//
// 1. Add a Render PostgreSQL add-on to the service
//    (Dashboard > Service > Environment > Add PostgreSQL Database)
//
// 2. Set these environment variables on Render:
//    - DATABASE_URL  = <connection string from Render PostgreSQL add-on>
//    - PG_SSL        = true
//
// 3. Run the migration script to copy data from SQLite → PostgreSQL:
//    node scripts/migrate-sqlite-to-pg.js
//
// 4. Remove the old SQLite persistent disk (no longer needed):
//    Dashboard > Service > Disks > Delete
//
// After these steps, the production site will run on PostgreSQL.
// ============================================================================
const { Pool } = require('pg');
const { major: logMajor } = require('./logger');

// Pool tuning. Supabase Free pgbouncer transaction-mode caps client
// connections at 15 per project.
//
// AUDIT-2026-08-22 (AUDIT-BOSS-POOL-2) — default lowered 10 → 8. The old split
// assumed pg-boss needed 4; it registers SIX workers (three with teamSize 2)
// plus maintenance and monitor, and 4 made its own fetch/complete queries queue
// — stalling sla-sweep and auto-assign. The budget is now:
//   8 (this pool) + 6 (pg-boss, src/job_queue.js) + 1 (Supabase internals) = 15
// The boot-time migration advisory-lock Client (src/db.js) is closed before
// pg-boss starts, so it never coincides with the 6.
// Raise via env if the project moves to a higher Supabase tier; lower if a
// second Render instance starts (max × instances must stay under the cap).
//
// connectionTimeoutMillis raised from 5s → 15s: the SLA sweep periodically
// hit the 5s threshold under request-burst contention, throwing
// "timeout exceeded when trying to connect" inside fetchSlaCandidates /
// fetchDoctorTimeouts. 15s tolerates the brief pgbouncer queueing without
// failing fast — request handlers don't sit on pool waits anywhere near
// that long in the steady state.
var PG_POOL_MAX                 = parseInt(process.env.PG_POOL_MAX, 10)                 || 8;
var PG_POOL_CONNECT_TIMEOUT_MS  = parseInt(process.env.PG_POOL_CONNECT_TIMEOUT_MS, 10)  || 15000;
var PG_POOL_IDLE_TIMEOUT_MS     = parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS, 10)     || 30000;
// Theme 5 sub-issue B. Cap any single query at PG_STATEMENT_TIMEOUT_MS so a
// runaway query (missing-index scan, lock wait, network blip mid-stream)
// cannot hold a pool slot indefinitely. 30s default is well above every
// known legitimate OLTP query in this codebase and below the 60s wall
// most upstream proxies (Render edge, Cloudflare) cap at — a slow query
// surfaces a clean 500 from Postgres rather than a 504 from the proxy.
// Override via env if a specific deployment needs different behavior.
var PG_STATEMENT_TIMEOUT_MS     = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10)     || 30000;

// AUDIT-2026-08-22 (AUDIT-POOL-SET-1) — the two `SET`s in the pool.on('connect')
// hook below do NOT hold on the production connection.
//
// WHY: DATABASE_URL on Render is the Supabase TRANSACTION-mode pooler
// (aws-1-us-east-1.pooler.supabase.com:6543). In transaction mode a node-pg
// client is not bound to one backend — the pooler hands each transaction to
// whichever server connection is free — so a `SET` issued once per node-pg
// client configures ONE arbitrary backend and every other backend keeps the
// role default. The pooler also does not run server_reset_query in transaction
// mode, so the stray setting is never cleaned up either. Supabase documents the
// consequence directly for timeouts: a session-level `SET statement_timeout`
// "cannot be used ... with Supavisor in Transaction mode (port 6543)".
//
// Effect before this fix: PG_STATEMENT_TIMEOUT_MS was not enforced (a runaway
// query COULD hold a pool slot indefinitely — the exact failure Theme 5
// sub-issue B was written to close), and the AUDIT-TZ-1 guarantee below was
// not actually held on any backend but the one that happened to receive the SET.
//
// FIX: ask for both settings in the STARTUP packet instead, via libpq's
// `options` connection parameter. Startup options are applied by the *backend*
// when the server connection is established, so every backend the pooler can
// route us to carries them — there is no per-session state to lose.
//
// AUDIT-2026-08-22 (AUDIT-STARTUP-OPTIONS-2) — DEFAULT IS NOW **OFF**. Read this
// before turning it on.
//
// The paragraph above is still the right ANALYSIS; sending `options` by default
// was the wrong ACTION, for one specific reason: **Supavisor consumes the
// `options` startup parameter itself**, for `reference=<project-ref>` tenant
// routing. Supabase's own pooler therefore parses this field looking for
// something else entirely — this is not the generic "poolers vary in whether
// they forward it" risk, it is a known conflict with the exact pooler
// DATABASE_URL points at on this deployment.
//
// The failure mode is total: every pool connection fails, the first pool query
// (src/db.js's `CREATE TABLE IF NOT EXISTS schema_migrations`) throws, and the
// process exits ~2s into boot. There is no partial degradation to notice and no
// second chance — and the previous deploy is already gone. An all-or-nothing
// boot gamble is not worth taking to enforce a setting that has a supported,
// pooler-independent alternative:
//
//   ALTER ROLE <app role> SET timezone = 'UTC';
//   ALTER ROLE <app role> SET statement_timeout = '30s';
//
// Role defaults are applied by the BACKEND at connection start, so they hold on
// every backend the pooler can route to — the exact property `options` was
// reached for. This is what Supabase recommends and it is now the primary
// mechanism. render.yaml lists it as required one-time operator setup and
// preflightPool()/verifyPoolSettings() below report whether it actually took.
//
// TO OPT IN (a non-Supavisor pooler, or a direct connection):
//   PG_STARTUP_OPTIONS=on         → send `-c timezone=UTC -c statement_timeout=<ms>`
//   PG_STARTUP_OPTIONS='-c ...'   → send exactly this string instead
//   PG_STARTUP_OPTIONS=off        → explicit off (same as unset; the default)
// An `options=` already present in DATABASE_URL is left alone either way.
//
// Turning it on is now SAFE TO GET WRONG: preflightPool() retries once WITHOUT
// startup options and logs loudly rather than letting the process exit.
function _withStartupOptions(url) {
  if (!url) return url;
  var override = String(process.env.PG_STARTUP_OPTIONS || '').trim();
  var lowered = override.toLowerCase();
  // Default off (unset / 'off' / 'false' / '0'). Only an explicit opt-in sends it.
  if (!override || lowered === 'off' || lowered === 'false' || lowered === '0') return url;
  if (/[?&]options=/i.test(url)) return url;   // operator set their own — don't fight it
  var optionString = (lowered === 'on' || lowered === 'true' || lowered === '1')
    ? ('-c timezone=UTC -c statement_timeout=' + PG_STATEMENT_TIMEOUT_MS)
    : override;
  var sep = url.indexOf('?') === -1 ? '?' : '&';
  return url + sep + 'options=' + encodeURIComponent(optionString);
}

var PG_CONNECTION_STRING = _withStartupOptions(process.env.DATABASE_URL);
var PG_STARTUP_OPTIONS_APPLIED = !!(PG_CONNECTION_STRING &&
  PG_CONNECTION_STRING !== process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: PG_CONNECTION_STRING,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: PG_POOL_MAX,
  idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: PG_POOL_CONNECT_TIMEOUT_MS
});

// AUDIT-2026-08-22 (AUDIT-POOL-SET-1) — RETAINED AS A FALLBACK, NOT AS THE
// GUARANTEE. Read the _withStartupOptions comment above first.
//
// On a DIRECT / session-mode connection (local dev, DATABASE_URL_DIRECT, a
// psql-style deployment) these SETs are exactly what they always were and
// still do the job. On the production TRANSACTION-mode pooler they configure
// at most one backend and cannot be relied on — the `options=` startup
// parameter added above is what actually holds there. Keeping them costs two
// round-trips per NEW physical connection and buys correctness on every
// non-pooled deployment plus any deploy running PG_STARTUP_OPTIONS=off.
//
// Failure to SET is logged but non-fatal — the connection still works.
pool.on('connect', function (client) {
  // AUDIT-TZ-1 — SET TIME ZONE 'UTC' is the single most load-bearing line in
  // this file. Read the whole comment before changing it.
  //
  // ── WHAT THIS LINE ORIGINALLY FIXED ─────────────────────────────────────
  // Every SLA timestamp on `orders` and `doctor_assignments` used to be
  // `TIMESTAMP` — WITHOUT time zone (migrations 001, 010, 080). Application
  // writes are JS `.toISOString()` strings, i.e. UTC; PostgreSQL stores a naive
  // column by DISCARDING the offset, so the digits on disk were UTC. The
  // session TimeZone was never pinned and inherited the role default, which on
  // production is Africa/Cairo (UTC+2, UTC+3 under DST) — so
  // `deadline_at <= NOW()::timestamp` compared UTC digits against a CAIRO wall
  // clock and every deadline read 2-3 hours further past than it was:
  //   * The SLA breach sweep selected cases ~3h early. handleBreach reassigned
  //     the case and clawed the original doctor back to 10% partial pay for an
  //     SLA they had NOT missed.
  //   * Acceptance windows (10/60/240 min at the time) were ALL shorter than
  //     the skew, so acceptance_watcher saw every broadcast order as already
  //     expired on the first tick. The broadcast/accept handshake never ran.
  //   * Doctor and admin dashboards understated remaining time by 3h and
  //     disagreed with the JS-computed patient countdown (which was right).
  //   * Where markSlaBreach's JS re-check fell through (accepted_at or
  //     sla_hours NULL), issueBreachRefund opened a real refund obligation 3h
  //     early.
  //
  // ── WHAT MIGRATION 081 CHANGED (2026-08) ────────────────────────────────
  // 081_timestamptz_sla_columns.sql converted EVERY `timestamp without time
  // zone` column on `orders` and `doctor_assignments` to `timestamptz`,
  // data-driven from information_schema — deadline_at, sla_deadline,
  // acceptance_deadline_at, accepted_at, completed_at, breached_at,
  // sla_paused_at, created_at, updated_at, reassigned_at, and the
  // doctor_assignments equivalents (assigned_at, accepted_at, accept_by_at,
  // completed_at), using `AT TIME ZONE 'UTC'` — which states what the digits
  // already were. On those two tables the type no longer lies, and a plain
  // `NOW()` comparison is now unambiguous regardless of session zone.
  //
  // Consequence for query authors: on orders / doctor_assignments, do NOT cast.
  // `deadline_at <= NOW()` is correct; `(NOW() + INTERVAL '60 minutes')
  // ::timestamp` re-introduces the naive/aware split on one side of a WHERE
  // clause (that exact bug survived 081 in case_sla_worker.fetchPreBreachCandidates
  // until LAUNCH-TZ-3 removed it).
  //
  // ── WHAT IS STILL NAIVE, AND WHY THIS LINE IS STILL LOAD-BEARING ────────
  // 081 touched two tables. Everything else that stores time is untouched, and
  // the ones that matter are:
  //   * refunds.refunded_at         TIMESTAMP DEFAULT NOW()   (028) — naive,
  //     and DEFAULT NOW() means the DEFAULT itself writes the session's wall
  //     clock. Without this pin, refund timestamps drift by the Cairo offset.
  //   * appointments.scheduled_at   TIMESTAMP NOT NULL        (004) — naive,
  //     and it is compared against NOW() by the video/appointment reminders.
  //   * cases.paid_at               TIMESTAMP                 (001) — naive
  //     (orders.paid_at is timestamptz via 020/032; the `cases` table's is not).
  //   * appointments.rescheduled_at / created_at, cases.created_at /
  //     updated_at / breached_at / sla_deadline / sla_paused_at, and the
  //     assorted `at TIMESTAMP DEFAULT NOW()` audit columns from 001.
  //   (critical_alert_log.sent_at is TIMESTAMPTZ — 049 — despite what earlier
  //    versions of this comment and the audit ticket claimed. Verified against
  //    the migration, not assumed.)
  //
  // For every one of those, the old reasoning still applies in full: the digits
  // on disk are UTC (JS writers) or session-local (SQL-side NOW() writers), and
  // only a UTC session makes the two agree. Unpinning this would silently skew
  // refunds and appointments by 2-3h while orders stayed correct — a strictly
  // harder bug to spot than the original, because half the system would look
  // fine.
  //
  // Converting the rest is the right long-term fix and is NOT blocked by
  // anything structural — 081 is the worked example, including the
  // drop-and-recreate-views dance that `ALTER COLUMN ... TYPE` forces. The one
  // thing it has to reckon with is the columns historically written by SQL-side
  // NOW() before the session was pinned (created_at, updated_at, reassigned_at,
  // doctor_assignments.completed_at), which hold Cairo digits and need a
  // different USING clause from the JS-written ones. 081 accepted that for
  // audit/display columns on the grounds that no deadline, breach or payment
  // decision reads them; a follow-up migration must make the same call
  // explicitly for each table it converts.
  //
  // Node itself must also be UTC for the JS-side halves to agree — see the
  // assertion in src/server.js.
  client.query("SET TIME ZONE 'UTC'").catch(function (err) {
    logMajor('[pg] FAILED to SET TIME ZONE UTC on new client: ' + err.message +
             ' — SLA deadlines on this connection will be skewed by the DB default offset');
  });
  client.query('SET statement_timeout = ' + PG_STATEMENT_TIMEOUT_MS).catch(function (err) {
    logMajor('[pg] failed to SET statement_timeout on new client: ' + err.message);
  });
});

// Theme 5 sub-issue D. Boot-time visibility on the pool config + the two
// env knobs the rest of Theme 5 depends on. Operations should be able to
// confirm-with-one-grep that the deployed instance is in the configuration
// the architecture comment above claims it is.
//
// AUDIT-2026-08-22 (AUDIT-POOL-SET-1) — this line used to print
// `statement_timeout=30000ms` as though it were a fact about the database. It
// was a fact about a local variable. It now says what was REQUESTED and by
// which mechanism; what was actually OBSERVED is reported separately by
// verifyPoolSettings() below, which asks real connections.
var _modeForLog   = String(process.env.MODE || process.env.NODE_ENV || 'unknown').trim().toLowerCase() || 'unknown';
var _directUrlSet = process.env.DATABASE_URL_DIRECT ? 'set' : 'not set';

logMajor('[pg] pool ready: max=' + PG_POOL_MAX +
  ' connect=' + PG_POOL_CONNECT_TIMEOUT_MS + 'ms' +
  ' idle=' + PG_POOL_IDLE_TIMEOUT_MS + 'ms' +
  ' statement_timeout=' + PG_STATEMENT_TIMEOUT_MS + 'ms (requested)');
logMajor('[pg] startup options: ' + (PG_STARTUP_OPTIONS_APPLIED
  ? 'sent via connection-string options= (timezone=UTC, statement_timeout=' +
    PG_STATEMENT_TIMEOUT_MS + ') — OPT-IN via PG_STARTUP_OPTIONS; preflight will ' +
    'fall back automatically if the pooler rejects it'
  : 'NOT sent (default since AUDIT-STARTUP-OPTIONS-2 — Supavisor uses the ' +
    '`options` startup parameter for its own tenant routing). timezone and ' +
    'statement_timeout must come from `ALTER ROLE ... SET ...` on the app role; ' +
    'the per-connection SETs below are a fallback, NOT a guarantee on a ' +
    'transaction-mode pooler. See verifyPoolSettings output.'));
logMajor('[pg] env: mode=' + _modeForLog + ' DATABASE_URL_DIRECT=' + _directUrlSet);

/**
 * AUDIT-2026-08-22 (AUDIT-POOL-SET-1) — say only what we actually checked.
 *
 * Opens `sampleSize` pool connections CONCURRENTLY (so they cannot be the same
 * pooler-side backend re-handed to us) and reads back TimeZone and
 * statement_timeout from each. Reports the DISTINCT values observed.
 *
 * Honest about its own limits: on a transaction-mode pooler N client
 * connections still do not guarantee N distinct BACKENDS, so agreement across
 * the sample is strong evidence, not proof. Disagreement, on the other hand,
 * is proof of the bug — which is the case this exists to catch.
 *
 * Never throws; a verification failure must not take the process down.
 * Set PG_VERIFY_SETTINGS=off to skip entirely.
 *
 * @param {number} [sampleSize]
 * @returns {Promise<{ok:boolean, timezones?:string[], timeouts?:string[], sampled?:number, error?:string}>}
 */
async function verifyPoolSettings(sampleSize) {
  // AUDIT-2026-08-22 (AUDIT-POOL-SAMPLE-1) — this used to grab min(5, PG_POOL_MAX)
  // slots CONCURRENTLY, i.e. half the request pool, on a 15s timer that landed
  // exactly as Render ramps traffic onto the new instance. It now runs once from
  // migrate(), BEFORE app.listen, so it competes with nothing — and the sample is
  // capped at 3 and at half the pool anyway, so it cannot starve the pool even if
  // a future caller invokes it on a live instance.
  // AUDIT-2026-08-22 — PG_VERIFY_SETTINGS=off used to be honoured by the
  // setTimeout that armed this; that timer is gone, so the switch is read here.
  if (!process.env.DATABASE_URL ||
      String(process.env.PG_VERIFY_SETTINGS || '').trim().toLowerCase() === 'off') {
    return { ok: false, skipped: true };
  }
  var cap = Math.max(1, Math.min(3, Math.floor(PG_POOL_MAX / 2) || 1));
  var n = Math.max(1, Math.min(parseInt(sampleSize, 10) || cap, cap));
  var clients = [];
  try {
    for (var i = 0; i < n; i++) clients.push(pool.connect());
    var settled = await Promise.all(clients);
    var reads = await Promise.all(settled.map(function (c) {
      return c.query('SHOW timezone').then(function (tzr) {
        return c.query('SHOW statement_timeout').then(function (str) {
          return {
            tz: tzr.rows[0] ? (tzr.rows[0].TimeZone || tzr.rows[0].timezone) : 'unknown',
            st: str.rows[0] ? (str.rows[0].statement_timeout) : 'unknown'
          };
        });
      });
    }));
    settled.forEach(function (c) { try { c.release(); } catch (_) {} });

    var tzs = reads.map(function (r) { return String(r.tz); })
      .filter(function (v, ix, a) { return a.indexOf(v) === ix; });
    var sts = reads.map(function (r) { return String(r.st); })
      .filter(function (v, ix, a) { return a.indexOf(v) === ix; });

    var tzOk = tzs.length === 1 && tzs[0].toUpperCase() === 'UTC';
    var stOk = sts.length === 1 && sts[0] !== '0';

    logMajor('[pg] verified on ' + n + ' concurrent connection(s): timezone=' +
      tzs.join('|') + (tzOk ? ' (ok)' : ' (NOT UNIFORM UTC — naive timestamp ' +
      'columns are being read at the wrong offset on at least one backend)') +
      ' statement_timeout=' + sts.join('|') +
      (stOk ? ' (ok)' : ' (NOT ENFORCED — a runaway query can hold a pool slot ' +
      'indefinitely; see PG_STARTUP_OPTIONS in .env.example)'));

    return { ok: tzOk && stOk, timezones: tzs, timeouts: sts, sampled: n };
  } catch (err) {
    clients.forEach(function (pr) {
      Promise.resolve(pr).then(function (c) { try { c.release(); } catch (_) {} },
                               function () {});
    });
    logMajor('[pg] could NOT verify timezone/statement_timeout: ' + err.message +
      ' — treat both as UNKNOWN on this instance');
    return { ok: false, error: err.message };
  }
}

/**
 * AUDIT-2026-08-22 (AUDIT-STARTUP-OPTIONS-2) — prove the pool can connect AT ALL,
 * and self-heal the one failure this file can cause.
 *
 * WHY IT REPLACED A TIMER: verifyPoolSettings used to be armed on a 15s
 * setTimeout, which could never fire in the case it existed to diagnose. The
 * first pool query in the process is src/db.js's
 * `CREATE TABLE IF NOT EXISTS schema_migrations`, ~2s in; if the pooler rejects
 * the `options` startup parameter that query throws, server.js exits, and the
 * only log line is "migrate failed". The diagnostic has to run BEFORE the first
 * migration query or it is decoration — so src/db.js's migrate() awaits this and
 * verifyPoolSettings() as its first two statements.
 *
 * SELF-HEAL: an `options`-shaped connection failure is recoverable — the setting
 * it carries has a documented alternative (ALTER ROLE). Rather than exiting, we
 * strip the startup options and retry once. pg-pool builds every new client from
 * `pool.options`, and at this point in boot NO connection has ever succeeded, so
 * there is no live client carrying the old string to worry about.
 *
 * Never throws. A genuine DB outage still surfaces where it always did — as the
 * migration query's own error — with a clearer preceding log line.
 *
 * @returns {Promise<{ok:boolean, healed?:boolean, error?:string, skipped?:boolean}>}
 */
async function preflightPool() {
  if (!process.env.DATABASE_URL) return { ok: false, skipped: true };
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    if (!PG_STARTUP_OPTIONS_APPLIED) {
      logMajor('[pg] preflight FAILED: ' + msg + ' — the database is unreachable or ' +
        'rejecting this connection string. Startup options were not in play.');
      return { ok: false, error: msg };
    }
    logMajor('[pg] preflight FAILED with startup options in the connection string: ' +
      msg + ' — this is the documented `options=` rejection (Supavisor consumes that ' +
      'startup parameter for tenant routing). RETRYING WITHOUT startup options. ' +
      'Set PG_STARTUP_OPTIONS=off to make this permanent, and set timezone / ' +
      'statement_timeout with `ALTER ROLE <app role> SET ...` instead.');
    try {
      // pg-pool builds every new client with `new this.Client(this.options)`, so
      // rewriting connectionString here changes what the NEXT connection uses.
      // Defensive: if a future pg-pool stops exposing `options`, say so rather
      // than throwing inside a function documented as never throwing.
      if (!pool.options) {
        logMajor('[pg] cannot self-heal: this pg-pool build does not expose ' +
          'pool.options. Set PG_STARTUP_OPTIONS=off on the service and redeploy.');
        return { ok: false, error: msg };
      }
      pool.options.connectionString = process.env.DATABASE_URL;
      PG_STARTUP_OPTIONS_APPLIED = false;
      await pool.query('SELECT 1');
      logMajor('[pg] preflight recovered WITHOUT startup options. timezone and ' +
        'statement_timeout are NOT guaranteed on this pooler until the ALTER ROLE ' +
        'defaults are in place — check the verification line below.');
      return { ok: true, healed: true };
    } catch (err2) {
      var msg2 = err2 && err2.message ? err2.message : String(err2);
      logMajor('[pg] preflight STILL failing without startup options: ' + msg2 +
        ' — this is not an options problem. Check DATABASE_URL, PG_SSL and whether ' +
        'the Supabase project is paused.');
      return { ok: false, error: msg2 };
    }
  }
}

// Supabase Free pgbouncer caps client connections at 15 per project.
// AUDIT-2026-08-22 (AUDIT-BOSS-POOL-2) — the threshold follows the corrected
// split: 8 here + 6 for pg-boss + 1 for Supabase internals. Anything above 8
// eats into pg-boss's share, which is what stalls sla-sweep and auto-assign.
if (PG_POOL_MAX > 8) {
  logMajor('[pg] WARNING: PG_POOL_MAX=' + PG_POOL_MAX + ' exceeds its share of the ' +
    'Supabase Free 15-slot ceiling (8 request pool + 6 pg-boss + 1 internals). ' +
    'Lower PG_BOSS_POOL_MAX to match, run only ONE Render instance, or upgrade the ' +
    'Supabase tier.');
}

pool.on('error', (err) => {
  logMajor('Unexpected PG pool error: ' + err.message);
});

/**
 * Fetch a single row (replaces db.prepare(sql).get(...params)).
 * @param {string} sql - SQL with $1, $2, ... placeholders
 * @param {Array} params - Bind parameters
 * @returns {Promise<Object|null>} First row or null
 */
async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

/**
 * Fetch all rows (replaces db.prepare(sql).all(...params)).
 * @param {string} sql - SQL with $1, $2, ... placeholders
 * @param {Array} params - Bind parameters
 * @returns {Promise<Array>} Array of row objects
 */
async function queryAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Execute a statement (replaces db.prepare(sql).run(...params)).
 * @param {string} sql - SQL with $1, $2, ... placeholders
 * @param {Array} params - Bind parameters
 * @returns {Promise<{rowCount: number}>} Result with rowCount
 */
async function execute(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

/**
 * Run a callback inside a single PG transaction (replaces db.transaction).
 * The callback receives a dedicated client. Use `client.query(sql, params)`.
 * Auto-commits on success, auto-rolls-back on error.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // AUDIT-P1-4: a failing ROLLBACK used to (a) replace the original error and
    // (b) still release the client back to the pool. node-pg does not reset a
    // released connection, so a client left inside an aborted transaction was
    // handed to the next borrower, who got "current transaction is aborted,
    // commands ignored until end of transaction block" — and the real cause was
    // already lost. Swallow the rollback failure, keep the original error, and
    // pass it to release() so the pool DESTROYS the connection instead of
    // reusing it.
    let rollbackFailed = null;
    try { await client.query('ROLLBACK'); }
    catch (rollbackErr) { rollbackFailed = rollbackErr; }
    if (rollbackFailed) {
      try { client.release(rollbackFailed); } catch (_) {}
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

module.exports = { pool, queryOne, queryAll, execute, withTransaction, verifyPoolSettings, preflightPool };
