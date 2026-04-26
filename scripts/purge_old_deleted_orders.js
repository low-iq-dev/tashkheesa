#!/usr/bin/env node
/**
 * Hard-delete orders that have been soft-deleted for >90 days.
 * Cascades to child tables (order_files, notifications, case_events, doctor_assignments, cases).
 *
 * Usage:
 *   node scripts/purge_old_deleted_orders.js          # dry-run (default)
 *   node scripts/purge_old_deleted_orders.js --apply  # actually delete
 *
 * Safe to re-run. Idempotent.
 */

try { require('dotenv').config(); } catch (_) {}

const { pool } = require('../src/db');

const RETENTION_DAYS = 90;

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[purge] mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (pass --apply to execute)'}`);
  console.log(`[purge] retention: ${RETENTION_DAYS} days`);

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { rows } = await pool.query(
    `SELECT id, reference_id, deleted_at
     FROM orders
     WHERE deleted_at IS NOT NULL AND deleted_at < $1
     ORDER BY deleted_at ASC`,
    [cutoff]
  );

  console.log(`[purge] ${rows.length} orders eligible for hard delete (deleted before ${cutoff}).`);

  if (rows.length === 0) {
    await pool.end();
    return;
  }

  if (!apply) {
    console.log(`[purge] would delete ${rows.length} orders + cascaded children. Run with --apply to execute.`);
    await pool.end();
    return;
  }

  const ids = rows.map(r => r.id);
  console.log(`[purge] hard-deleting ${ids.length} orders + cascading children...`);

  // Delete children first to avoid FK violations. Each table is best-effort —
  // if a table doesn't exist in this environment, the catch swallows it.
  const childTables = [
    { table: 'order_files', column: 'order_id' },
    { table: 'notifications', column: 'order_id' },
    { table: 'case_events', column: 'case_id' },
    { table: 'doctor_assignments', column: 'case_id' },
    { table: 'case_files', column: 'case_id' },
    { table: 'case_context', column: 'case_id' },
    { table: 'conversations', column: 'order_id' },
    { table: 'cases', column: 'id' }
  ];

  for (const { table, column } of childTables) {
    try {
      const r = await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [ids]);
      console.log(`[purge]   ${table}: deleted ${r.rowCount} rows`);
    } catch (e) {
      console.warn(`[purge]   ${table}: skipped (${e.message})`);
    }
  }

  const r = await pool.query(`DELETE FROM orders WHERE id = ANY($1::text[])`, [ids]);
  console.log(`[purge] orders: deleted ${r.rowCount} rows`);

  await pool.end();
}

main().catch(err => {
  console.error('[purge] fatal:', err);
  process.exit(1);
});
