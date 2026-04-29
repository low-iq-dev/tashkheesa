require('dotenv').config();
const { pool } = require('../src/pg');

const TARGET_EMAIL = 'test@test.com';

(async () => {
  const client = await pool.connect();
  try {
    const u = await client.query(
      "SELECT id, email, role, name, created_at FROM users WHERE email = $1",
      [TARGET_EMAIL]
    );
    if (u.rowCount === 0) { console.log('No match.'); return; }
    const ids = u.rows.map(r => r.id);
    console.log('Target: ' + JSON.stringify(u.rows[0]));
    console.log();

    const cols = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND column_name IN ('patient_id','user_id','sender_id','recipient_id','doctor_id','created_by','approved_by','patient_user_id')
      ORDER BY table_name, column_name
    `);

    let totalRefs = 0;
    for (const c of cols.rows) {
      try {
        const r = await client.query(
          'SELECT COUNT(*)::int AS n FROM ' + c.table_name +
          ' WHERE ' + c.column_name + '::text = ANY($1::text[])',
          [ids]
        );
        if (r.rows[0].n > 0) {
          console.log('=== ' + c.table_name + '.' + c.column_name + ': ' + r.rows[0].n + ' rows ===');
          const sample = await client.query(
            'SELECT * FROM ' + c.table_name + ' WHERE ' + c.column_name + '::text = ANY($1::text[])',
            [ids]
          );
          for (const row of sample.rows) {
            const small = {};
            for (const k of Object.keys(row).slice(0, 12)) small[k] = row[k];
            console.log('   ' + JSON.stringify(small));
          }
          totalRefs += r.rows[0].n;
        }
      } catch (_) {}
    }
    console.log();
    console.log('Total referencing rows: ' + totalRefs);
  } finally {
    client.release();
    await pool.end();
  }
})();
