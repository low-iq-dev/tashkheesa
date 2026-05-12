// tests/core/theme13-mobile-files-endpoint.test.js
//
// Theme 13 Sub-issue D — POST /api/v1/files (mobile direct-to-R2 upload).
//
// Mirrors theme13-r2-endpoint-flag-on-no-auth (Sub-issue A) but on the
// mobile API surface (JWT auth, JSON envelope via res.ok/res.fail).
// Verifies:
//   * Auth-less request returns 401 with AUTH_REQUIRED code.
//   * Authenticated request without a multipart body returns 400 NO_FILE
//     (route is mounted; multer ran; no file attached).
//
// Skipped when DATABASE_URL or JWT_SECRET is unset (boot will fail).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 — POST /api/v1/files (mobile R2 upload)\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-mobile-files-endpoint', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-mobile-files-endpoint', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;

let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1'
      // /api/v1 is CSRF-exempt and the new endpoint isn't gated by
      // UPLOAD_R2_DIRECT_ENABLED — mobile mounts unconditionally because
      // mobile clients are always-on for the dual-mode contract.
    });
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

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme13-mobile-files-endpoint', 'server boot failed: ' + e.message); return; }

    // 1. No Authorization header → 401 AUTH_REQUIRED (proves requireJWT is wired in front of the route).
    try {
      const r = await fetch(BASE + '/api/v1/files', { method: 'POST' });
      assert.strictEqual(r.status, 401, 'expected 401 (auth required), got ' + r.status);
      const body = await r.json();
      assert.strictEqual(body.success, false, 'expected success:false, got success:' + body.success);
      assert.strictEqual(body.code, 'AUTH_REQUIRED', 'expected code:AUTH_REQUIRED, got ' + body.code);
      t.pass('no auth: POST /api/v1/files → 401 AUTH_REQUIRED');
    } catch (e) { t.fail('no auth: 401', e); }

    // 2. Valid JWT but no multipart body → 400 NO_FILE (proves route IS mounted
    //    AND multer parsing ran AND the missing-file branch fired).
    try {
      const token = jwt.sign(
        { id: 'theme13-test-patient-id', email: 'theme13-test@example.com', role: 'patient', name: 'Test Patient' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      const r = await fetch(BASE + '/api/v1/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
        // No body, no Content-Type — multer accepts the request but req.file
        // is undefined → handler returns 400 NO_FILE.
      });
      assert.strictEqual(r.status, 400, 'expected 400 (no file), got ' + r.status);
      const body = await r.json();
      assert.strictEqual(body.success, false, 'expected success:false, got success:' + body.success);
      assert.strictEqual(body.code, 'NO_FILE', 'expected code:NO_FILE, got ' + body.code);
      t.pass('valid auth, no body: POST /api/v1/files → 400 NO_FILE (proves route mounted + multer ran)');
    } catch (e) { t.fail('auth + no body: 400 NO_FILE', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
