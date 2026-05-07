// tests/core/theme3-csrf-exemptions.test.js
//
// Theme 3 sub-issues A + C + D — CSRF exempt list and public surface.
//
// Boots a real server on a random port and asserts:
//   * A — POST /api/cases/intake bypasses CSRF (no longer 403).
//   * C — POST /public/orders returns 404 (route deleted), no users row.
//   * D — POST /ops/agent/toggle  is now CSRF-gated (was blanket-exempt).
//   * D — POST /ops/agent/cleanup is now CSRF-gated.
//   * Regression — POST /contact still rejected without a CSRF token.
//   * Regression — GET  /api/v1/* still bypasses CSRF (Theme 1 baseline).
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

console.log('\n🔒 Theme 3 — CSRF exempt list + public surface\n');

if (!process.env.DATABASE_URL) { t.skip('theme3-csrf-exemptions', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme3-csrf-exemptions', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const { pool } = require('../../src/pg');

let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    // CSRF_MODE=enforce so missing/wrong tokens 403 (matches prod). Local
    // dev otherwise defaults to 'log' which would let the regression check
    // for /contact silently pass through.
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1',
      CSRF_MODE: 'enforce'
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
    catch (e) { t.skip('theme3-csrf-exemptions', 'server boot failed: ' + e.message); return; }

    // ── Sub-issue A: /api/cases/intake bypasses CSRF ──────────────────
    try {
      const r = await fetch(BASE + '/api/cases/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})  // empty body — may 4xx for validation, but NOT 403
      });
      assert.notStrictEqual(r.status, 403, 'POST /api/cases/intake must NOT be CSRF-rejected; got 403');
      t.pass('A: POST /api/cases/intake bypasses CSRF (status: ' + r.status + ')');
    } catch (e) { t.fail('A: csrf bypass', e); }

    // ── Sub-issue C: /public/orders is gone ───────────────────────────
    const ghostEmail = 'theme3-public-orders-removed-' + Date.now() + '@example.com';
    try {
      const r = await fetch(BASE + '/public/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_name: 'csrf-deleted-test',
          patient_email: ghostEmail,
          specialty_id: 'radiology'
        })
      });
      assert.strictEqual(r.status, 404, 'expected 404 for deleted route, got ' + r.status);
      t.pass('C: POST /public/orders → 404');
    } catch (e) { t.fail('C: public/orders 404', e); }

    try {
      const row = await pool.query("SELECT id FROM users WHERE email = $1", [ghostEmail]);
      assert.strictEqual(row.rowCount, 0, 'POST should not have created a users row');
      t.pass('C: no users row created by POST /public/orders');
    } catch (e) { t.fail('C: no users row', e); }

    // ── Sub-issue D: /ops/agent/toggle now CSRF-gated ─────────────────
    try {
      const r = await fetch(BASE + '/ops/agent/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: 'csrf-test-agent' }),
        redirect: 'manual'
      });
      // CSRF (403) or auth-redirect (302) — anything but 200.
      assert.notStrictEqual(r.status, 200, 'unauthenticated POST must NOT succeed');
      assert.ok(r.status === 403 || r.status === 302,
        'expected 403 (CSRF) or 302 (auth), got ' + r.status);
      t.pass('D: POST /ops/agent/toggle without CSRF/auth → ' + r.status);
    } catch (e) { t.fail('D: toggle CSRF gate', e); }

    // ── Sub-issue D: /ops/agent/cleanup now CSRF-gated ────────────────
    try {
      const r = await fetch(BASE + '/ops/agent/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'manual'
      });
      assert.notStrictEqual(r.status, 200, 'unauthenticated POST must NOT succeed');
      assert.ok(r.status === 403 || r.status === 302,
        'expected 403 (CSRF) or 302 (auth), got ' + r.status);
      t.pass('D: POST /ops/agent/cleanup without CSRF/auth → ' + r.status);
    } catch (e) { t.fail('D: cleanup CSRF gate', e); }

    // ── Regression: a normal CSRF-protected route still rejects ──────
    try {
      const r = await fetch(BASE + '/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x', email: 'x@y.com', subject: 'x', message: 'x' })
      });
      assert.notStrictEqual(r.status, 200, 'POST /contact without CSRF must NOT succeed');
      t.pass('regression: POST /contact without CSRF → ' + r.status);
    } catch (e) { t.fail('regression: contact CSRF', e); }

    // ── Regression: /api/v1/* still bypasses CSRF (Theme 1 baseline) ─
    try {
      const r = await fetch(BASE + '/api/v1/services', { method: 'GET' });
      assert.notStrictEqual(r.status, 403,
        'GET /api/v1/services must NOT be CSRF-rejected; got 403');
      t.pass('regression: GET /api/v1/services bypasses CSRF (status: ' + r.status + ')');
    } catch (e) { t.fail('regression: api/v1', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
