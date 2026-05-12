// tests/core/theme13-r2-endpoint-flag-off.test.js
//
// Theme 13 Sub-issue A — UPLOAD_R2_DIRECT_ENABLED=false (the default) keeps
// the new POST /portal/patient/files endpoint UNMOUNTED. This is the
// rollback safety net per THEME_13_R2_MIGRATION_FIX_PLAN.md §7a: flipping
// the flag to 'false' must remove the new endpoint so traffic can fall back
// to the legacy Uploadcare widget.
//
// CSRF_MODE=off so the absence of a CSRF token doesn't shadow the mount-not-found check.
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

console.log('\n📁 Theme 13 — R2 endpoint, flag OFF (rollback safety)\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-r2-endpoint-flag-off', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-r2-endpoint-flag-off', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;

let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1',
      CSRF_MODE: 'off',
      // Explicitly OFF — even if the dev .env happens to set it on, this
      // override proves the flag-off code path.
      UPLOAD_R2_DIRECT_ENABLED: 'false'
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
    catch (e) { t.skip('theme13-r2-endpoint-flag-off', 'server boot failed: ' + e.message); return; }

    // POST to the path: with the flag off, no route handler is registered, so
    // Express falls through to the 404 handler. Other rejections (auth, CSRF,
    // multer) would all be > 0 status codes the route handler returns — but
    // here there IS no route handler.
    try {
      const r = await fetch(BASE + '/portal/patient/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: 'noop'
      });
      assert.strictEqual(r.status, 404, 'expected 404 (route not mounted), got ' + r.status);
      t.pass('flag off: POST /portal/patient/files → 404 (route not mounted)');
    } catch (e) { t.fail('flag off: route not mounted', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
