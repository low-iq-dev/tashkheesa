const path = require('path');
const { spawnSync } = require('child_process');

function run(rel) {
  const p = path.join(__dirname, rel);
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

run('doctor.js');

if (process.env.SKIP_SMOKE) {
  console.warn('⚠️  SKIP_SMOKE=1 — skipping smoke checks (offline preflight)');
} else {
  run('smoke.js');
}

run('db-integrity.js');

// AUDIT-2026-08-22 (AUDIT-BACKUP-1) — the backup used to be an unconditional
// `run('backup-db.js')`, i.e. any non-zero exit aborted the whole preflight.
// pg_dump is NOT installed on the Render image and is often absent on a
// developer laptop, so preflight hard-failed on the one machine most likely to
// run it, for a reason that has nothing to do with whether the code is shippable.
//
// Now: a backup that FAILS is still fatal (a broken dump before a risky change is
// exactly what we must not shrug at), but a backup that cannot be ATTEMPTED
// degrades to a loud warning. backup-db.js distinguishes the two by exit code:
//   0 ok · 1 genuine failure · 2 misconfigured · 3 pg_dump not installed
//
// Set PREFLIGHT_REQUIRE_BACKUP=1 to make every non-zero exit fatal. The release
// checklist should use that, or call `npm run backup:db` directly — RELEASE_
// CHECKLIST.md §2 and §6 both require a real, verified dump before a launch
// deploy, and a warning is not a backup.
(function backupStep() {
  const requireBackup = String(process.env.PREFLIGHT_REQUIRE_BACKUP || '').trim() === '1';
  const p = path.join(__dirname, 'backup-db.js');
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit' });
  const code = r.status;

  if (code === 0) return;

  if (requireBackup) {
    console.error('⛔ PREFLIGHT_REQUIRE_BACKUP=1 and backup-db.js exited ' + code + ' — aborting.');
    process.exit(code || 1);
  }

  if (code === 3) {
    console.warn('');
    console.warn('⚠️  BACKUP SKIPPED — pg_dump is not installed on this machine.');
    console.warn('   Preflight continues; you do NOT have a pre-change backup.');
    console.warn('   Before any risky change, take one from a machine that has the PostgreSQL');
    console.warn('   client tools, or use Supabase → Database → Backups.');
    return;
  }

  if (code === 2) {
    console.warn('');
    console.warn('⚠️  BACKUP SKIPPED — DATABASE_URL_DIRECT is not set (see output above).');
    console.warn('   Preflight continues; you do NOT have a pre-change backup.');
    return;
  }

  console.error('');
  console.error('⛔ backup-db.js FAILED (exit ' + code + ') — pg_dump ran and did not produce a');
  console.error('   usable dump. That is a real backup failure, not a missing tool. Aborting.');
  process.exit(code || 1);
})();

console.log('✅ preflight ok');
