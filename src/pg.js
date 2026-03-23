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

var PG_POOL_MAX = parseInt(process.env.PG_POOL_MAX, 10) || 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

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
