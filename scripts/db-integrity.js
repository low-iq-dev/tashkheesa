'use strict';

// Postgres integrity smoke — repointed from the legacy SQLite `PRAGMA
// quick_check`. Prod is Postgres; the old path did `require('better-sqlite3')`
// (a module that isn't even installed) and pointed at data/portal.db, so it
// crashed with MODULE_NOT_FOUND rather than checking anything real.
//
// Verifies the DB is reachable and the core tables exist. This is a boot-time
// sanity check, not a deep consistency audit.

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !dbUrl.trim()) {
  console.error('⛔ DATABASE_URL is not set. This is Postgres integrity tooling — ' +
    'the legacy SQLite quick_check was retired (prod is Postgres). ' +
    'Export DATABASE_URL (or source your prod env) and re-run.');
  process.exit(1);
}

const { pool, queryOne } = require('../src/pg');

const CORE_TABLES = ['users', 'orders', 'payment_events', 'notifications'];

(async function () {
  try {
    await queryOne('SELECT 1');
    const missing = [];
    for (const table of CORE_TABLES) {
      const row = await queryOne(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [table]
      );
      if (!row) missing.push(table);
    }
    if (missing.length) {
      console.error('⛔ db integrity FAILED — reachable but missing core tables: ' + missing.join(', '));
      process.exitCode = 1;
    } else {
      console.log('✅ db integrity ok: reachable + core tables present (' + CORE_TABLES.join(', ') + ')');
    }
  } catch (err) {
    console.error('⛔ db integrity FAILED —', (err && err.message) ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { await pool.end(); } catch (_) {}
  }
})();
