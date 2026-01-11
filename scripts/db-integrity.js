const fs = require('fs');
const Database = require('better-sqlite3');

const candidates = [
  process.env.PORTAL_DB_PATH,
  process.env.DB_PATH,
  'data/portal.db',
  'data/portal.db',
  '/tmp/tashkheesa-portal.db'
].filter(Boolean);

const dbPath = candidates.find((p) => fs.existsSync(p));

if (!dbPath) {
  console.error('⛔ No SQLite DB found. Looked in: ' + candidates.join(', '));
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare('PRAGMA quick_check').all();
db.close();

const bad = rows.filter((r) => String(r.quick_check).toLowerCase() !== 'ok');
if (bad.length) {
  console.error('⛔ DB quick_check failed:', bad);
  process.exit(1);
}

console.log('✅ db integrity ok:', dbPath);
