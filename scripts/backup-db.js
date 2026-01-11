

const fs = require('fs');
const path = require('path');

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

const candidates = [
  process.env.PORTAL_DB_PATH,
  process.env.DB_PATH,
  'data/portal.db',
  '/tmp/tashkheesa-portal.db'
].filter(Boolean);

const src = candidates.find((p) => fs.existsSync(p));

if (!src) {
  console.error('⛔ No SQLite DB found. Looked in: ' + candidates.join(', '));
  process.exit(1);
}

const outDir = path.join(process.cwd(), 'backups');
fs.mkdirSync(outDir, { recursive: true });

const dest = path.join(outDir, 'portal-' + ts() + '.db');
fs.copyFileSync(src, dest);

console.log('✅ DB backup created:', dest, '(from', src + ')');