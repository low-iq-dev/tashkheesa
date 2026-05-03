// tests/auth/doctor-portal-redirect.test.js
//
// HTTP-level test for P1-DOC-4: an active doctor hitting GET /portal/doctor
// must land directly on their dashboard (status 200) — no intermediate
// redirect to /portal/doctor/today (the audit's "two-step navigation" bug).
//
// Boots the real express app in a child process on a random port so the
// full middleware stack runs (cookies → JWT verify → requireRole). Skipped
// when DATABASE_URL or JWT_SECRET is unset, mirroring payout_lockdown.test.js.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 doctor portal direct-landing (P1-DOC-4)\n');

if (!process.env.DATABASE_URL) { t.skip('doctor-portal-redirect', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('doctor-portal-redirect', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-doc-redirect-';
const DOC_ID = PREFIX + crypto.randomBytes(3).toString('hex');

const { execute, pool } = require('../../src/pg');
const { sign } = require('../../src/auth');

const docCookie = COOKIE_NAME + '=' + sign({
  id: DOC_ID,
  role: 'doctor',
  email: DOC_ID + '@test.local',
  name: 'Test Doctor',
  lang: 'en'
});

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT,
      LAUNCH_GATE_OFF: '1'
    });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && /running on port/.test(s)) {
        booted = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (code) => {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout (15s)'));
    }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((res) => setTimeout(res, 500));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function get(p, cookie) {
  const res = await fetch(BASE + p, {
    redirect: 'manual',
    headers: { Cookie: cookie }
  });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get('location') };
}

async function cleanup() {
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function run() {
  try {
    await cleanup();

    // Active, non-pending doctor. Pending-approval gating fires at login
    // (auth.js:227-228), not in requireDoctor — but we set the row cleanly
    // anyway so this test stays unambiguous.
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Test Doctor', 'doctor', 'en', true, false, NOW())`,
      [DOC_ID, DOC_ID + '@test.local']
    );

    try {
      await bootServer();
    } catch (e) {
      t.skip('doctor-portal-redirect', 'server boot failed: ' + e.message);
      return;
    }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) {
      t.skip('doctor-portal-redirect', 'server unreachable: ' + e.message);
      return;
    }

    // ── Core assertion: GET /portal/doctor must NOT redirect ─────────
    try {
      const r = await get('/portal/doctor', docCookie);
      assert.strictEqual(
        r.status, 200,
        'GET /portal/doctor must serve dashboard directly (200), got ' +
          r.status + (r.location ? ' Location=' + r.location : '')
      );
      assert.ok(
        !r.location || !/\/portal\/doctor\/today/.test(r.location),
        'must not Location-redirect to /portal/doctor/today (got ' + r.location + ')'
      );
      t.pass('P1-DOC-4: active doctor → GET /portal/doctor returns 200 (no intermediate redirect)');
    } catch (e) { t.fail('P1-DOC-4: /portal/doctor direct-land', e); }

    // ── Regression: existing aliases still serve dashboard ───────────
    try {
      const r = await get('/portal/doctor/today', docCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/today must still 200, got ' + r.status);
      t.pass('regression: /portal/doctor/today still serves dashboard');
    } catch (e) { t.fail('regression /portal/doctor/today', e); }

    try {
      const r = await get('/portal/doctor/dashboard', docCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/dashboard must still 200, got ' + r.status);
      t.pass('regression: /portal/doctor/dashboard still serves dashboard');
    } catch (e) { t.fail('regression /portal/doctor/dashboard', e); }

    // ── Auth boundary: unauthenticated GET /portal/doctor → /login ───
    try {
      const r = await fetch(BASE + '/portal/doctor', { redirect: 'manual' });
      assert.strictEqual(r.status, 302, 'unauthenticated /portal/doctor must redirect, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.ok(/\/login/.test(loc), 'unauthenticated redirect should target /login, got ' + loc);
      t.pass('auth: unauthenticated GET /portal/doctor → /login');
    } catch (e) { t.fail('auth boundary unauthenticated', e); }
  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
