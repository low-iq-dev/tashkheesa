// tests/core/theme5-pg-boss-direct-required.test.js
//
// Theme 5 sub-issue C regression guard.
//
// Source assertions for the fail-fast block in src/job_queue.js + the
// .env.example documentation. Behavioral verification of the prod-mode
// exit was performed during Phase 3 (see commit log) and is not re-run
// here to keep the suite fast and DB-free.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};

console.log('\n🔌 Theme 5 — pg-boss DATABASE_URL_DIRECT fail-fast\n');

const ROOT = path.join(__dirname, '..', '..');
const jobQueueSrc = fs.readFileSync(path.join(ROOT, 'src', 'job_queue.js'), 'utf8');
const envExample  = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

try {
  if (!/var\s+directUrl\s*=\s*process\.env\.DATABASE_URL_DIRECT/.test(jobQueueSrc)) {
    throw new Error('job_queue.js does not read DATABASE_URL_DIRECT into a dedicated var');
  }
  t.pass('job_queue.js reads DATABASE_URL_DIRECT explicitly');
} catch (e) { t.fail('directUrl var', e); }

try {
  // The fail-fast must check both MODE and NODE_ENV for prod/staging,
  // call logFatal, and process.exit(1).
  const hasProdGate = /isProdLike\s*=\s*mode\s*===\s*'production'\s*\|\|\s*mode\s*===\s*'staging'/.test(jobQueueSrc);
  const hasFatal    = /if\s*\(isProdLike\s*&&\s*!directUrl\)\s*\{[\s\S]*?logFatal\(/.test(jobQueueSrc);
  const hasExit     = /if\s*\(isProdLike\s*&&\s*!directUrl\)\s*\{[\s\S]*?process\.exit\(1\)/.test(jobQueueSrc);
  if (!hasProdGate) throw new Error('isProdLike check missing or shape changed');
  if (!hasFatal)    throw new Error('logFatal call missing inside the prod gate');
  if (!hasExit)     throw new Error('process.exit(1) missing inside the prod gate');
  t.pass('job_queue.js fails fast in prod/staging when DATABASE_URL_DIRECT is unset');
} catch (e) { t.fail('fail-fast block', e); }

try {
  // Dev fallback must log a warning rather than exit silently.
  if (!/falling back to DATABASE_URL/.test(jobQueueSrc)) {
    throw new Error('dev fallback warning log missing');
  }
  t.pass('job_queue.js warns on dev fallback');
} catch (e) { t.fail('dev fallback warning', e); }

try {
  if (!/^DATABASE_URL_DIRECT\s*=/m.test(envExample)) {
    throw new Error('.env.example missing DATABASE_URL_DIRECT entry');
  }
  if (!/Session pooler|session.mode|port 5432/i.test(envExample)) {
    throw new Error('.env.example DATABASE_URL_DIRECT entry missing Supabase Session-pooler hint');
  }
  t.pass('.env.example documents DATABASE_URL_DIRECT with Supabase Session-pooler hint');
} catch (e) { t.fail('.env.example doc', e); }
