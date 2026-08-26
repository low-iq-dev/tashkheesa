#!/usr/bin/env node
/**
 * REMOVED — 2026-08-26. This script refuses to run.
 *
 * It hard-deleted every order soft-deleted more than 90 days ago. On the day
 * it was retired that selected 21 rows in production, and it would have done
 * the following:
 *
 *   * no transaction — each DELETE autocommitted, so a failure part-way
 *     through left a partially destroyed order set with no way to resume;
 *   * child deletes wrapped in try/catch that logged "skipped" and carried on,
 *     including for tables that exist and simply errored;
 *   * DELETE FROM orders, which CASCADEs into refunds and order_addons and
 *     from there into addon_earnings — the financial records privacy.ejs
 *     promises to retain and the doctor's earnings rows (verified against
 *     production pg_constraint);
 *   * no storage cleanup at all, so the 6 R2 objects belonging to those orders
 *     would have been orphaned — and unfindable, because the rows holding
 *     their keys were the thing being deleted;
 *   * a child table list naming case_events, case_files, case_context and
 *     cases, none of which exist in this schema. Every run "skipped" four
 *     phantom tables and reported success.
 *
 * Use scripts/retention_purge.js. It implements both retention rules the
 * privacy policy actually states, runs in one transaction, re-checks the
 * paid/unpaid predicate inside that transaction, preserves the financial
 * skeleton, and refuses to write unless RETENTION_PURGE_ENABLED=true AND
 * --apply are both present.
 */

console.error([
  '',
  'scripts/purge_old_deleted_orders.js has been removed.',
  '',
  'It ran outside a transaction and its DELETE FROM orders cascaded into',
  'refunds, order_addons and addon_earnings.',
  '',
  'Use:  node scripts/retention_purge.js',
  '',
].join('\n'));

process.exit(1);
