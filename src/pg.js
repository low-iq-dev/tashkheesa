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
// connections at 15 per project; running a single Render instance with
// max=10 leaves headroom for pg-boss direct (port 5432, separate pool),
// Supabase internal connections, and burst spikes. Raise via env if the
// project moves to a higher Supabase tier; lower if a second Render
// instance starts (max × instances must stay under the pgbouncer cap).
//
// connectionTimeoutMillis raised from 5s → 15s: the SLA sweep periodically
// hit the 5s threshold under request-burst contention, throwing
// "timeout exceeded when trying to connect" inside fetchSlaCandidates /
// fetchDoctorTimeouts. 15s tolerates the brief pgbouncer queueing without
// failing fast — request handlers don't sit on pool waits anywhere near
// that long in the steady state.
var PG_POOL_MAX                 = parseInt(process.env.PG_POOL_MAX, 10)                 || 10;
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: PG_POOL_MAX,
  idleTimeoutMillis: PG_POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: PG_POOL_CONNECT_TIMEOUT_MS
});

// Apply statement_timeout to every new pool connection. Fires once per
// physical connection (connection reuse keeps the SET; the pool reissues
// it only when the underlying socket is recreated). Failure to SET is
// logged but non-fatal — the connection still works, just without the cap.
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
var _modeForLog   = String(process.env.MODE || process.env.NODE_ENV || 'unknown').trim().toLowerCase() || 'unknown';
var _directUrlSet = process.env.DATABASE_URL_DIRECT ? 'set' : 'not set';

logMajor('[pg] pool ready: max=' + PG_POOL_MAX +
  ' connect=' + PG_POOL_CONNECT_TIMEOUT_MS + 'ms' +
  ' idle=' + PG_POOL_IDLE_TIMEOUT_MS + 'ms' +
  ' statement_timeout=' + PG_STATEMENT_TIMEOUT_MS + 'ms');
logMajor('[pg] env: mode=' + _modeForLog + ' DATABASE_URL_DIRECT=' + _directUrlSet);

// Supabase Free pgbouncer caps client connections at 15 per project.
// max=10 leaves headroom for pg-boss direct (separate pool, see job_queue.js)
// + Supabase internal heartbeats + burst. Anything above 12 starts cutting
// into that headroom; with two Render instances it cuts into the actual
// 15-slot ceiling. Warn loud — it's almost always a misconfiguration.
if (PG_POOL_MAX > 12) {
  logMajor('[pg] WARNING: PG_POOL_MAX=' + PG_POOL_MAX + ' is close to the ' +
    'Supabase Free 15-slot ceiling. Reduce to ≤12 if running >1 Render instance, ' +
    'or upgrade Supabase tier.');
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

module.exports = { pool, queryOne, queryAll, execute, withTransaction };
