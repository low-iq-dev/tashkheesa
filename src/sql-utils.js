// src/sql-utils.js
const { db } = require('./db');
const { major: logMajor } = require('./logger');

/**
 * Check if a table exists in the database.
 * Used for schema compatibility checks.
 *
 * @param {string} name - Table name
 * @returns {boolean} True if table exists
 */
function tableExists(name) {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
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
 * @returns {Array} Query results or fallback
 * 
 * @example
 * // Good: Optional data, graceful degradation acceptable
 * const notifications = safeAll('SELECT * FROM notifications LIMIT 10', [], []);
 * 
 * @example
 * // Bad: Critical operation, needs to fail loud
 * const user = safeAll('SELECT * FROM users WHERE id = ?', [userId]);
 * // ^ Use db.prepare directly instead, or throw error
 */
function safeAll(sql, params = [], fallback = []) {
  try {
    return db.prepare(sql).all(...params);
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
 * @returns {Object|*} Query result or fallback
 * 
 * @example
 * // Good: Optional user info, null is acceptable
 * const user = safeGet('SELECT * FROM users WHERE id = ?', [userId], null);
 * if (!user) { // use default }
 * 
 * @example
 * // Bad: Critical operation, needs to fail loud
 * const user = safeGet('SELECT * FROM users WHERE id = ?', [userId]);
 * // ^ Use db.prepare directly instead and handle errors properly
 */
function safeGet(sql, params = [], fallback = null) {
  try {
    return db.prepare(sql).get(...params);
  } catch (err) {
    logMajor(`SQL safeGet failed: ${err.message}`);
    return fallback;
  }
}

/**
 * === PHASE 3: FIX #20 - ERROR HANDLING CONSISTENCY ===
 * Execute a query and throw on error (for critical operations).
 * Use for operations that MUST succeed or fail loudly.
 * Errors are not caught - they bubble up to caller.
 * 
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Object} Query result
 * @throws {Error} If query fails
 * 
 * @example
 * // Good: Critical operation, must succeed
 * try {
 *   const user = getOrThrow('SELECT * FROM users WHERE id = ?', [userId]);
 *   // user is guaranteed to exist or error was thrown
 * } catch (err) {
 *   // Handle critical error (user not found, DB error, etc)
 *   logFatal('Failed to load user', err);
 *   return res.status(500).send('Internal error');
 * }
 */
function getOrThrow(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/**
 * === PHASE 3: FIX #20 - ERROR HANDLING CONSISTENCY ===
 * Execute a query and throw on error (for critical operations).
 * Use for operations that MUST succeed or fail loudly.
 * Errors are not caught - they bubble up to caller.
 * 
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Array} Query results
 * @throws {Error} If query fails
 * 
 * @example
 * // Good: Critical operation, must succeed
 * try {
 *   const users = allOrThrow('SELECT * FROM users WHERE role = ?', ['doctor']);
 *   // users is guaranteed to be valid or error was thrown
 * } catch (err) {
 *   // Handle critical error
 * }
 */
function allOrThrow(sql, params = []) {
  return db.prepare(sql).all(...params);
}

module.exports = {
  tableExists,
  safeAll,
  safeGet,
  getOrThrow,    // === PHASE 3: New function for critical operations
  allOrThrow      // === PHASE 3: New function for critical operations
};
