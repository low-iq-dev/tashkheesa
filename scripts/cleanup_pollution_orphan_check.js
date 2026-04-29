require('dotenv').config();
const { pool } = require('../src/pg');

(async () => {
  const client = await pool.connect();
  try {
    const idsRes = await client.query(
      "SELECT id FROM users WHERE role='patient' AND (email LIKE '%@demo.local' OR email = 'test@test.com')"
    );
    const ids = idsRes.rows.map(r => r.id);
    console.log('Checking orphan impact for ' + ids.length + ' user ids...');
    console.log();

    // Find every column named like *_id, user_id, patient_id, doctor_id, sender_id, etc. in public schema
    const cols = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public'
        AND (column_name = 'patient_id'
          OR column_name = 'user_id'
          OR column_name = 'sender_id'
          OR column_name = 'recipient_id'
          OR column_name = 'doctor_id'
          OR column_name = 'created_by'
          OR column_name = 'approved_by'
          OR column_name = 'patient_user_id')
      ORDER BY table_name, column_name
    `);

    let totalRefs = 0;
    const summary = [];
    for (const c of cols.rows) {
      const sql = 'SELECT COUNT(*)::int AS n FROM ' + c.table_name +
                  ' WHERE ' + c.column_name + '::text = ANY($1::text[])';
      try {
        const r = await client.query(sql, [ids]);
        if (r.rows[0].n > 0) {
          summary.push({ table: c.table_name, col: c.column_name, n: r.rows[0].n });
          totalRefs += r.rows[0].n;
        }
      } catch (err) {
        summary.push({ table: c.table_name, col: c.column_name, n: -1, err: err.message });
      }
    }

    console.log('=== Tables with rows referencing the 26 victim ids ===');
    if (summary.length === 0) {
      console.log('  (none)');
    } else {
      for (const s of summary) {
        if (s.n === -1) {
          console.log('  ' + s.table + '.' + s.col + ': QUERY FAILED — ' + s.err);
        } else {
          console.log('  ' + s.table + '.' + s.col + ': ' + s.n + ' rows');
        }
      }
    }
    console.log();
    console.log('Total referencing rows: ' + totalRefs);
    console.log();

    if (totalRefs > 0) {
      console.log('SAMPLES per affected table:');
      for (const s of summary) {
        if (s.n > 0) {
          const sample = await client.query(
            'SELECT * FROM ' + s.table + ' WHERE ' + s.col + '::text = ANY($1::text[]) LIMIT 3',
            [ids]
          );
          console.log('  -- ' + s.table + ' --');
          for (const row of sample.rows) {
            // Print just key fields
            const keep = {};
            for (const k of Object.keys(row).slice(0, 8)) keep[k] = row[k];
            console.log('     ' + JSON.stringify(keep));
          }
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
})();
