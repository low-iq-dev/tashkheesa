// tests/core/theme13-h-rate-limit.test.js
//
// Theme 13 Sub-issue H — T4: POST /portal/patient/files enforces the
// per-user upload rate limit (30/15min). The limiter at
// src/routes/patient_files.js keys on req.user.id (cookie session JWT) with
// IP fallback. We send 31 requests from the same patient JWT and assert the
// 31st returns 429.
//
// Each request has no file body, so multer returns 400 NO_FILE before R2
// is touched. The rate limiter still counts each request because it's
// mounted AFTER requirePatient — failed-uploads count toward the cap, by
// design (prevents abusers from probing the endpoint freely).
//
// Skipped when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { sessionCookie } = require('../helpers/test-auth');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 H — T4: rate limit on /portal/patient/files (30/15min/user)\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-h-rate-limit', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-h-rate-limit', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1',
      CSRF_MODE: 'off',
      UPLOAD_R2_DIRECT_ENABLED: 'true'
    });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    serverProc.stdout.on('data', function (buf) {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', function () {});
    serverProc.once('exit', function (code) { if (!booted) reject(new Error('boot exit ' + code)); });
    setTimeout(function () { if (!booted) reject(new Error('boot timeout 15s')); }, 15000);
  });
}

async function shutdown() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise(function (r) { setTimeout(r, 500); });
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme13-h-rate-limit', 'server boot failed: ' + e.message); return; }

    // Same JWT for all 31 requests → same rate-limit key (patient_file:<userId>).
    const cookie = sessionCookie({ role: 'patient', id: 'theme13test-rl-' + Date.now() });
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const r = await fetch(BASE + '/portal/patient/files', {
        method: 'POST',
        headers: { 'Cookie': cookie, 'Accept': 'application/json' }
      });
      statuses.push(r.status);
    }

    try {
      // First 30 are NOT rate-limited (multer returns 400 NO_FILE for each,
      // since no body was sent — but the limiter increments regardless).
      const firstThirty = statuses.slice(0, 30);
      const hadEarlyLimit = firstThirty.includes(429);
      assert.ok(!hadEarlyLimit, 'first 30 must NOT hit 429; statuses[0..29] = ' + firstThirty.join(','));

      // Request 31 hits the cap and returns 429.
      assert.strictEqual(statuses[30], 429, 'request 31 must be 429, got ' + statuses[30] + '; full sequence: ' + statuses.join(','));

      t.pass('T4: 31st request returns 429 (first 30 below cap); statuses[28..30] = ' + statuses.slice(28).join(','));
    } catch (e) { t.fail('T4: rate limit', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
