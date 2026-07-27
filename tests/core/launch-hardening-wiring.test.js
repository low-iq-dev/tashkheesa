'use strict';
// tests/core/launch-hardening-wiring.test.js
//
// Guards the final launch-hardening batch (launch-readiness audit §2, F7, B9, §5):
//   1. Boot validator FATALs on non-live payments + WARNs on off notify switches.
//   2. The every-boot specialty force-hide is gone from db.js and lives in a
//      one-shot migration instead.
//   3. The stray .env backups are deleted; .gitignore still covers them.
//   4. The SQLite backup/rollback/integrity tooling is repointed at Postgres.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🚀 launch-hardening wiring (§2 boot gate / F7 / B9 / §5)\n');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ── 1. Boot guard for launch switches (src/server.js) ──────────────────────
const server = read('src/server.js');
assert(/PAYMENT_MODE/.test(server) && /PAYMOB_MODE/.test(server) &&
       /paymentMode\s*!==\s*'live'\s*\|\|\s*paymobMode\s*!==\s*'live'/.test(server),
  'boot validator FATALs unless PAYMENT_MODE=live AND PAYMOB_MODE=live',
  'no live-payment-mode enforcement in the boot validator');
assert(/ALLOW_NON_LIVE_PAYMENTS/.test(server),
  'boot validator honors the ALLOW_NON_LIVE_PAYMENTS staging escape hatch',
  'no ALLOW_NON_LIVE_PAYMENTS escape hatch');
{
  // The payment check must be production-tier (skipped in dev) and actually exit.
  var idxGuard = server.search(/if\s*\(\s*!isDev\s*\)/);
  var idxPay = server.indexOf('non-live payment mode');
  var idxExit = server.indexOf('process.exit(1)', idxPay);
  assert(idxGuard !== -1 && idxPay !== -1 && idxGuard < idxPay && idxExit !== -1 && idxExit - idxPay < 1500,
    'the payment-mode check is gated on !isDev and calls process.exit(1)',
    'idxGuard=' + idxGuard + ' idxPay=' + idxPay + ' idxExit=' + idxExit);
}
assert(/EMAIL_ENABLED/.test(server) && /WHATSAPP_ENABLED/.test(server) && /skipped/.test(server),
  'boot validator WARNs when EMAIL_ENABLED / WHATSAPP_ENABLED are not true',
  'no email/whatsapp delivery-switch warning at boot');
// ALLOW_NON_LIVE_PAYMENTS must be documented so env-vars-validated stays green.
assert(/ALLOW_NON_LIVE_PAYMENTS/.test(read('.env.example')),
  'ALLOW_NON_LIVE_PAYMENTS is documented in .env.example',
  'undocumented new env read would trip env-vars-validated-or-documented');

// ── 2. Boot data mutation moved to a one-shot migration (db.js) ────────────
const db = read('src/db.js');
{
  // Slice runDataFixups body.
  const start = db.indexOf('async function runDataFixups(');
  const after = db.slice(start);
  const nextFn = after.search(/\nasync function /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;
  assert(!/UPDATE\s+specialties\s+SET\s+is_visible\s*=\s*false/i.test(body),
    'runDataFixups no longer force-hides specialties on every boot',
    'the every-boot specialty hide is still in runDataFixups');
  assert(/UPDATE orders SET status = LOWER\(status\)/.test(body),
    'runDataFixups keeps the lowercase-status normalization (ongoing invariant)',
    'lowercase-status fixup was removed');
}
{
  const mig = read('src/migrations/074_hide_unpriced_specialties.sql');
  assert(/UPDATE\s+specialties\s+SET\s+is_visible\s*=\s*false/i.test(mig) &&
         /spec-ent/.test(mig) && /spec-general-surgery/.test(mig) && /spec-pediatrics/.test(mig),
    'migration 074 hides the three unpriced specialties',
    'migration 074 missing the specialty hide');
  assert(/DO \$\$/.test(mig) && /information_schema\.tables/.test(mig),
    'migration 074 is guarded for idempotency / table existence (like 072)',
    'migration 074 lacks the existence guard');
}

// ── 3. .env backups deleted; .gitignore still covers them ──────────────────
['.env.backup-1777367095', '.env.save', '.env.production.bak'].forEach(function (f) {
  assert(!fs.existsSync(path.join(ROOT, f)), 'deleted stray env backup: ' + f, f + ' still present');
});
{
  const gi = read('.gitignore');
  assert(/^\.env$/m.test(gi) && /^\.env\.\*/m.test(gi),
    '.gitignore still covers .env and .env.*',
    '.gitignore no longer covers the env files');
}

// ── 4. SQLite tooling repointed at Postgres ────────────────────────────────
{
  const backup = read('scripts/backup-db.js');
  // (Absence checks target actual OPERATIONS, not prose — the header comments
  //  legitimately mention data/portal.db as the retired approach.)
  assert(/pg_dump/.test(backup) && /spawnSync/.test(backup) && !/copyFileSync/.test(backup),
    'backup:db is a pg_dump wrapper (spawnSync pg_dump, no SQLite file copy)',
    'backup-db.js is not a pg_dump wrapper');
  assert(/PGPASSWORD/.test(backup) && !/console\.log\([^)]*dbUrl/.test(backup),
    'backup:db passes the password via PGPASSWORD (never argv) and does not print the URL',
    'backup-db.js may leak the connection string');

  const integ = read('scripts/db-integrity.js');
  // Match the ASSIGNMENT form (real require), not the backtick prose mention.
  assert(!/=\s*require\(\s*['"]better-sqlite3['"]\s*\)/.test(integ) &&
         /require\(\s*['"]\.\.\/src\/pg['"]\s*\)/.test(integ) && /information_schema/.test(integ),
    'db:integrity is a Postgres check via src/pg (no better-sqlite3 require)',
    'db-integrity.js still requires better-sqlite3');

  const pkg = JSON.parse(read('package.json'));
  assert(/scripts\/rollback-db\.js/.test(pkg.scripts['rollback:db']) &&
         !/data\/portal\.db/.test(pkg.scripts['rollback:db']),
    'rollback:db no longer copies a SQLite file (points at the retired-notice script)',
    'rollback:db still does the SQLite copy');
  assert(/pg_restore/.test(read('scripts/rollback-db.js')),
    'rollback-db.js explains the Postgres pg_restore path', 'no pg_restore guidance');

  const checklist = read('RELEASE_CHECKLIST.md');
  // The retired `cp backups/<file>.db data/portal.db` line is intentionally
  // referenced in the "no longer applies" note, so assert the POSITIVE flow.
  assert(/pg_restore --clean --if-exists/.test(checklist) && /no longer applies/.test(checklist),
    'RELEASE_CHECKLIST DB rollback documents pg_restore and marks the SQLite cp retired',
    'checklist does not document the Postgres pg_restore rollback');
}
