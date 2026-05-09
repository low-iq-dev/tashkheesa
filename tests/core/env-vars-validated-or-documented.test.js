// tests/core/env-vars-validated-or-documented.test.js
//
// Theme 4, sub-issue D — lint guard for env-var coverage.
//
// Every distinct `process.env.X` literal read in src/ must be one of:
//   1. Validated by src/server.js validateCriticalEnvVars (alwaysRequired,
//      prodRequired keys, or prodWarn keys)
//   2. Validated elsewhere (bootCheck.js — recognised by being documented in
//      .env.example, since bootCheck.js + .env.example move in lockstep)
//   3. Documented in .env.example (uncommented `VAR=` or `# VAR=...` tunable)
//   4. On the ALLOWLIST below with a one-line justification
//
// Catches the silent-dependency regression class — a new `process.env.NEW_VAR`
// read landing in src/ without anyone updating the validator or .env.example.
// Pure source-grep — no DB, no boot.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 every process.env.X read is validated, documented, or allowlisted (Theme 4, D)\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const SERVER_JS = path.join(SRC, 'server.js');

// Vars that are read in src/ but intentionally NOT in the validator AND
// NOT in .env.example. Each entry MUST have a one-line justification.
// Adding a var here is an explicit "I checked, this is fine" signal — keep
// the list small and reviewed.
const ALLOWLIST = {
  // ── Render auto-injects on every deploy; operator never sets these ──
  RENDER_GIT_COMMIT: 'Render auto-injects on every deploy',
  RENDER_COMMIT: 'Render auto-injects (legacy alias for RENDER_GIT_COMMIT)',
  RENDER_SERVICE_NAME: 'Render auto-injects',
  RENDER_SERVICE_ID: 'Render auto-injects',

  // ── Build/runtime metadata; falls back gracefully ──
  GIT_SHA: 'set by build pipeline; falls back to git rev-parse at boot (server.js:10)',
  COMMIT_SHA: 'CI fallback alias for GIT_SHA',
  HOME: 'standard POSIX env var',
  NODE_ENV: 'covered indirectly — MODE is canonical (bootCheck.js, server.js validator)',

  // ── Legacy aliases preserved for backward compat ──
  STAGING_USER: 'BASIC_AUTH_USER alias (server.js:78); old Render env var name',
  STAGING_PASS: 'BASIC_AUTH_PASS alias (server.js:79); old Render env var name',
  UPLOADCARE_KEY: 'legacy alias for UPLOADCARE_PUBLIC_KEY (verify.js)',
  UPLOADCARE_PUBLIC: 'legacy alias for UPLOADCARE_PUBLIC_KEY (verify.js)',

  // ── Test/dev-only flags; safe defaults, never run on production paths ──
  EMAIL_TEST_STUB: 'test-suite flag (services/emailService.js:48)',
  WHATSAPP_TEST_STUB: 'test-suite flag (notify/whatsapp.js)',
  AGENT_NAME: 'optional process-ID metadata stamped on blocked_send_attempts ' +
              'rows (services/recipientGuard.js:155); null fallback. Set per ' +
              'agent runtime, never required for app correctness.',
  ADDON_DUALWRITE_SINCE: 'addon-rollout test fixture (scripts only)',
  ADDON_SYSTEM_V2: 'addon-rollout test fixture (scripts only)',
  SKIP_SMOKE: 'preflight test skip flag',
  SKILL_NAME: 'test harness reference',
  SEED_DEMO_DATA: 'one-shot demo seed flag',
  DEBUG_DASHBOARD_SLA: 'dev-only debug flag',
  DEMO_URL: 'demo recording script',

  // ── Has safe in-code default; absence is fine in any environment ──
  BRAND_NAME: 'safe default "Tashkheesa" (multiple sites in middleware/routes)',
  LANG_COOKIE_NAME: 'safe default in middleware.js; cookie-naming preference',

  // ── Legacy SQLite paths; only referenced by archived migration scripts ──
  PORTAL_DB_PATH: 'legacy SQLite scripts only, not server-side',
  DB_PATH: 'legacy SQLite scripts only',
  SQLITE_PATH: 'legacy SQLite migration script',
};

try {
  // 1. Find every literal process.env.X reference in src/
  const grepOut = execSync(
    "grep -rhoE 'process\\.env\\.[A-Z_][A-Z0-9_]+' " + SRC + " --include='*.js' || true",
    { encoding: 'utf8' }
  ).trim();
  const inCode = new Set(
    grepOut.split('\n').filter(Boolean).map(function (s) { return s.replace('process.env.', ''); })
  );

  // 2. Extract validator keys from server.js source
  const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
  const validated = new Set();

  // 2a. alwaysRequired array — match `var alwaysRequired = ['A', 'B', ...]`
  const alwaysReqMatch = serverSrc.match(/alwaysRequired\s*=\s*\[([\s\S]*?)\]/);
  if (alwaysReqMatch) {
    const items = alwaysReqMatch[1].match(/'([A-Z_][A-Z0-9_]+)'/g) || [];
    items.forEach(function (s) { validated.add(s.slice(1, -1)); });
  }

  // 2b. prodRequired object — keys at start of indented lines
  const prodReqStart = serverSrc.indexOf('var prodRequired');
  const prodWarnStart = serverSrc.indexOf('var prodWarn');
  if (prodReqStart > 0 && prodWarnStart > prodReqStart) {
    const body = serverSrc.slice(prodReqStart, prodWarnStart);
    const keys = body.match(/^[ \t]+([A-Z_][A-Z0-9_]+):/gm) || [];
    keys.forEach(function (s) { validated.add(s.replace(/[\s:]/g, '')); });
  }

  // 2c. prodWarn object — keys at start of indented lines
  const missingDecl = serverSrc.indexOf('var missing = []');
  if (prodWarnStart > 0 && missingDecl > prodWarnStart) {
    const body = serverSrc.slice(prodWarnStart, missingDecl);
    const keys = body.match(/^[ \t]+([A-Z_][A-Z0-9_]+):/gm) || [];
    keys.forEach(function (s) { validated.add(s.replace(/[\s:]/g, '')); });
  }

  // 3. Documented in .env.example — VAR= or # VAR=
  const envEx = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const documented = new Set();
  envEx.split('\n').forEach(function (line) {
    const m = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]+)\s*=/);
    if (m) documented.add(m[1]);
  });

  // 4. Find offenders: in code, not in (validated ∪ documented ∪ allowlist)
  const offenders = [];
  for (const v of inCode) {
    if (validated.has(v)) continue;
    if (documented.has(v)) continue;
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, v)) continue;
    offenders.push(v);
  }
  offenders.sort();

  if (offenders.length) {
    throw new Error(
      'Found ' + offenders.length + ' env var(s) read in src/ that are NOT validated, ' +
      'documented in .env.example, or allowlisted in this test.\n' +
      'Each one is either:\n' +
      '  (a) a silent dependency — add to src/server.js validator AND/OR .env.example, or\n' +
      '  (b) intentionally undocumented — add to the ALLOWLIST in this test with a one-line\n' +
      '      justification.\n' +
      'Offenders:\n  - ' + offenders.join('\n  - ')
    );
  }

  t.pass('every literal process.env.X read in src/ is validated, documented, or allowlisted');
} catch (e) { t.fail('env-vars-validated-or-documented', e); }
