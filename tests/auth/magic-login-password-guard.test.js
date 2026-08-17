// tests/auth/magic-login-password-guard.test.js
//
// Package 2 CRITICAL (backdoor): GET /magic-login/:token established the portal
// session cookie BEFORE checking users.password_hash. An old, unused welcome
// token could therefore log in — password-free — a doctor who had ALREADY set a
// password. Fix (Task 26): if password_hash is set, burn the token but do NOT
// establish a session — redirect to normal /login. The passwordless first-login
// path (redirect to /set-password with a session) is unchanged.
//
// Boots the real server (TZ=UTC) against DATABASE_URL. Skips when DATABASE_URL or
// JWT_SECRET is unset (matches reset-password-mobile.test.js).
'use strict';
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};
console.log('\n🔐 auth/magic-login-password-guard (Package 2 CRITICAL — backdoor)\n');
if (!process.env.DATABASE_URL) { t.skip('magic-login-password-guard', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('magic-login-password-guard', 'JWT_SECRET not set'); return; }

const pgPath = require.resolve('../../src/pg');
delete require.cache[pgPath];
const { execute, queryOne } = require(pgPath);

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const PREFIX = 'test-mlpg-';
// Non-null placeholder — the handler only checks password_hash truthiness, never
// verifies it — so any non-null string marks the user as "already registered".
const HASH = '$2b$10$0000000000000000000000000000000000000000000000000000';
let serverProc = null;

function bootServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath,
      [path.join(__dirname, '..', '..', 'src', 'server.js')],
      { env: Object.assign({}, process.env, {
          PORT, LAUNCH_GATE_OFF: '1', TZ: 'UTC', PGTZ: 'UTC', CSRF_MODE: 'off' }),
        stdio: ['ignore', 'pipe', 'pipe'] });
    let booted = false;
    serverProc.stdout.on('data', (b) => { if (!booted && /running on port/.test(b.toString())) { booted = true; resolve(); } });
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (c) => { if (!booted) reject(new Error('server exited code=' + c)); });
    setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 15000);
  });
}
async function shutdown() { if (!serverProc) return; try { serverProc.kill('SIGTERM'); } catch (_) {} await new Promise(r=>setTimeout(r,400)); try { serverProc.kill('SIGKILL'); } catch (_) {} serverProc = null; }

async function getRaw(p) {
  const r = await fetch(BASE + p, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') || '', setCookie: r.headers.get('set-cookie') || '' };
}
async function seedUser(id, email, withHash) {
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
     VALUES ($1, $2, $3, $4, 'doctor', 'en', true, NOW())`,
    [id, email, withHash ? HASH : null, 'MagicGuard Test']);
}
async function mintToken(userId) {
  const token = randomUUID();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NULL, NOW())`,
    [randomUUID(), userId, token]);
  return token;
}
async function usedAt(token) { const r = await queryOne(`SELECT used_at FROM password_reset_tokens WHERE token=$1`, [token]); return r && r.used_at; }
async function cleanup() {
  await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

module.exports = (async function run() {
  try {
    await cleanup();
    try { await bootServer(); } catch (e) { t.skip('magic-login-password-guard http', 'boot failed: ' + e.message); return; }

    // ── 1. Doctor WITH a password + old unused token → NOT logged in ──
    try {
      const id = PREFIX + crypto.randomBytes(3).toString('hex');
      await seedUser(id, id + '@test.local', true);
      const token = await mintToken(id);
      const r = await getRaw('/magic-login/' + encodeURIComponent(token));
      assert.strictEqual(r.status, 302, 'expected redirect; got ' + r.status);
      assert.ok(/\/login\b/.test(r.location), 'password-holder must redirect to /login; got ' + r.location);
      assert.ok(!/tashkheesa_portal=/.test(r.setCookie),
        'must NOT set the session cookie for a password-holder; set-cookie=' + r.setCookie);
      assert.ok(await usedAt(token), 'token must still be burned (single-use preserved even on reject)');
      t.pass('#1 password-holder: no session, redirect /login, token burned');
    } catch (e) { t.fail('#1 password-holder guard', e); }

    // ── 2. Doctor WITHOUT a password → still auto-logs in to /set-password ──
    try {
      const id = PREFIX + crypto.randomBytes(3).toString('hex');
      await seedUser(id, id + '@test.local', false);
      const token = await mintToken(id);
      const r = await getRaw('/magic-login/' + encodeURIComponent(token));
      assert.strictEqual(r.status, 302, 'expected redirect; got ' + r.status);
      assert.ok(/\/set-password\b/.test(r.location), 'passwordless must redirect to /set-password; got ' + r.location);
      assert.ok(/tashkheesa_portal=/.test(r.setCookie), 'must set the session cookie for a passwordless user');
      assert.ok(await usedAt(token), 'token must be burned (single-use) on the passwordless path too');
      t.pass('#2 passwordless: session set, redirect /set-password, token burned (unchanged)');
    } catch (e) { t.fail('#2 passwordless unchanged', e); }
  } finally { try { await shutdown(); } catch (_) {} try { await cleanup(); } catch (_) {} }
})();
