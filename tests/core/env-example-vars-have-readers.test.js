// tests/core/env-example-vars-have-readers.test.js
//
// Theme 4, sub-issue D — lint guard against dead documentation.
//
// Every var documented in .env.example (uncommented `VAR=` or commented-default
// `# VAR=...` form) must be read somewhere in src/ or scripts/. Vars that are
// intentionally documented but unread today (reserved for future server-side
// consumers) must be on ALLOWLIST_DEPRECATED with a one-line justification.
//
// Catches the dead-doc regression class — the SMTP block lived in .env.example
// for two months after the 2026-04-30 Resend migration before Theme 4 caught
// it. Pure source-grep — no DB, no boot.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 every .env.example var has a reader (Theme 4, D)\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const SCRIPTS = path.join(ROOT, 'scripts');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// Vars documented in .env.example that intentionally have no reader today.
// Each entry MUST link to the validator comment or audit doc that justifies
// keeping it in .env.example.
const ALLOWLIST_DEPRECATED = {
  UPLOADCARE_SECRET_KEY:
    'reserved for future server-side Uploadcare ops (signed URLs, deletion, ' +
    'webhook signatures) — see src/server.js validator comment for the ' +
    'threshold for adding it to prodRequired'
};

try {
  // 1. Vars documented in .env.example
  const envEx = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const documented = new Set();
  envEx.split('\n').forEach(function (line) {
    const m = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]+)\s*=/);
    if (m) documented.add(m[1]);
  });

  // 2. Vars referenced anywhere in src/ or scripts/ (literal `process.env.X`)
  const grepCmd =
    "grep -rhoE 'process\\.env\\.[A-Z_][A-Z0-9_]+' " +
    SRC + ' ' + SCRIPTS + " --include='*.js' || true";
  const grepOut = execSync(grepCmd, { encoding: 'utf8' }).trim();
  const inCode = new Set(
    grepOut.split('\n').filter(Boolean).map(function (s) { return s.replace('process.env.', ''); })
  );

  // 3. Find offenders: in env.example, not in code, not allowlisted
  const offenders = [];
  for (const v of documented) {
    if (inCode.has(v)) continue;
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST_DEPRECATED, v)) continue;
    offenders.push(v);
  }
  offenders.sort();

  if (offenders.length) {
    throw new Error(
      'Found ' + offenders.length + ' var(s) in .env.example that no source file reads.\n' +
      'Each is either:\n' +
      '  (a) dead doc — remove from .env.example, or\n' +
      '  (b) intentionally reserved for future use — add to ALLOWLIST_DEPRECATED in this\n' +
      '      test with a one-line justification linking to the relevant doc/comment.\n' +
      'Offenders:\n  - ' + offenders.join('\n  - ')
    );
  }

  t.pass('every var documented in .env.example is read in src/ or scripts/, or explicitly allowlisted as future-reserved');
} catch (e) { t.fail('env-example-vars-have-readers', e); }
