// tests/core/theme13-h-role-gate.test.js
//
// Theme 13 Sub-issue H — T5: POST /portal/patient/files rejects authenticated
// non-patient users with 403 Forbidden JSON. Covers the requirePatient guard
// at src/routes/patient_files.js (Sub-issue A).
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

console.log('\n📁 Theme 13 H — T5: doctor cookie → 403 on /portal/patient/files\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-h-role-gate', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-h-role-gate', 'JWT_SECRET not set');   return; }

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
    catch (e) { t.skip('theme13-h-role-gate', 'server boot failed: ' + e.message); return; }

    // Doctor JWT — auth succeeds (req.user set), but requirePatient guards
    // the route and rejects role !== 'patient' with 403.
    try {
      const r = await fetch(BASE + '/portal/patient/files', {
        method: 'POST',
        headers: { 'Cookie': sessionCookie({ role: 'doctor' }), 'Accept': 'application/json' }
      });
      assert.strictEqual(r.status, 403, 'expected 403 (role gate), got ' + r.status);
      const ct = r.headers.get('content-type') || '';
      assert.ok(ct.includes('application/json'), 'expected JSON response, got ' + ct);
      const body = await r.json();
      assert.strictEqual(body.ok, false, 'expected ok:false');
      assert.ok(/Forbidden/i.test(body.error || ''), 'expected Forbidden error, got: ' + body.error);
      t.pass('T5: doctor cookie → 403 Forbidden JSON (requirePatient role guard)');
    } catch (e) { t.fail('T5: doctor → 403', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
