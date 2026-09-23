// tests/auth/profile-password-and-deletion-code.test.js
//
// Final-audit batch (2026-09-23), /api/v1/profile:
//   AUTH-4      PATCH /password returned no tokens after stamping
//               tokens_valid_after, so the phone that changed its password was
//               signed out within the 60s revocation-cache window.
//   NEW-AUTH-5  PATCH /password on a phone-signup account (no hash) was a 500.
//   NEW-AUTH-1  POST /account/code — a deletion code sent to the phone ON FILE,
//               on the shared per-phone OTP budget; DELETE /account checks the
//               code against the same number.
//   hasPassword on GET /profile.
//
// Drives the REAL router (in-memory SQL fake, stubbed Twilio Verify helper).

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'profile-pw-test-secret';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔑 profile — password re-mint, NO_PASSWORD_SET, deletion code, hasPassword\n');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ── Stub the Twilio Verify helper BEFORE profile.js requires it ────────────
const TV_PATH = require.resolve(path.join(__dirname, '..', '..', 'src', 'services', 'twilio_verify.js'));
const tv = { sends: [], checks: [], nextSend: { ok: true, status: 'pending' }, validCode: '123456' };
const realTv = require.cache[TV_PATH];
require.cache[TV_PATH] = {
  id: TV_PATH, filename: TV_PATH, loaded: true,
  exports: {
    sendOtpViaTwilio: async (phone) => { tv.sends.push(phone); return tv.nextSend; },
    verifyOtpCode: async (phone, code) => { tv.checks.push(phone); return { valid: code === tv.validCode }; },
  },
};

// ── In-memory SQL fake ──────────────────────────────────────────────────────
const S = { users: new Map(), sessions: [], stamps: [] };
function norm(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }
async function q(sql, p = []) {
  const s = norm(sql);
  let m;
  if ((m = /^SELECT (.+) FROM users WHERE id = \$1$/.exec(s))) {
    const u = S.users.get(p[0]);
    return u ? [Object.assign({}, u)] : [];
  }
  if (s.startsWith('UPDATE users SET password_hash = $1, tokens_valid_after = $3::timestamptz WHERE id = $2')) {
    const u = S.users.get(p[1]);
    u.password_hash = p[0]; u.tokens_valid_after = p[2];
    S.stamps.push(p[2]);
    return { rowCount: 1, rows: [] };
  }
  if (s.startsWith('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)')) {
    let n = 0;
    for (const x of S.sessions) if (x.user_id === p[0] && !x.revoked_at && (p[1] == null || x.id !== p[1])) { x.revoked_at = new Date(); n++; }
    return { rowCount: n, rows: [] };
  }
  if (s.startsWith('UPDATE user_sessions SET refresh_token = $1, last_seen_at = NOW() WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL')) {
    const x = S.sessions.find((r) => r.id === p[1] && r.user_id === p[2] && !r.revoked_at);
    if (x) x.refresh_token = p[0];
    return { rowCount: x ? 1 : 0, rows: [] };
  }
  if (s.startsWith('UPDATE users SET refresh_token = $1 WHERE id = $2')) {
    const u = S.users.get(p[1]); if (u) u.refresh_token = p[0];
    return { rowCount: u ? 1 : 0, rows: [] };
  }
  if (s.startsWith('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND device_id = $2')) {
    return { rowCount: 0, rows: [] };
  }
  if (s.startsWith('INSERT INTO user_sessions')) {
    S.sessions.push({ id: p[0], user_id: p[1], refresh_token: p[2], client: p[3], device_id: p[4], revoked_at: null });
    return { rowCount: 1, rows: [] };
  }
  throw new Error('fake: unhandled SQL: ' + s.slice(0, 160));
}
const helpers = {
  safeGet: async (a, b) => { const r = await q(a, b); return Array.isArray(r) ? (r[0] || null) : null; },
  safeAll: async (a, b) => { const r = await q(a, b); return Array.isArray(r) ? r : []; },
  safeRun: async (a, b) => { const r = await q(a, b); return Array.isArray(r) ? { rowCount: r.length, rows: r } : r; },
};

const profile = require('../../src/routes/api/profile')(null, helpers);
// profile.js requires the helper lazily, per request, so the stub stays in
// place until the checks finish; restored in `finally` for later test files.
function restoreTv() { if (realTv) require.cache[TV_PATH] = realTv; else delete require.cache[TV_PATH]; }

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use(express.json());
app.use((req, _res, next) => {
  const h = req.headers['x-test-user'];
  if (h) req.user = JSON.parse(h);
  next();
});
app.use('/profile', profile);
app.use((err, req, res, _next) => res.fail(err.message || 'boom', 500, 'TEST_UNCAUGHT'));

let base;
let server;
async function call(method, p, user, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': JSON.stringify(user) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  try {
    const OLD = 'old-password-1';
    S.users.set('pw-1', { id: 'pw-1', role: 'patient', email: 'a@x.test', name: 'A', phone: '+201277399043', country: 'EG', country_code: 'EG', password_hash: bcrypt.hashSync(OLD, 4) });
    S.users.set('otp-1', { id: 'otp-1', role: 'patient', email: null, name: null, phone: '+201277399044', country: 'EG', country_code: 'EG', password_hash: null });
    S.users.set('otp-legacy', { id: 'otp-legacy', role: 'patient', email: null, name: null, phone: '01277399045', country: 'EG', country_code: 'EG', password_hash: null });
    S.users.set('nophone', { id: 'nophone', role: 'patient', email: 'n@x.test', name: 'N', phone: null, country: 'EG', password_hash: null });
    S.sessions.push({ id: 'sess-this', user_id: 'pw-1', refresh_token: 'rt-this', revoked_at: null });
    S.sessions.push({ id: 'sess-other', user_id: 'pw-1', refresh_token: 'rt-other', revoked_at: null });

    await check('GET /profile exposes hasPassword (true / false)', async () => {
      const a = await call('GET', '/profile', { id: 'pw-1', role: 'patient' });
      const b = await call('GET', '/profile', { id: 'otp-1', role: 'patient' });
      assert.strictEqual(a.body.data.hasPassword, true);
      assert.strictEqual(b.body.data.hasPassword, false);
    });

    await check('PATCH /password on a password-less account → 400 NO_PASSWORD_SET (was a 500)', async () => {
      const r = await call('PATCH', '/profile/password', { id: 'otp-1', role: 'patient' }, { currentPassword: 'x', newPassword: 'whatever-123' });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'NO_PASSWORD_SET');
    });

    await check('PATCH /password: wrong current password is still 401 WRONG_PASSWORD and stamps nothing', async () => {
      const before = S.stamps.length;
      const r = await call('PATCH', '/profile/password', { id: 'pw-1', role: 'patient', sid: 'sess-this' }, { currentPassword: 'nope', newPassword: 'new-password-1' });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.code, 'WRONG_PASSWORD');
      assert.strictEqual(S.stamps.length, before);
    });

    await check('PATCH /password: returns a fresh pair minted AFTER the cut, on this device\'s row; other devices revoked', async () => {
      const r = await call('PATCH', '/profile/password', { id: 'pw-1', role: 'patient', sid: 'sess-this' }, { currentPassword: OLD, newPassword: 'new-password-1' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const { accessToken, refreshToken, message } = r.body.data;
      assert.ok(message && accessToken && refreshToken, 'message + both tokens');
      const cut = S.stamps[S.stamps.length - 1];
      assert.ok(cut instanceof Date || typeof cut === 'string', 'stamped');
      const cutMs = new Date(cut).getTime();
      const rev = require('../../src/services/access_revocation');
      for (const tok of [accessToken, refreshToken]) {
        const d = jwt.decode(tok);
        assert.strictEqual(d.id, 'pw-1');
        assert.strictEqual(d.sid, 'sess-this', 'bound to the same device row');
        assert.strictEqual(rev._isStaleRow({ tva_ms: cutMs }, d.iat), false, 'new token must survive the revocation check');
      }
      assert.strictEqual(rev._isStaleRow({ tva_ms: cutMs }, Math.floor(cutMs / 1000) - 1), true, 'a pre-cut token is still revoked');
      const thisRow = S.sessions.find((x) => x.id === 'sess-this');
      const other = S.sessions.find((x) => x.id === 'sess-other');
      assert.strictEqual(thisRow.refresh_token, refreshToken, 'refresh token stored in this device\'s row');
      assert.ok(!thisRow.revoked_at, 'this device stays live');
      assert.ok(other.revoked_at, 'other device revoked');
    });

    await check('PATCH /password with a sid-less token opens a new session row for the new pair', async () => {
      S.users.get('pw-1').password_hash = bcrypt.hashSync(OLD, 4);
      const r = await call('PATCH', '/profile/password', { id: 'pw-1', role: 'patient' }, { currentPassword: OLD, newPassword: 'new-password-2' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const d = jwt.decode(r.body.data.refreshToken);
      assert.ok(d.sid, 'new pair carries a sid');
      const row = S.sessions.find((x) => x.id === d.sid);
      assert.ok(row && !row.revoked_at && row.refresh_token === r.body.data.refreshToken);
    });

    await check('POST /account/code: sends to the phone on file → 200 { sent, maskedPhone }', async () => {
      tv.nextSend = { ok: true, status: 'pending' };
      const r = await call('POST', '/profile/account/code', { id: 'otp-1', role: 'patient' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.data.sent, true);
      assert.strictEqual(r.body.data.maskedPhone, '+20••••••9044');
      assert.strictEqual(tv.sends[tv.sends.length - 1], '+201277399044');
    });

    await check('POST /account/code: a second request inside 60s → 429 OTP_COOLDOWN with retryAfterSec (shared per-phone budget)', async () => {
      const before = tv.sends.length;
      const r = await call('POST', '/profile/account/code', { id: 'otp-1', role: 'patient' });
      assert.strictEqual(r.status, 429, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'OTP_COOLDOWN');
      assert.ok(r.body.retryAfterSec > 0 && r.body.retryAfterSec <= 60, 'retryAfterSec ' + r.body.retryAfterSec);
      assert.strictEqual(tv.sends.length, before, 'nothing sent');
    });

    await check('POST /account/code: a legacy local spelling on file is sent to its E.164 form', async () => {
      const r = await call('POST', '/profile/account/code', { id: 'otp-legacy', role: 'patient' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(tv.sends[tv.sends.length - 1], '+201277399045');
    });

    await check('POST /account/code: no phone → 400 NO_PHONE', async () => {
      const r = await call('POST', '/profile/account/code', { id: 'nophone', role: 'patient' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'NO_PHONE');
    });

    await check('POST /account/code: Twilio refusal or stub → 502 OTP_SEND_FAILED', async () => {
      S.users.set('otp-2', { id: 'otp-2', role: 'patient', phone: '+201277399046', country: 'EG', password_hash: null });
      S.users.set('otp-3', { id: 'otp-3', role: 'patient', phone: '+201277399047', country: 'EG', password_hash: null });
      tv.nextSend = { ok: false, error: 'refused' };
      const a = await call('POST', '/profile/account/code', { id: 'otp-2', role: 'patient' });
      tv.nextSend = { stub: true };
      const b = await call('POST', '/profile/account/code', { id: 'otp-3', role: 'patient' });
      assert.strictEqual(a.status, 502); assert.strictEqual(a.body.code, 'OTP_SEND_FAILED');
      assert.strictEqual(b.status, 502); assert.strictEqual(b.body.code, 'OTP_SEND_FAILED');
    });

    await check('DELETE /account checks the code against the SAME number the code route sent to', async () => {
      // Wrong code, so nothing is deleted — only the number checked matters here.
      const r = await call('DELETE', '/profile/account', { id: 'otp-legacy', role: 'patient' }, { otp: '000000' });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.code, 'WRONG_CODE');
      assert.strictEqual(tv.checks[tv.checks.length - 1], '+201277399045');
    });
  } finally {
    restoreTv();
    server.close();
  }
})();
