'use strict';

// src/services/orders_submitted_at.js
//
// E2E fixes 2026-10-06 — orders.submitted_at (migration 129).
//
// WHY THIS IS A MODULE AND NOT A COLUMN NAME TYPED INTO THREE QUERIES.
//
// Two things about this schema make a new orders column dangerous to read:
//
//   1. The patient API's read helpers (sql-utils safeAll / safeGet) swallow a
//      failed query and answer with their fallback. A query that names a column
//      which is not there does not 500 — it returns an EMPTY CASE LIST to every
//      patient, and nothing pages.
//   2. orders_active is `SELECT * FROM orders ...`, and Postgres freezes a
//      view's column list at creation. A column added to orders is NOT in the
//      view until a migration re-creates it (see migrations 110 and 121).
//
// Migrations run at boot before the server binds a port (server.js
// initDatabase -> migrate(), exit 1 on failure), so in the normal case the
// column is there by the time anything here runs. This module covers the
// abnormal ones — 129 missing from a deploy, or applied without the view
// re-sync — by (a) probing for the column once and (b) always reading it from
// the base table by primary key rather than through the view alias.
//
// Readers get COALESCE(submitted_at, <order_timeline 'submitted' row>,
// created_at): the stamp when there is one, the pre-129 derivation for every
// case submitted before it, and never NULL.

const { queryOne } = require('../pg');

// true is cached for the life of the process (a column does not un-exist);
// false is re-probed after a minute, so an instance that somehow booted ahead
// of the migration heals itself without a restart.
const RECHECK_MS = 60 * 1000;
let _has = null;
let _checkedAt = 0;

async function hasSubmittedAtColumn() {
  if (_has === true) return true;
  if (_has === false && (Date.now() - _checkedAt) < RECHECK_MS) return false;
  try {
    const row = await queryOne(
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'orders' AND column_name = 'submitted_at'`,
      []
    );
    _has = !!row;
  } catch (_) {
    // Could not ask. Behave as before the column existed rather than guess.
    _has = false;
  }
  _checkedAt = Date.now();
  return _has;
}

// The pre-129 clock, kept as the fallback: both API submit paths write an
// order_timeline 'submitted' row at the moment of submission.
function timelineSubmittedAtSql(alias) {
  const a = alias || 'o';
  return `(SELECT MIN(ot.created_at) FROM order_timeline ot
            WHERE ot.order_id = ${a}.id AND LOWER(COALESCE(ot.status, '')) = 'submitted')`;
}

/**
 * SQL expression for "when was this case submitted", for a query whose orders
 * (or orders_active) alias is `alias`.
 *
 * @param {boolean} hasColumn  result of hasSubmittedAtColumn()
 * @param {string}  [alias='o']
 */
function submittedAtSql(hasColumn, alias) {
  const a = alias || 'o';
  const parts = [];
  if (hasColumn) {
    // Base table by PK, not `${a}.submitted_at`: `a` is usually orders_active,
    // whose frozen column list may not carry the new column yet.
    // deleted_at IS NULL is redundant with the view but keeps this the same
    // "live rows only" read the rest of the codebase insists on.
    parts.push(`(SELECT ob.submitted_at FROM orders ob WHERE ob.id = ${a}.id AND ob.deleted_at IS NULL)`);
  }
  parts.push(timelineSubmittedAtSql(a));
  parts.push(`${a}.created_at`);
  return `COALESCE(
          ${parts.join(',\n          ')})`;
}

/**
 * SET-clause fragment for the DRAFT -> submitted UPDATE, or '' when the column
 * is not there. COALESCE so the stamp is written once, at the transition, and
 * a later write through the same statement can never move it.
 */
function submittedAtSetClause(hasColumn) {
  return hasColumn ? 'submitted_at = COALESCE(submitted_at, NOW()),' : '';
}

module.exports = {
  hasSubmittedAtColumn,
  submittedAtSql,
  submittedAtSetClause,
  timelineSubmittedAtSql,
  _resetForTests: function () { _has = null; _checkedAt = 0; }
};
