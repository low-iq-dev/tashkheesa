'use strict';

// Postgres backup — pg_dump of DATABASE_URL_DIRECT to backups/portal-<ts>.dump
// (custom format, restorable with scripts/rollback-db.js or pg_restore).
//
// Repointed from the legacy SQLite file-copy: prod is Postgres, so copying
// data/portal.db backed up NOTHING real. An operator running `npm run backup:db`
// before a risky change would have believed prod was backed up when it wasn't.
//
// AUDIT-2026-08-22 (AUDIT-BACKUP-1) — WHY DATABASE_URL_DIRECT AND NOT DATABASE_URL.
// On Render, DATABASE_URL is the Supabase pgbouncer/Supavisor TRANSACTION-mode
// pooler (port 6543). pg_dump needs a SESSION: it sets statement_timeout=0 and a
// search_path on the connection, opens a REPEATABLE READ snapshot that must span
// every table it reads, and uses server-side cursors to stream them. None of
// those survive a pooler that re-routes each transaction to a different backend,
// and dumping through port 6543 is documented-unsupported by Supabase. The dump
// either errors out or — worse — succeeds and is silently inconsistent.
// DATABASE_URL_DIRECT is the Supabase Session pooler (port 5432), which pg-boss
// already requires for the same class of reason (see src/job_queue.js).
//
// The dump is VERIFIED after writing (pg_restore --list). A zero-byte or
// truncated .dump that nobody opened until restore day is not a backup.
//
// Secret hygiene (repo policy): the connection password is passed to pg_dump via
// the PGPASSWORD env var — NEVER on the command line (argv is visible in `ps`) —
// and the connection URL is never printed.
//
// EXIT CODES (scripts/preflight.js depends on these):
//   0  backup written and verified
//   1  backup genuinely failed — do not proceed with a risky change
//   2  misconfigured (DATABASE_URL_DIRECT unset / unparseable)
//   3  pg_dump is not installed on this machine — nothing was attempted

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_MISCONFIGURED = 2;
const EXIT_NO_PG_DUMP = 3;

const dbUrl = process.env.DATABASE_URL_DIRECT;
if (!dbUrl || !dbUrl.trim()) {
  console.error('⛔ DATABASE_URL_DIRECT is not set — refusing to back up.');
  console.error('');
  console.error('   pg_dump requires a SESSION-mode Postgres connection. DATABASE_URL on');
  console.error('   Render points at the Supabase TRANSACTION-mode pooler (port 6543), where');
  console.error('   pg_dump is unsupported: it cannot hold the repeatable-read snapshot or the');
  console.error('   server-side cursors it needs, so the dump fails or is silently inconsistent.');
  console.error('');
  console.error('   Set DATABASE_URL_DIRECT to the Supabase "Session pooler" connection string:');
  console.error('     Supabase → Project Settings → Database → Connection string → Session pooler');
  console.error('   (It is the same value src/job_queue.js already requires in staging/production.)');
  console.error('');
  console.error('     DATABASE_URL_DIRECT=postgres://… npm run backup:db');
  process.exit(EXIT_MISCONFIGURED);
}

let parsed;
try {
  parsed = new URL(dbUrl);
} catch (_) {
  console.error('⛔ DATABASE_URL_DIRECT is not a valid connection URL.');
  process.exit(EXIT_MISCONFIGURED);
}

// Guard against the exact mistake this script was written to stop: someone
// pasting the pooler URL into DATABASE_URL_DIRECT.
if (parsed.port === '6543') {
  console.error('⛔ DATABASE_URL_DIRECT points at port 6543 — that is the TRANSACTION-mode');
  console.error('   pooler, not the session pooler. pg_dump cannot produce a trustworthy dump');
  console.error('   through it. Use the Supabase "Session pooler" string (port 5432).');
  process.exit(EXIT_MISCONFIGURED);
}

// pg_dump must exist before we create an empty file and claim success.
const probe = spawnSync('pg_dump', ['--version'], { stdio: 'ignore' });
if (probe.error && probe.error.code === 'ENOENT') {
  console.error('⛔ pg_dump not found on PATH — no backup was taken.');
  console.error('   Install the PostgreSQL client tools:');
  console.error('     macOS:  brew install libpq && brew link --force libpq');
  console.error('     Debian: apt-get install postgresql-client');
  console.error('   NOTE: pg_dump is NOT present on the Render web image. Take launch and');
  console.error('   pre-change backups from an operator machine or from the Supabase');
  console.error('   dashboard (Database → Backups), not from a Render shell.');
  process.exit(EXIT_NO_PG_DUMP);
}

// Move the password OFF argv and into PGPASSWORD; keep sslmode + host/db/user on
// the (non-secret) sanitized connection string.
const password = decodeURIComponent(parsed.password || '');
parsed.password = '';
const sanitizedUrl = parsed.toString();
const childEnv = Object.assign({}, process.env, password ? { PGPASSWORD: password } : {});

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), 'backups');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, 'portal-' + ts + '.dump');

console.error('▶ pg_dump → ' + dest + '  (host ' + parsed.hostname + ':' + (parsed.port || '5432') + ')');

const result = spawnSync(
  'pg_dump',
  ['--no-owner', '--no-privileges', '-Fc', '-f', dest, '-d', sanitizedUrl],
  { stdio: 'inherit', env: childEnv }
);

if (result.error) {
  console.error('⛔ pg_dump failed to start:', result.error.message);
  process.exit(EXIT_FAIL);
}
if (result.status !== 0) {
  console.error('⛔ pg_dump exited with code ' + result.status + ' — backup NOT created.');
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
  process.exit(result.status || EXIT_FAIL);
}

// ── Verify. A dump nobody has opened is a hope, not a backup. ────────────────
let bytes = 0;
try { bytes = fs.statSync(dest).size; } catch (_) {}
if (!bytes) {
  console.error('⛔ ' + dest + ' is empty — backup NOT usable. Deleting.');
  try { fs.unlinkSync(dest); } catch (_) {}
  process.exit(EXIT_FAIL);
}

const verify = spawnSync('pg_restore', ['--list', dest], { encoding: 'utf8', env: childEnv });
if (verify.error && verify.error.code === 'ENOENT') {
  console.error('⚠️  pg_restore not on PATH — dump written (' + bytes + ' bytes) but NOT verified.');
  console.error('   Verify before relying on it:  pg_restore --list ' + dest);
} else if (verify.status !== 0) {
  console.error('⛔ pg_restore --list could not read ' + dest + ' — the dump is corrupt.');
  if (verify.stderr) console.error(String(verify.stderr).trim());
  console.error('   Deleting it so it cannot be mistaken for a good backup.');
  try { fs.unlinkSync(dest); } catch (_) {}
  process.exit(EXIT_FAIL);
} else {
  const entries = String(verify.stdout || '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith(';')).length;
  if (entries < 1) {
    console.error('⛔ ' + dest + ' contains no restorable objects — that is not a backup of this database.');
    try { fs.unlinkSync(dest); } catch (_) {}
    process.exit(EXIT_FAIL);
  }
  console.error('✅ Verified: ' + entries + ' restorable objects in the dump.');
}

console.error('✅ Postgres backup created: ' + dest + ' (' + bytes + ' bytes)');
console.error('   Restore with:  node scripts/rollback-db.js ' + dest);
