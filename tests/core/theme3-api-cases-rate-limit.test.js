// tests/core/theme3-api-cases-rate-limit.test.js
//
// Theme 3 sub-issue A — rate limiter on /api/cases.
//
// Boots a fresh server (clean rate-limit counter state) and fires 11 fast
// POSTs to /api/cases/intake from the same IP (127.0.0.1). The 11th must
// return 429.
//
// The route is CSRF-exempt so no cookie / token gymnastics are required —
// this isolates the rate-limit behavior.
//
// Skipped when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🚦 Theme 3 — /api/cases rate limiter\n');

if (!process.env.DATABASE_URL) { t.skip('theme3-api-cases-rate-limit', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme3-api-cases-rate-limit', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const { pool } = require('../../src/pg');

let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1' });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    serverProc.stdout.on('data', function (buf) {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', function () {});
    serverProc.once('exit', function (code) {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(function () { if (!booted) reject(new Error('server boot timeout (15s)')); }, 15000);
  });
}

async function shutdown() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise(function (r) { setTimeout(r, 500); });
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function postIntake(i) {
  const r = await fetch(BASE + '/api/cases/intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      full_name: 'Rate Test ' + i,
      email: 'rate-limit-test-' + Date.now() + '-' + i + '@example.com',
      test_type: 'other',
      country: 'EG'
    })
  });
  return r.status;
}

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme3-api-cases-rate-limit', 'server boot failed: ' + e.message); return; }

    // The /api/cases limiter is 10 requests / 15 min / IP. Fire 11 in a row.
    const statuses = [];
    for (let i = 1; i <= 11; i++) {
      try { statuses.push(await postIntake(i)); }
      catch (e) { statuses.push('ERR:' + e.message); }
    }

    try {
      // First 10 must NOT be 429 (the limiter must let them through).
      const first10 = statuses.slice(0, 10);
      const first10HitLimit = first10.filter(function (s) { return s === 429; });
      assert.strictEqual(first10HitLimit.length, 0,
        'first 10 must not be rate-limited; got: ' + JSON.stringify(first10));
      t.pass('first 10 POSTs to /api/cases/intake are NOT 429 (statuses: ' + first10.join(',') + ')');
    } catch (e) { t.fail('rate-limit first 10', e); }

    try {
      // 11th must be 429.
      assert.strictEqual(statuses[10], 429,
        'expected 11th status 429, got ' + statuses[10] + ' (full: ' + statuses.join(',') + ')');
      t.pass('11th POST to /api/cases/intake → 429 Too Many Requests');
    } catch (e) { t.fail('rate-limit 11th', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
