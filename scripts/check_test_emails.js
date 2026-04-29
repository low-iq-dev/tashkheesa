require('dotenv').config();
const { pool } = require('../src/pg');

const FILTER = `(
  email ILIKE '%demo.local%'
  OR email ILIKE '%@example.%'
  OR email ILIKE '%@test.%'
  OR email ILIKE 'test%@%'
  OR email ILIKE 'demo%@%'
)`;

(async () => {
  try {
    // Schema discovery: confirm columns
    const userCols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position"
    );
    const orderCols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' ORDER BY ordinal_position"
    );
    console.log('users cols:    ' + userCols.rows.map(r => r.column_name).join(', '));
    console.log('orders cols:   ' + orderCols.rows.map(r => r.column_name).join(', '));
    console.log();

    // Users table — filter by role if it exists
    const hasRole = userCols.rows.some(r => r.column_name === 'role');
    const userSql = hasRole
      ? `SELECT id, email, role, created_at FROM users WHERE ${FILTER} ORDER BY created_at DESC NULLS LAST`
      : `SELECT id, email, created_at FROM users WHERE ${FILTER} ORDER BY created_at DESC NULLS LAST`;
    const u = await pool.query(userSql);
    console.log('=== users (' + u.rowCount + ' matches) ===');
    for (const row of u.rows) console.log(JSON.stringify(row));
    console.log();

    // Orders table — has email/name snapshots
    const hasEmail = orderCols.rows.some(r => r.column_name === 'email');
    if (hasEmail) {
      const orderSql = `SELECT id, email, created_at FROM orders WHERE ${FILTER} ORDER BY created_at DESC NULLS LAST LIMIT 200`;
      const o = await pool.query(orderSql);
      console.log('=== orders (' + o.rowCount + ' matches, first 200) ===');
      for (const row of o.rows) console.log(JSON.stringify(row));
    } else {
      console.log('=== orders has no email column — skipping ===');
    }
  } catch (err) {
    console.error('SQL error: ' + err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
