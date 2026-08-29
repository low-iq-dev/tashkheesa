// src/sql-utils.js
const { queryOne, queryAll, pool } = require('./pg');
const { major: logMajor } = require('./logger');

/**
 * Check if a table exists in the database.
 * Used for schema compatibility checks.
 *
 * @param {string} name - Table name
 * @returns {Promise<boolean>} True if table exists
 */
async function tableExists(name) {
  try {
    const row = await queryOne(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=$1",
      [name]
    );
    return !!row;
  } catch (err) {
    logMajor(`tableExists check failed for ${name}: ${err.message}`);
    return false;
  }
}

/**
 * Safely fetch multiple rows from database.
 * Use for NON-CRITICAL queries where missing data is acceptable.
 * Errors are logged but swallowed - function returns fallback value.
 *
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @param {*} fallback - Value to return if query fails (default: [])
 * @returns {Promise<Array>} Query results or fallback
 *
 * @example
 * // Good: Optional data, graceful degradation acceptable
 * const notifications = await safeAll('SELECT * FROM notifications LIMIT 10', [], []);
 *
 * @example
 * // Bad: Critical operation, needs to fail loud
 * const user = await safeAll('SELECT * FROM users WHERE id = $1', [userId]);
 * // ^ Use queryAll directly instead, or throw error
 */
async function safeAll(sql, params = [], fallback = []) {
  try {
    return await queryAll(sql, params);
  } catch (err) {
    logMajor(`SQL safeAll failed: ${err.message}`);
    return fallback;
  }
}

/**
 * Safely fetch a single row from database.
 * Use for NON-CRITICAL queries where missing data is acceptable.
 * Errors are logged but swallowed - function returns fallback value.
 *
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @param {*} fallback - Value to return if query fails (default: null)
 * @returns {Promise<Object|*>} Query result or fallback
 *
 * @example
 * // Good: Optional user info, null is acceptable
 * const user = await safeGet('SELECT * FROM users WHERE id = $1', [userId], null);
 * if (!user) { // use default }
 *
 * @example
 * // Bad: Critical operation, needs to fail loud
 * const user = await safeGet('SELECT * FROM users WHERE id = $1', [userId]);
 * // ^ Use queryOne directly instead and handle errors properly
 */
async function safeGet(sql, params = [], fallback = null) {
  try {
    return await queryOne(sql, params);
  } catch (err) {
    logMajor(`SQL safeGet failed: ${err.message}`);
    return fallback;
  }
}

/**
 * === PHASE 3: FIX #20 - ERROR HANDLING CONSISTENCY ===
 * === AUDIT 2026-08-29 — renamed getOrThrow → mustGet (old name kept as an alias) ===
 *
 * Execute a query and throw on error (for critical operations).
 * Use for operations that MUST succeed or fail loudly.
 * Errors are not caught - they bubble up to caller.
 *
 * WHY THIS PAIR EXISTS, AND WHY THE MONEY SCREENS MUST USE IT.
 *
 * safeGet/safeAll above swallow EVERY error and hand back null/[]. For genuinely
 * optional data that is correct and deliberate. For a KPI it is a lie with a
 * 200 on it: the handler carries on, `Number(null) || 0` becomes 0, and the app
 * renders "EGP 0 owed" — the founder reads his largest liability as settled.
 *
 * This is reachable in production, not theoretical: src/pg.js pins
 * statement_timeout to 30s, and a query that exceeds it raises SQLSTATE 57014.
 * safeGet caught it, logged one line to stdout, and GET /pulse answered
 * 200 {"kpis":{"activeCases":0,…}} — the app's error state never rendered
 * because nothing ever told it there was an error.
 *
 * So every money/KPI query goes through mustGet/mustAll and the route's
 * existing `catch` block — the one already commented "Honest failure over
 * fabricated zeros" — finally becomes reachable and returns the 500.
 *
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 * @throws {Error} If query fails
 *
 * @example
 * // Good: Critical operation, must succeed
 * try {
 *   const user = await mustGet('SELECT * FROM users WHERE id = $1', [userId]);
 *   // user is guaranteed to exist or error was thrown
 * } catch (err) {
 *   // Handle critical error (user not found, DB error, etc)
 *   logFatal('Failed to load user', err);
 *   return res.status(500).send('Internal error');
 * }
 */
async function mustGet(sql, params = []) {
  return await queryOne(sql, params);
}

/**
 * === PHASE 3: FIX #20 - ERROR HANDLING CONSISTENCY ===
 * === AUDIT 2026-08-29 — renamed allOrThrow → mustAll (old name kept as an alias) ===
 *
 * Execute a query and throw on error (for critical operations).
 * Use for operations that MUST succeed or fail loudly.
 * Errors are not caught - they bubble up to caller. See the long note on
 * mustGet above for why every money/KPI list uses this and not safeAll.
 *
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 * @throws {Error} If query fails
 *
 * @example
 * // Good: Critical operation, must succeed
 * try {
 *   const users = await mustAll('SELECT * FROM users WHERE role = $1', ['doctor']);
 *   // users is guaranteed to be valid or error was thrown
 * } catch (err) {
 *   // Handle critical error
 * }
 */
async function mustAll(sql, params = []) {
  return await queryAll(sql, params);
}

module.exports = {
  tableExists,
  safeAll,
  safeGet,
  mustGet,        // === AUDIT 2026-08-29: fail-loud read for money/KPI queries
  mustAll,        // === AUDIT 2026-08-29: fail-loud read for money/KPI queries
  // Legacy names for the same two functions. Kept so an older import cannot
  // break; new call sites should use mustGet/mustAll, which is what the
  // tests/lint/kpi-endpoints-fail-loud guard looks for.
  getOrThrow: mustGet,
  allOrThrow: mustAll,
};
