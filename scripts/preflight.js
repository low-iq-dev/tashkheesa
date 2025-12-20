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
run('backup-db.js');

console.log('✅ preflight ok');
