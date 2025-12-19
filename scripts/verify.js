const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runNode(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

function runScript(name) {
  runNode([path.join(__dirname, name)]);
}

// 1) Preflight first
runScript('preflight.js');

// 2) Syntax checks (if present)
const files = [
  'src/server.js',
  'src/db.js',
  'src/bootCheck.js',
  'src/sla_watcher.js',
  'src/case_lifecycle.js'
];

for (const f of files) {
  if (fs.existsSync(f)) runNode(['--check', f]);
}

// 3) Folder existence checks
const mustExist = ['src/routes', 'src/views', 'public'];
for (const p of mustExist) {
  if (!fs.existsSync(p)) {
    console.error('⛔ missing path:', p);
    process.exit(1);
  }
}

console.log('✅ verify ok');
