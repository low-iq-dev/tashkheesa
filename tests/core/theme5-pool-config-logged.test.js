// tests/core/theme5-pool-config-logged.test.js
//
// Theme 5 sub-issue D regression guard.
//
// Source assertions: src/pg.js emits the pool-ready, env, and threshold
// warning log lines. Behavioral verification of the live log output was
// performed during Phase 4 (see commit log).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};

console.log('\n📋 Theme 5 — pool config visibility logging\n');

const PG = path.join(__dirname, '..', '..', 'src', 'pg.js');
const src = fs.readFileSync(PG, 'utf8');

const REQUIRED = [
  { label: 'pool ready line: max=…',                 re: /\[pg\]\s+pool ready:\s+max=/ },
  { label: 'pool ready line: statement_timeout=…',   re: /statement_timeout=/ },
  { label: 'env line: mode=…',                        re: /\[pg\]\s+env:\s+mode=/ },
  { label: 'env line: DATABASE_URL_DIRECT=…',         re: /DATABASE_URL_DIRECT=/ },
  { label: 'threshold warning at >12',                re: /if\s*\(\s*PG_POOL_MAX\s*>\s*12\s*\)/ },
  { label: 'warning text mentions Supabase ceiling',  re: /Supabase[^\n]*15-slot ceiling/ },
  // No secret leak — the direct-url log must echo "set" / "not set", not the value.
  { label: 'direct-url logged as set/not-set only',   re: /process\.env\.DATABASE_URL_DIRECT\s*\?\s*'set'\s*:\s*'not set'/ }
];

for (const r of REQUIRED) {
  try {
    if (!r.re.test(src)) throw new Error('missing in src/pg.js: ' + r.label);
    t.pass(r.label);
  } catch (e) { t.fail(r.label, e); }
}
