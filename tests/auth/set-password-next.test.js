// tests/auth/set-password-next.test.js
//
// Patient recovery follow-up (2 Nov 2026) — a password-less patient who signs
// in by phone OTP from a draft-resume link lands on THE DRAFT, not on their
// dashboard:
//
//   /portal/patient/resume/<token> (no session) → /login?next=/patient/new-case?resume=<id>
//   → OTP verify → /set-password?next=… → POST /set-password → the draft.
//
// And POST /set-password re-issues the session it is called on: its own
// tokens_valid_after cut revokes every credential minted in an earlier second,
// including the session the patient arrived with, which used to sign them out
// within a minute of choosing a password.
//
// The REAL handlers from src/routes/auth.js, with src/pg.js and Twilio Verify
// replaced in require.cache (no database, no network).

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'set-password-next-test-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const jwt = require('jsonwebtoken');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// ── fakes ────────────────────────────────────────────────────────────────
const users = new Map();
const stamps = [];
function rowFor(sql, params) {
  if (/FROM users WHERE phone = \$1 AND role IN/.test(sql)) return [...users.values()].find((u) => u.phone === params[0]) || null;
  if (/FROM users WHERE id = \$1 AND role IN/.test(sql)) return users.get(params[0]) || null;
  return null;
}
function writeFor(sql, params) {
  if (/UPDATE users\s+SET password_hash = \$1/.test(sql)) {
    const u = users.get(params[1]); if (u) { u.password_hash = params[0]; u.tokens_valid_after = params[2]; }
    stamps.push({ id: params[1], cut: params[2] });
  }
  return { rowCount: 1, rows: [] };
}
const fakePg = {
  queryOne: async (sql, params) => rowFor(sql, params || []),
  queryAll: async (sql, params) => { const r = rowFor(sql, params || []); return r ? [r] : []; },
  execute: async (sql, params) => writeFor(sql, params || []),
  withTransaction: async (fn) => fn({ query: async (sql, params) => writeFor(sql, params || []) }),
  pool: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) },
};
const PG = require.resolve(path.join(SRC, 'pg.js'));
require.cache[PG] = { id: PG, filename: PG, loaded: true, exports: fakePg };
const TW = require.resolve(path.join(SRC, 'services', 'twilio_verify.js'));
require.cache[TW] = { id: TW, filename: TW, loaded: true, exports: { sendOtpViaTwilio: async () => ({ ok: true }), verifyOtpCode: async () => ({ valid: true }) } };

const authRouter = require(path.join(SRC, 'routes', 'auth.js'));
function pluck(router, method, p) {
  const layer = (router.stack || []).find((l) => l.route && l.route.path === p && l.route.methods && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + p + ' is not registered');
  const hs = layer.route.stack;
  return hs[hs.length - 1].handle;
}
function fakeReq(o) {
  return Object.assign({ body: {}, params: {}, query: {}, cookies: {}, headers: {}, ip: '127.0.0.1', method: 'POST', originalUrl: '/', get() { return undefined; } }, o);
}
function fakeRes() {
  const res = { statusCode: 200, cookies: {}, locals: {}, body: null, redirected: null, rendered: null, renderLocals: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.cookie = (n, v) => { res.cookies[n] = v; return res; };
  res.clearCookie = (n) => { delete res.cookies[n]; return res; };
  res.redirect = (a, b) => { res.redirected = b || a; return res; };
  res.render = (v, l) => { res.rendered = v; res.renderLocals = l; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = () => res;
  return res;
}

const DRAFT = '/patient/new-case?resume=4c7f1b2e-0d1a-4c3e-9b55-0f3a2d9c8e11';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

console.log('\n🔑  set-password keeps `next` (patient recovery follow-up)\n');

(async () => {
  const verify = pluck(authRouter, 'post', '/login/otp/verify');
  const getSet = pluck(authRouter, 'get', '/set-password');
  const postSet = pluck(authRouter, 'post', '/set-password');

  users.set('p-1', { id: 'p-1', role: 'patient', phone: '+201012345678', password_hash: null, lang: 'ar', is_active: true });

  await check('OTP sign-in of a password-less patient: /set-password carries the draft as next', async () => {
    const res = fakeRes();
    await verify(fakeReq({ body: { otp: '123456', next: DRAFT }, otpPhone: { normalized: '+201012345678', key: '+201012345678' } }), res);
    assert.deepStrictEqual(res.body, { ok: true, redirect: '/set-password?next=' + encodeURIComponent(DRAFT) });
    assert.ok(res.cookies[SESSION_COOKIE], 'signed in');
  });

  await check('an off-site next is dropped (open-redirect guard unchanged)', async () => {
    const res = fakeRes();
    await verify(fakeReq({ body: { otp: '123456', next: '//evil.example/x' }, otpPhone: { normalized: '+201012345678', key: '+201012345678' } }), res);
    assert.deepStrictEqual(res.body, { ok: true, redirect: '/set-password' });
  });

  await check('GET /set-password hands next to the form, and the form posts it back', async () => {
    const res = fakeRes();
    await getSet(fakeReq({ method: 'GET', user: { id: 'p-1', role: 'patient' }, query: { next: DRAFT } }), res);
    assert.strictEqual(res.rendered, 'set_password');
    assert.strictEqual(res.renderLocals.next, DRAFT);
    const VIEW = path.join(SRC, 'views', 'set_password.ejs');
    const html = await new Promise((resolve, reject) => ejs.renderFile(VIEW, Object.assign({ csrfField: () => '', tt: (k, en) => en }, res.renderLocals), {}, (e, h) => e ? reject(e) : resolve(h)));
    assert.ok(html.indexOf('<input type="hidden" name="next" value="' + DRAFT.replace(/&/g, '&amp;') + '" />') !== -1, 'hidden next in the form');
  });

  await check('POST /set-password: lands on the draft, with a FRESH session that survives the cut it stamps', async () => {
    const res = fakeRes();
    await postSet(fakeReq({ user: { id: 'p-1', role: 'patient' }, body: { password: 'a-good-password', confirm_password: 'a-good-password', next: DRAFT } }), res);
    assert.strictEqual(res.redirected, DRAFT);
    const st = stamps.filter((s) => s.id === 'p-1').pop();
    assert.ok(st && st.cut, 'tokens_valid_after stamped');
    const token = res.cookies[SESSION_COOKIE];
    assert.ok(token, 'a session cookie is set in the same response');
    const iat = jwt.decode(token).iat;
    const rev = require(path.join(SRC, 'services', 'access_revocation.js'));
    const cutMs = new Date(st.cut).getTime();
    assert.strictEqual(rev._isStaleRow({ tva_ms: cutMs }, iat), false, 'the new session is not revoked by the cut');
    assert.strictEqual(rev._isStaleRow({ tva_ms: cutMs }, Math.floor(cutMs / 1000) - 1), true, 'an earlier session still is');
  });

  await check('POST /set-password without next → the dashboard, as before; a short password keeps next on the re-render', async () => {
    users.set('p-2', { id: 'p-2', role: 'patient', phone: '+201112345678', password_hash: null, lang: 'en', is_active: true });
    const bad = fakeRes();
    await postSet(fakeReq({ user: { id: 'p-2', role: 'patient' }, body: { password: 'short', confirm_password: 'short', next: DRAFT } }), bad);
    assert.strictEqual(bad.statusCode, 400);
    assert.strictEqual(bad.renderLocals.next, DRAFT);
    const res = fakeRes();
    await postSet(fakeReq({ user: { id: 'p-2', role: 'patient' }, body: { password: 'a-good-password', confirm_password: 'a-good-password' } }), res);
    assert.strictEqual(res.redirected, '/dashboard');
  });

  await check('the password login path forwards next the same way (wiring)', () => {
    const src = fs.readFileSync(path.join(SRC, 'routes', 'auth.js'), 'utf8');
    assert.ok(/if \(user\.role === 'patient' && !user\.password_hash\) \{\s*return res\.redirect\(setPasswordPath\(next\)\);/.test(src));
  });
})();
