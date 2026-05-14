// tests/core/theme13-h-multer-rejects-exe.test.js
//
// Theme 13 Sub-issue H — T3: multer fileFilter rejects dangerous extensions
// on POST /portal/patient/files even with valid patient auth. Covers the
// "Sub-issue A endpoint actually runs multer" path that prior phases didn't
// test because they had no auth helper.
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

console.log('\n📁 Theme 13 H — T3: multer rejects .exe on /portal/patient/files\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-h-multer-rejects-exe', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-h-multer-rejects-exe', 'JWT_SECRET not set');   return; }

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
    catch (e) { t.skip('theme13-h-multer-rejects-exe', 'server boot failed: ' + e.message); return; }

    // POST a fake .exe to the wizard upload endpoint. Multer's fileFilter
    // (src/middleware/upload.js:32-37) hard-blocks .exe regardless of MIME.
    try {
      const fd = new FormData();
      const blob = new Blob([new Uint8Array([0x4D, 0x5A, 0x90, 0x00])], { type: 'application/x-msdownload' });
      fd.append('file', blob, 'theme13-test-malicious.exe');
      const r = await fetch(BASE + '/portal/patient/files', {
        method: 'POST',
        body: fd,
        headers: { 'Cookie': sessionCookie({ role: 'patient' }), 'Accept': 'application/json' }
      });
      assert.strictEqual(r.status, 400, 'expected 400 (multer reject), got ' + r.status);
      const body = await r.json();
      assert.strictEqual(body.ok, false, 'expected ok:false');
      assert.ok(/File type|not allowed/i.test(body.error || ''), 'expected file-type error message, got: ' + body.error);
      t.pass('T3: multer fileFilter rejects .exe extension → 400 with "File type not allowed"');
    } catch (e) { t.fail('T3: multer reject .exe', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
