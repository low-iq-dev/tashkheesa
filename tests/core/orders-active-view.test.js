// tests/core/orders-active-view.test.js
//
// Theme 1, sub-issue D — integration test for the orders_active VIEW.
//
// Migration 045 creates `orders_active` as a SELECT * FROM orders WHERE
// deleted_at IS NULL projection. ~250 SELECTs across the codebase were
// migrated to read through the view. This test verifies the view exists
// and correctly filters soft-deleted rows.
//
// Skipped when DATABASE_URL or JWT_SECRET is unset (matches the convention
// used by other DB-touching tests in this directory).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const { randomUUID } = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🪞 orders_active VIEW — integration (Theme 1, D)\n');

if (!process.env.DATABASE_URL) { t.skip('orders_active', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('orders_active', 'JWT_SECRET not set');   return; }

const { pool } = require('../../src/pg');

(async function run() {
  const testId = 'theme1-soft-delete-' + randomUUID();

  try {
    // 1. Verify the VIEW exists.
    try {
      const r = await pool.query(
        "SELECT 1 FROM pg_class WHERE relname = 'orders_active' AND relkind = 'v'"
      );
      if (r.rowCount !== 1) {
        throw new Error('orders_active VIEW does not exist (run migrations 043-045)');
      }
      t.pass('orders_active VIEW exists');
    } catch (e) { t.fail('orders_active VIEW exists', e); return; }

    // 1b. PARITY GUARD: orders_active must project EVERY column on orders.
    //     The view is `SELECT * FROM orders` — Postgres freezes `*` at creation,
    //     so a future `ALTER TABLE orders ADD COLUMN` silently drifts the view
    //     until it is recreated (migrations 045/069). This reads live
    //     information_schema, so it auto-tracks new columns and fails loudly on
    //     drift instead of crashing a `SELECT <col> FROM orders_active` at runtime.
    try {
      const missing = await pool.query(
        `SELECT oc.column_name
           FROM information_schema.columns oc
          WHERE oc.table_schema = 'public' AND oc.table_name = 'orders'
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns vc
               WHERE vc.table_schema = 'public' AND vc.table_name = 'orders_active'
                 AND vc.column_name = oc.column_name)
          ORDER BY oc.ordinal_position`
      );
      if (missing.rowCount !== 0) {
        throw new Error(
          'orders_active is missing orders column(s): ' +
          missing.rows.map(function (r) { return r.column_name; }).join(', ') +
          ' — recreate the view (migration 069 pattern)'
        );
      }
      t.pass('orders_active projects every orders column (no drift)');
    } catch (e) { t.fail('orders_active column parity', e); return; }

    // 2. Insert a fresh test order. Minimum columns to satisfy NOT NULL
    //    constraints — schema is permissive on most other fields.
    try {
      await pool.query(
        "INSERT INTO orders (id, status, created_at) VALUES ($1, 'new', NOW())",
        [testId]
      );
      t.pass('test order inserted');
    } catch (e) { t.fail('insert test order', e); return; }

    try {
      // 3. While deleted_at IS NULL, the row appears in orders_active.
      const before = await pool.query(
        "SELECT id FROM orders_active WHERE id = $1",
        [testId]
      );
      if (before.rowCount !== 1) {
        throw new Error('orders_active does not surface a freshly-inserted (non-deleted) row');
      }
      t.pass('orders_active includes non-deleted rows');

      // 4. Soft-delete the row.
      await pool.query(
        "UPDATE orders SET deleted_at = NOW() WHERE id = $1",
        [testId]
      );

      // 5. After soft-delete, the row is hidden by orders_active.
      const after = await pool.query(
        "SELECT id FROM orders_active WHERE id = $1",
        [testId]
      );
      if (after.rowCount !== 0) {
        throw new Error('soft-deleted row leaked into orders_active VIEW');
      }
      t.pass('orders_active hides soft-deleted rows');

      // 6. Sanity: bare orders still shows the soft-deleted row.
      const bare = await pool.query(
        "SELECT id, deleted_at FROM orders WHERE id = $1",
        [testId]
      );
      if (bare.rowCount !== 1 || !bare.rows[0].deleted_at) {
        throw new Error('bare orders table does not show the soft-deleted row');
      }
      t.pass('bare orders table still surfaces the soft-deleted row');
    } catch (e) { t.fail('orders_active filter behavior', e); }

  } finally {
    // Cleanup — always delete the test row.
    try {
      await pool.query("DELETE FROM orders WHERE id = $1", [testId]);
    } catch (_) {}

    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
