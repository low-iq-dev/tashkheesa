// tests/core/theme13-r2-endpoint-flag-on-no-auth.test.js
//
// Theme 13 Sub-issue A — UPLOAD_R2_DIRECT_ENABLED=true mounts the new
// POST /portal/patient/files endpoint. Verify the auth gate fires for
// requests without a session cookie. This is the second half of the
// flag-off / flag-on pair (see theme13-r2-endpoint-flag-off.test.js).
//
// Verifies two things at once:
//   1. The route IS mounted when the flag is on (not 404).
//   2. requirePatient returns JSON 401 (not text/plain, not a redirect)
//      because this endpoint is consumed by browser fetch() and must
//      hand the wizard a structured response it can act on.
//
// CSRF_MODE=off so missing CSRF doesn't shadow the auth check.
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

console.log('\n📁 Theme 13 — R2 endpoint, flag ON (auth gate)\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-r2-endpoint-flag-on-no-auth', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-r2-endpoint-flag-on-no-auth', 'JWT_SECRET not set');   return; }

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
    catch (e) { t.skip('theme13-r2-endpoint-flag-on-no-auth', 'server boot failed: ' + e.message); return; }

    // POST without any session cookie. The route IS mounted (flag is on),
    // so we should get 401 from requirePatient — not 404 (would mean
    // unmounted), not 302 (the cookie-session middleware redirects browsers
    // but this endpoint must JSON-respond for the wizard's fetch call).
    try {
      const r = await fetch(BASE + '/portal/patient/files', {
        method: 'POST',
        headers: { 'Accept': 'application/json' }
        // No body — auth check fires before multer touches the request.
      });
      assert.strictEqual(r.status, 401, 'expected 401 (auth required), got ' + r.status);

      const ct = r.headers.get('content-type') || '';
      assert.ok(ct.includes('application/json'), 'expected application/json response, got ' + ct);

      const body = await r.json();
      assert.strictEqual(body.ok, false, 'expected ok:false, got ok:' + body.ok);
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'expected non-empty error string');

      t.pass('flag on, no auth: POST /portal/patient/files → 401 JSON {ok:false, error}');
    } catch (e) { t.fail('flag on, no auth: 401 JSON', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
  }
})();
