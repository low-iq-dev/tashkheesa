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
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, queryOne, queryAll, execute, withTransaction };
