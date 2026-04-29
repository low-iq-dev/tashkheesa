require('dotenv').config();
const { pool } = require('../src/pg');
(async () => {
  try {
    const r = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='blocked_send_attempts' ORDER BY ordinal_position"
    );
    console.log('blocked_send_attempts schema:');
    for (const c of r.rows) console.log('  ' + c.column_name + ' : ' + c.data_type);
    const idx = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='blocked_send_attempts'"
    );
    console.log('\nIndexes:');
    for (const i of idx.rows) console.log('  ' + i.indexname);
    const mig = await pool.query(
      "SELECT filename, ran_at FROM schema_migrations WHERE filename ILIKE '%024%' OR filename ILIKE '%blocked%' ORDER BY ran_at DESC"
    );
    console.log('\nMigration log entries:');
    for (const m of mig.rows) console.log('  ' + m.filename + ' @ ' + m.ran_at);
  } catch (err) {
    console.error('SQL error: ' + err.message);
  } finally { await pool.end(); }
})();
