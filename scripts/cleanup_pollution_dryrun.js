require('dotenv').config();
const { pool } = require('../src/pg');

const FILTER = "role='patient' AND (email LIKE '%@demo.local' OR email = 'test@test.com')";

(async () => {
  const client = await pool.connect();
  try {
    // ── 1. Preview the rows we'd delete ──────────────────────────────────
    const preview = await client.query(
      `SELECT id, email, created_at FROM users WHERE ${FILTER} ORDER BY created_at`
    );
    console.log('=== PREVIEW: rows that would be deleted (' + preview.rowCount + ') ===');
    for (const row of preview.rows) {
      console.log('  ' + row.id + '  ' + row.email + '  ' + row.created_at.toISOString());
    }
    console.log();

    if (preview.rowCount === 0) {
      console.log('Nothing to delete.');
      return;
    }
    const ids = preview.rows.map(r => r.id);

    // ── 2. Discover every FK that references users.id ────────────────────
    const fks = await client.query(`
      SELECT
        tc.table_name      AS child_table,
        kcu.column_name    AS child_column,
        rc.delete_rule     AS on_delete
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON rc.unique_constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
      ORDER BY tc.table_name, kcu.column_name
    `);

    console.log('=== FK constraints referencing users.id ===');
    for (const fk of fks.rows) {
      console.log('  ' + fk.child_table + '.' + fk.child_column + '  ON DELETE ' + fk.on_delete);
    }
    console.log();

    // ── 3. Count actual referencing rows for THIS id set, per child table ─
    console.log('=== Referencing-row counts for the 26 victim ids ===');
    for (const fk of fks.rows) {
      try {
        const r = await client.query(
          'SELECT COUNT(*)::int AS n FROM ' + fk.child_table + ' WHERE ' + fk.child_column + ' = ANY($1::text[])',
          [ids]
        );
        if (r.rows[0].n > 0) {
          console.log('  ' + fk.child_table + '.' + fk.child_column + ': ' + r.rows[0].n + ' rows  (ON DELETE ' + fk.on_delete + ')');
        }
      } catch (err) {
        // Try with uuid cast if text fails
        try {
          const r2 = await client.query(
            'SELECT COUNT(*)::int AS n FROM ' + fk.child_table + ' WHERE ' + fk.child_column + '::text = ANY($1::text[])',
            [ids]
          );
          if (r2.rows[0].n > 0) {
            console.log('  ' + fk.child_table + '.' + fk.child_column + ': ' + r2.rows[0].n + ' rows  (ON DELETE ' + fk.on_delete + ')');
          }
        } catch (err2) {
          console.log('  ' + fk.child_table + '.' + fk.child_column + ': COUNT FAILED (' + err2.message + ')');
        }
      }
    }
    console.log();

    // ── 4. Run the DELETE inside a tx and ROLLBACK so nothing persists ───
    await client.query('BEGIN');
    let deleteResult = null;
    let deleteErr = null;
    try {
      deleteResult = await client.query(
        `DELETE FROM users WHERE ${FILTER}`
      );
    } catch (err) {
      deleteErr = err;
    }
    await client.query('ROLLBACK');

    if (deleteErr) {
      console.log('=== DELETE FAILED (rolled back) ===');
      console.log('  ' + deleteErr.message);
      console.log('  code: ' + deleteErr.code);
      if (deleteErr.detail) console.log('  detail: ' + deleteErr.detail);
      console.log();
      console.log('=> NOT SAFE TO COMMIT. FK constraint blocks the delete.');
    } else {
      console.log('=== DRY-RUN DELETE SUCCEEDED (rolled back) ===');
      console.log('  rows deleted: ' + deleteResult.rowCount);
      console.log();
      console.log('=> Transaction was ROLLED BACK. No data changed.');
      console.log('=> Awaiting your confirmation to run the real delete.');
    }
  } finally {
    client.release();
    await pool.end();
  }
})();
