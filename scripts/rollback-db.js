'use strict';

// AUDIT-2026-08-22 (AUDIT-ROLLBACK-1) — this script used to be a retired stub
// that printed a paragraph and exited 1. RELEASE_CHECKLIST.md §"DB rollback"
// pointed at it anyway, so the documented rollback path was a dead end: the
// launch deploy had a backup command and NO way to use the backup.
//
// It is now a real, deliberately-armed restore.
//
// WHAT IT DOES
//   node scripts/rollback-db.js                      → list available backups
//   node scripts/rollback-db.js <file.dump>          → DRY RUN. Prints the exact
//                                                      pg_restore command and the
//                                                      target host, changes nothing.
//   node scripts/rollback-db.js <file.dump> --confirm=RESTORE_PRODUCTION
//                                                    → actually runs the restore
//
// WHY THE ARMING TOKEN. `pg_restore --clean --if-exists` DROPS AND RECREATES every
// object in the dump. Run against the wrong URL it destroys a live database. The
// token cannot be typed by accident and cannot be reached by a stray `npm run`.
//
// WHY DATABASE_URL_DIRECT. pg_restore, like pg_dump, needs a SESSION-mode
// connection — it disables triggers, sets search_path, and runs the whole restore
// as a long transaction stream. The Supabase TRANSACTION-mode pooler on
// DATABASE_URL (port 6543) cannot provide that. See scripts/backup-db.js.
//
// WHAT IT DOES NOT DO — stated plainly rather than implied away:
//   * It does NOT stop the web service. Restore with the Render service SUSPENDED,
//     or the app will write into a half-restored schema.
//   * It is NOT a down-migration. There are no down-migrations in this repo; every
//     file in src/migrations/ is forward-only. Rolling the SCHEMA back means
//     restoring a dump taken before the deploy — this script — and redeploying the
//     matching code commit.
//   * pg_restore is not available on the Render web image. Run this from an
//     operator machine with the PostgreSQL client tools installed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const CONFIRM_TOKEN = 'RESTORE_PRODUCTION';
const argv = process.argv.slice(2);
const fileArg = argv.find((a) => !a.startsWith('--'));
const confirmArg = argv.find((a) => a.startsWith('--confirm='));
const confirmed = confirmArg ? confirmArg.slice('--confirm='.length) === CONFIRM_TOKEN : false;

const backupsDir = path.join(process.cwd(), 'backups');

function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    .filter((f) => f.endsWith('.dump'))
    .sort()
    .reverse();
}

if (!fileArg) {
  const files = listBackups();
  console.error('Postgres rollback — restore a dump created by `npm run backup:db`.');
  console.error('');
  if (!files.length) {
    console.error('  No .dump files in backups/. There is nothing to roll back to.');
    console.error('  Create one first:  DATABASE_URL_DIRECT=… npm run backup:db');
    console.error('  (Supabase also keeps its own daily backups: Dashboard → Database → Backups.)');
  } else {
    console.error('  Available backups (newest first):');
    files.slice(0, 20).forEach((f) => {
      let size = '';
      try { size = ' (' + fs.statSync(path.join(backupsDir, f)).size + ' bytes)'; } catch (_) {}
      console.error('    backups/' + f + size);
    });
  }
  console.error('');
  console.error('  Usage:');
  console.error('    node scripts/rollback-db.js backups/<file>.dump                        # dry run');
  console.error('    node scripts/rollback-db.js backups/<file>.dump --confirm=' + CONFIRM_TOKEN);
  process.exit(1);
}

const dumpPath = path.resolve(fileArg);
if (!fs.existsSync(dumpPath)) {
  console.error('⛔ No such dump file: ' + dumpPath);
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL_DIRECT;
if (!dbUrl || !dbUrl.trim()) {
  console.error('⛔ DATABASE_URL_DIRECT is not set — refusing to restore.');
  console.error('   pg_restore needs a SESSION-mode connection; DATABASE_URL is the');
  console.error('   transaction-mode pooler (port 6543) and cannot serve one.');
  console.error('   Supabase → Project Settings → Database → Connection string → Session pooler');
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(dbUrl);
} catch (_) {
  console.error('⛔ DATABASE_URL_DIRECT is not a valid connection URL.');
  process.exit(2);
}
if (parsed.port === '6543') {
  console.error('⛔ DATABASE_URL_DIRECT points at port 6543 (transaction pooler). Use the');
  console.error('   Session pooler string (port 5432).');
  process.exit(2);
}

const password = decodeURIComponent(parsed.password || '');
parsed.password = '';
const sanitizedUrl = parsed.toString();
const childEnv = Object.assign({}, process.env, password ? { PGPASSWORD: password } : {});

const target = parsed.hostname + ':' + (parsed.port || '5432') + parsed.pathname;
const printableCmd =
  'PGPASSWORD=<redacted> pg_restore --clean --if-exists --no-owner --no-privileges ' +
  '-d "$DATABASE_URL_DIRECT" ' + dumpPath;

// Read the dump's table of contents so the operator sees WHAT they are about to
// restore before they arm it. This also proves the file is a readable dump.
const toc = spawnSync('pg_restore', ['--list', dumpPath], { encoding: 'utf8', env: childEnv });
if (toc.error && toc.error.code === 'ENOENT') {
  console.error('⛔ pg_restore not found on PATH — cannot restore from this machine.');
  console.error('     macOS:  brew install libpq && brew link --force libpq');
  console.error('     Debian: apt-get install postgresql-client');
  console.error('   (pg_restore is NOT on the Render image. Restore from an operator machine.)');
  process.exit(3);
}
if (toc.status !== 0) {
  console.error('⛔ ' + dumpPath + ' is not a readable pg_dump custom-format archive.');
  if (toc.stderr) console.error(String(toc.stderr).trim());
  process.exit(1);
}
const objectCount = String(toc.stdout || '')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith(';')).length;

console.error('');
console.error('  Dump   : ' + dumpPath);
console.error('  Objects: ' + objectCount + ' restorable');
console.error('  Target : ' + target);
console.error('  Command: ' + printableCmd);
console.error('');

if (!confirmed) {
  console.error('DRY RUN — nothing has been changed.');
  console.error('');
  console.error('This restore DROPS AND RECREATES every object in the dump on the target above.');
  console.error('Before arming it:');
  console.error('  1. SUSPEND the Render web service (Dashboard → Service → Suspend). A running');
  console.error('     app writing into a half-restored schema is worse than the outage.');
  console.error('  2. Take a dump of the CURRENT state first — you may need to undo the undo:');
  console.error('       npm run backup:db');
  console.error('  3. Confirm the target host above is the database you mean.');
  console.error('');
  console.error('Then re-run with:');
  console.error('  node scripts/rollback-db.js ' + fileArg + ' --confirm=' + CONFIRM_TOKEN);
  console.error('');
  console.error('Afterwards: redeploy the code commit that matches this dump. There are no');
  console.error('down-migrations in this repo — restoring the data without rolling the code back');
  console.error('leaves newer code running against an older schema.');
  process.exit(1);
}

console.error('⚠️  ARMED — restoring ' + dumpPath + ' onto ' + target);
const restore = spawnSync(
  'pg_restore',
  ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-d', sanitizedUrl, dumpPath],
  { stdio: 'inherit', env: childEnv }
);

if (restore.error) {
  console.error('⛔ pg_restore failed to start: ' + restore.error.message);
  process.exit(1);
}
if (restore.status !== 0) {
  // pg_restore exits non-zero on any error, including benign "does not exist"
  // noise from --clean on a fresh target. Say so rather than declaring disaster.
  console.error('');
  console.error('⚠️  pg_restore exited with code ' + restore.status + '.');
  console.error('   --clean --if-exists still reports errors for objects that were absent, so a');
  console.error('   non-zero exit is not automatically a failed restore. Read the output above,');
  console.error('   then verify before unsuspending:  npm run db:integrity');
  process.exit(restore.status);
}

console.error('');
console.error('✅ Restore completed. Next:');
console.error('   1. npm run db:integrity');
console.error('   2. Redeploy the code commit matching this dump.');
console.error('   3. Unsuspend the Render service.');
