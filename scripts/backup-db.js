'use strict';

// Postgres backup — pg_dump of DATABASE_URL to backups/portal-<ts>.dump
// (custom format, restorable with pg_restore).
//
// Repointed from the legacy SQLite file-copy: prod is Postgres, so copying
// data/portal.db backed up NOTHING real. An operator running `npm run backup:db`
// before a risky change would have believed prod was backed up when it wasn't.
//
// Secret hygiene (repo policy): the connection password is passed to pg_dump via
// the PGPASSWORD env var — NEVER on the command line (argv is visible in `ps`) —
// and DATABASE_URL is never printed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !dbUrl.trim()) {
  console.error('⛔ DATABASE_URL is not set. Export it (or source your prod env) first:');
  console.error('   DATABASE_URL=postgres://… npm run backup:db');
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(dbUrl);
} catch (_) {
  console.error('⛔ DATABASE_URL is not a valid connection URL.');
  process.exit(1);
}

// Move the password OFF argv and into PGPASSWORD; keep sslmode + host/db/user on
// the (non-secret) sanitized connection string.
const password = decodeURIComponent(parsed.password || '');
parsed.password = '';
const sanitizedUrl = parsed.toString();

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), 'backups');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, 'portal-' + ts + '.dump');

const result = spawnSync(
  'pg_dump',
  ['--no-owner', '--no-privileges', '-Fc', '-f', dest, '-d', sanitizedUrl],
  {
    stdio: 'inherit',
    env: Object.assign({}, process.env, password ? { PGPASSWORD: password } : {})
  }
);

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('⛔ pg_dump not found on PATH. Install the PostgreSQL client tools ' +
      '(`brew install libpq` on macOS, `apt-get install postgresql-client` on Debian/Ubuntu).');
  } else {
    console.error('⛔ pg_dump failed to start:', result.error.message);
  }
  process.exit(1);
}
if (result.status !== 0) {
  console.error('⛔ pg_dump exited with code ' + result.status + ' — backup NOT created.');
  process.exit(result.status || 1);
}

console.error('✅ Postgres backup created: ' + dest);
console.error('   Restore with:  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" ' + dest);
