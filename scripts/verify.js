const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runNode(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

function runCmdCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    status: r.status,
    stdout: (r.stdout || '').toString(),
    stderr: (r.stderr || '').toString()
  };
}

function runScript(name) {
  runNode([path.join(__dirname, name)]);
}

// 1) Preflight first
runScript('preflight.js');
if (process.env.SKIP_SMOKE) {
  console.warn('⚠️  SKIP_SMOKE=1 — verify running without smoke checks');
}

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

// 4) Git hygiene (fail-fast)
// Prevent accidentally committing generated artifacts or secrets.
try {
  const gitVersion = runCmdCapture('git', ['--version']);
  if (gitVersion.status === 0) {
    const inside = runCmdCapture('git', ['rev-parse', '--is-inside-work-tree']);
    if (inside.status === 0 && inside.stdout.trim() === 'true') {
      const st = runCmdCapture('git', ['status', '--porcelain']);
      const lines = (st.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);

      const forbidden = [
        { re: /^public\/reports\/.*\.pdf$/i, msg: 'Generated PDF report under public/reports' },
        { re: /^backups\/.*\.db$/i, msg: 'Generated DB backup under backups/' },
        { re: /^data\/.*\.db$/i, msg: 'SQLite DB under data/' },
        { re: /^\.env(\..*)?$/i, msg: 'Environment file (.env*)' }
      ];

      const hits = [];
      for (const line of lines) {
        // Porcelain format: XY <path>
        const p = line.length >= 4 ? line.slice(3).trim() : line;
        for (const f of forbidden) {
          if (f.re.test(p)) {
            hits.push({ path: p, why: f.msg });
          }
        }
      }

      if (hits.length) {
        console.error('⛔ verify blocked: sensitive/generated files detected in git status');
        for (const h of hits) {
          console.error(` - ${h.path}  (${h.why})`);
        }
        console.error('Fix: ensure these paths are in .gitignore and untrack them with: git rm --cached <path>');
        process.exit(1);
      }
    }
  }
} catch (e) {
  // If git isn't available, ignore.
}

console.log('✅ verify ok');
