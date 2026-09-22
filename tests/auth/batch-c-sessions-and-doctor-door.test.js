// tests/auth/batch-c-sessions-and-doctor-door.test.js
//
// BATCH C (fix plan 2026-09-15) — C1 per-device sessions + C2 the doctor door.
//
// C1: users.refresh_token was a single shared column rotated on every refresh,
// so a second sign-in ANYWHERE silently invalidated the first device — live in
// production on the patient app. These tests drive the real routers
// (routes/api/auth.js, routes/api/doctor_auth.js) against an in-memory fake of
// the exact SQL they issue, and pin the acceptance property the brief names:
// two devices signed in, both keep refreshing; sign out one, the other lives.
//
// C2: the patient OTP door used to accept doctors (30-day refresh, no doctor
// account-state answers) and auto-created a PATIENT account for an unknown
// phone. The doctor door must answer each state with its own code, mint 12h
// refresh, and NEVER create an account.
//
// The fake DB throws on any SQL it does not recognise — an unhandled
// statement is a test bug to surface, never something to silently no-op.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'batch-c-test-secret';
// The worktree has no .env, so TWILIO_VERIFY_SERVICE_SID is unset and both
// OTP doors take the otp_codes fallback path — asserted here so a future env
// change fails loudly instead of making these tests silently call Twilio.
if (process.env.TWILIO_VERIFY_SERVICE_SID) {
  console.log('  ⏭️  batch-c auth tests skipped (TWILIO_VERIFY_SERVICE_SID is set — fallback OTP path unavailable)');
  return;
}

const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const express = require('express');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔐 BATCH C — per-device sessions (C1) + the doctor door (C2)\n');

// ─── In-memory fake of the SQL the auth surfaces issue ─────────────────────

const state = {
  users: [],       // rows: plain objects
  sessions: [],    // user_sessions rows
  otps: [],        // otp_codes rows: { phone, code, expires_at }
  userInserts: 0,  // every INSERT INTO users, for the "no account created" proof
};

function norm(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

async function fakeQuery(sql, params = []) {
  const q = norm(sql);

  // ---- users ----
  if (q.startsWith('SELECT * FROM users WHERE email = $1 AND role = $2')) {
    return state.users.filter(u => u.email === params[0] && u.role === params[1]);
  }
  if (q.startsWith('SELECT * FROM users WHERE id = $1 AND refresh_token = $2')) {
    return state.users.filter(u => u.id === params[0] && u.refresh_token === params[1]);
  }
  if (q.startsWith('SELECT * FROM users WHERE id = $1')) {
    return state.users.filter(u => u.id === params[0]);
  }
  if (q.startsWith('SELECT * FROM users WHERE phone = $1 AND role = ANY($2)')) {
    return state.users.filter(u => u.phone === params[0] && params[1].includes(u.role));
  }
  if (q.startsWith("SELECT * FROM users WHERE phone = $1 AND role IN ('patient', 'doctor')")) {
    return state.users.filter(u => u.phone === params[0] && ['patient', 'doctor'].includes(u.role));
  }
  if (q.startsWith('SELECT * FROM users WHERE phone IS NOT NULL AND RIGHT(')) {
    const suffix = params[1];
    const roles = params[2] || null;
    return state.users.filter(u => {
      if (!u.phone) return false;
      const digits = String(u.phone).replace(/[^0-9]/g, '');
      if (digits.slice(-suffix.length) !== suffix) return false;
      return roles ? roles.includes(u.role) : true;
    }).slice(0, 5);
  }
  if (q.startsWith("SELECT 1 AS x FROM users WHERE phone = $1 AND role NOT IN ('patient', 'doctor')")) {
    return state.users.filter(u => u.phone === params[0] && !['patient', 'doctor'].includes(u.role)).map(() => ({ x: 1 }));
  }
  if (q.startsWith('UPDATE users SET refresh_token = $1 WHERE id = $2')) {
    const u = state.users.find(x => x.id === params[1]);
    if (u) u.refresh_token = params[0];
    return { rowCount: u ? 1 : 0, rows: [] };
  }
  if (q.startsWith('UPDATE users SET refresh_token = NULL, push_token = NULL WHERE id = $1')) {
    const u = state.users.find(x => x.id === params[0]);
    if (u) { u.refresh_token = null; u.push_token = null; }
    return { rowCount: u ? 1 : 0, rows: [] };
  }
  if (q.startsWith('UPDATE users SET refresh_token = NULL WHERE id = (SELECT user_id FROM user_sessions WHERE id = $1)')) {
    const s = state.sessions.find(x => x.id === params[0]);
    if (s) {
      const u = state.users.find(x => x.id === s.user_id && x.refresh_token === s.refresh_token);
      if (u) { u.refresh_token = null; return { rowCount: 1, rows: [] }; }
    }
    return { rowCount: 0, rows: [] };
  }
  if (q.startsWith('UPDATE users SET push_token = NULL WHERE id = (SELECT user_id FROM user_sessions WHERE id = $1)')) {
    const s = state.sessions.find(x => x.id === params[0]);
    if (s) {
      const u = state.users.find(x => x.id === s.user_id);
      const hasLive = state.sessions.some(x => x.user_id === s.user_id && !x.revoked_at);
      if (u && u.push_token && (u.push_token === s.push_token || !hasLive)) {
        u.push_token = null;
        return { rowCount: 1, rows: [] };
      }
    }
    return { rowCount: 0, rows: [] };
  }
  if (q.startsWith('UPDATE users SET refresh_token = NULL WHERE id = $1')) {
    const u = state.users.find(x => x.id === params[0]);
    if (u) u.refresh_token = null;
    return { rowCount: u ? 1 : 0, rows: [] };
  }
  if (q.startsWith('UPDATE users SET phone = $1 WHERE id = $2')) {
    const u = state.users.find(x => x.id === params[1]);
    if (u) u.phone = params[0];
    return { rowCount: u ? 1 : 0, rows: [] };
  }
  if (q.startsWith('INSERT INTO users')) {
    state.userInserts += 1;
    // Patient auto-create shape (id, phone, role, country, country_code, lang)
    const row = { id: params[0], phone: params[1], role: 'patient', country: params[2], country_code: params[2], lang: 'en' };
    state.users.push(row);
    return { rowCount: 1, rows: [{ id: row.id }] };
  }

  // ---- user_sessions ----
  if (q.startsWith('SELECT * FROM user_sessions WHERE refresh_token = $1 AND revoked_at IS NULL')) {
    return state.sessions.filter(s => s.refresh_token === params[0] && !s.revoked_at);
  }
  if (q.startsWith('INSERT INTO user_sessions')) {
    if (q.includes('push_token')) {
      // adoptLegacyToken shape
      state.sessions.push({ id: params[0], user_id: params[1], refresh_token: params[2], push_token: params[3], client: 'legacy', device_id: 'legacy', revoked_at: null });
    } else {
      state.sessions.push({ id: params[0], user_id: params[1], refresh_token: params[2], client: params[3], device_id: params[4], device_name: params[5], push_token: null, revoked_at: null });
    }
    return { rowCount: 1, rows: [] };
  }
  if (q.startsWith('UPDATE user_sessions SET refresh_token = $1, last_seen_at = NOW() WHERE id = $2 AND refresh_token = $3 AND revoked_at IS NULL')) {
    const s = state.sessions.find(x => x.id === params[1] && x.refresh_token === params[2] && !x.revoked_at);
    if (s) s.refresh_token = params[0];
    return { rowCount: s ? 1 : 0, rows: [] };
  }
  if (q.startsWith("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND device_id = 'legacy' AND refresh_token <> $2 AND revoked_at IS NULL")) {
    let n = 0;
    for (const s of state.sessions) if (s.user_id === params[0] && s.device_id === 'legacy' && s.refresh_token !== params[1] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
    return { rowCount: n, rows: [] };
  }
  if (q.startsWith("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND device_id = 'legacy' AND revoked_at IS NULL")) {
    let n = 0;
    for (const s of state.sessions) if (s.user_id === params[0] && s.device_id === 'legacy' && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
    return { rowCount: n, rows: [] };
  }
  if (q.startsWith('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL')) {
    let n = 0;
    for (const s of state.sessions) if (s.user_id === params[0] && s.device_id === params[1] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
    return { rowCount: n, rows: [] };
  }
  if (q.startsWith('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL')) {
    let n = 0;
    for (const s of state.sessions) if (s.user_id === params[0] && !s.revoked_at) { s.revoked_at = new Date().toISOString(); n++; }
    return { rowCount: n, rows: [] };
  }
  if (q.startsWith('UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL')) {
    const owner = params.length > 1 ? params[1] : null;
    const s = state.sessions.find(x => x.id === params[0] && !x.revoked_at && (owner == null || x.user_id === owner));
    if (s) s.revoked_at = new Date().toISOString();
    return { rowCount: s ? 1 : 0, rows: [] };
  }
  if (q.startsWith('UPDATE user_sessions SET push_token = $1, last_seen_at = NOW() WHERE id = $2 AND revoked_at IS NULL')) {
    const owner = params.length > 2 ? params[2] : null;
    const s = state.sessions.find(x => x.id === params[1] && !x.revoked_at && (owner == null || x.user_id === owner));
    if (s) s.push_token = params[0];
    return { rowCount: s ? 1 : 0, rows: [] };
  }
  if (q.startsWith('SELECT DISTINCT push_token FROM user_sessions')) {
    const seen = new Set();
    const out = [];
    for (const s of state.sessions) {
      if (s.user_id === params[0] && !s.revoked_at && s.push_token && !seen.has(s.push_token)) {
        seen.add(s.push_token); out.push({ push_token: s.push_token });
      }
    }
    return out;
  }
  if (q.startsWith('SELECT push_token FROM users WHERE id = $1')) {
    return state.users.filter(u => u.id === params[0]).map(u => ({ push_token: u.push_token || null }));
  }

  // ---- otp_codes ----
  if (q.startsWith('SELECT * FROM otp_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()')) {
    return state.otps.filter(o => o.phone === params[0] && o.code === params[1] && new Date(o.expires_at) > new Date());
  }
  if (q.startsWith('DELETE FROM otp_codes WHERE phone = $1')) {
    state.otps = state.otps.filter(o => o.phone !== params[0]);
    return { rowCount: 1, rows: [] };
  }
  if (q.startsWith('INSERT INTO otp_codes')) {
    state.otps = state.otps.filter(o => o.phone !== params[0]);
    state.otps.push({ phone: params[0], code: params[1], expires_at: params[2] });
    return { rowCount: 1, rows: [] };
  }

  throw new Error('fakeQuery: unhandled SQL: ' + q.slice(0, 140));
}

const helpers = {
  safeGet: async (sql, params) => { const r = await fakeQuery(sql, params); return Array.isArray(r) ? (r[0] || null) : null; },
  safeAll: async (sql, params) => { const r = await fakeQuery(sql, params); return Array.isArray(r) ? r : []; },
  safeRun: async (sql, params) => { const r = await fakeQuery(sql, params); return Array.isArray(r) ? { rowCount: r.length, rows: r } : r; },
  sendOtpViaTwilio: null,
};

// ─── App under test: the REAL routers, once (module-level Router objects) ──

const apiResponse = require('../../src/middleware/apiResponse');
const authRouter = require('../../src/routes/api/auth')({}, helpers);
const doctorAuthRouter = require('../../src/routes/api/doctor_auth')({}, helpers);

const app = express();
app.use(apiResponse);
app.use(express.json());
app.use('/auth', authRouter);
app.use('/doctor/auth', doctorAuthRouter);
// Async route errors must surface as JSON, not hang the request.
app.use((err, req, res, _next) => res.fail(err.message || 'boom', 500, 'TEST_UNCAUGHT'));

let server, base;
function listen() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

function resetState() {
  state.users.length = 0;
  state.sessions.length = 0;
  state.otps.length = 0;
  state.userInserts = 0;
}

function seedPatient(over = {}) {
  const u = {
    id: 'pat-1', role: 'patient', email: 'p@example.com', phone: '+201003225382',
    password_hash: null, name: 'Pat', lang: 'en', is_active: true,
    pending_approval: null, rejection_reason: null, refresh_token: null, push_token: null,
    created_at: '2026-01-01T00:00:00Z', ...over,
  };
  state.users.push(u);
  return u;
}

function seedDoctor(over = {}) {
  const u = {
    id: 'doc-1', role: 'doctor', email: 'd@example.com', phone: '+201007801095',
    name: 'Dr D', name_ar: null, lang: 'en', is_active: true, pending_approval: false,
    rejection_reason: null, is_paused: false, onboarding_complete: true,
    specialty_id: 'spec-cardiology', appearance_preference: null,
    refresh_token: null, push_token: null, created_at: '2026-01-01T00:00:00Z', ...over,
  };
  state.users.push(u);
  return u;
}

function seedOtp(phone, code) {
  state.otps.push({ phone, code, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
}

function liveSessions(userId) {
  return state.sessions.filter(s => s.user_id === userId && !s.revoked_at);
}

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

(async () => {
  await listen();

  // ════ C1 — two devices, independent sessions ════

  await check('C1: OTP sign-in on device A then device B — two LIVE session rows, distinct refresh tokens', async () => {
    resetState();
    seedPatient();
    seedOtp('+2001003225382', '111111');
    const a = await post('/auth/otp/verify', { phone: '01003225382', countryCode: '+20', otp: '111111', deviceId: 'phone-A' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    seedOtp('+2001003225382', '222222');
    const b = await post('/auth/otp/verify', { phone: '01003225382', countryCode: '+20', otp: '222222', deviceId: 'phone-B' });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    assert.notStrictEqual(a.body.data.refreshToken, b.body.data.refreshToken);
    assert.strictEqual(liveSessions('pat-1').length, 2);
    global.__c1 = { a: a.body.data, b: b.body.data };
  });

  await check('C1 ACCEPTANCE: device A still refreshes AFTER device B signed in (the production defect, closed)', async () => {
    const r = await post('/auth/refresh', { refreshToken: global.__c1.a.refreshToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.refreshToken);
    global.__c1.a2 = r.body.data;
  });

  await check('C1: device B refreshes too — rotation stays inside each device\'s own row', async () => {
    const r = await post('/auth/refresh', { refreshToken: global.__c1.b.refreshToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    global.__c1.b2 = r.body.data;
  });

  await check('C1: a rotated-away (old) token is refused with REFRESH_REVOKED — rotation contract kept', async () => {
    const r = await post('/auth/refresh', { refreshToken: global.__c1.a.refreshToken });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'REFRESH_REVOKED');
  });

  await check('C1 ACCEPTANCE: sign out device A — device B stays alive', async () => {
    const out = await post('/auth/logout', null, { Authorization: 'Bearer ' + global.__c1.a2.accessToken });
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    const deadA = await post('/auth/refresh', { refreshToken: global.__c1.a2.refreshToken });
    assert.strictEqual(deadA.status, 401);
    assert.strictEqual(deadA.body.code, 'REFRESH_REVOKED');
    const aliveB = await post('/auth/refresh', { refreshToken: global.__c1.b2.refreshToken });
    assert.strictEqual(aliveB.status, 200, 'device B was killed by device A\'s logout: ' + JSON.stringify(aliveB.body));
    assert.strictEqual(liveSessions('pat-1').length, 1);
  });

  await check('C1: access + refresh tokens carry the session id (`sid`) and it names a real row', async () => {
    const dec = jwt.decode(global.__c1.b.accessToken);
    assert.ok(dec.sid, 'no sid claim');
    assert.ok(state.sessions.some(s => s.id === dec.sid));
    assert.strictEqual(jwt.decode(global.__c1.b.refreshToken).sid, dec.sid);
  });

  await check('C1: a pre-C1 token (mirror column, NO session row) is ADOPTED on refresh, not rejected', async () => {
    resetState();
    const u = seedPatient({ id: 'pat-legacy' });
    const { generateTokens } = require('../../src/middleware/requireJWT');
    const legacy = generateTokens(u); // sid-less, like pre-C1 code minted
    u.refresh_token = legacy.refreshToken; // the single-slot column
    const r = await post('/auth/refresh', { refreshToken: legacy.refreshToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(liveSessions('pat-legacy').length, 1);
    assert.strictEqual(liveSessions('pat-legacy')[0].device_id, 'legacy');
    // and the adopted session keeps working
    const r2 = await post('/auth/refresh', { refreshToken: r.body.data.refreshToken });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  });

  await check('C1: logout with a sid-less (pre-C1) access token revokes the legacy row and clears the mirror columns', async () => {
    resetState();
    const u = seedPatient({ id: 'pat-old', push_token: 'ExponentPushToken[old]' });
    const { generateTokens } = require('../../src/middleware/requireJWT');
    const legacy = generateTokens(u);
    u.refresh_token = legacy.refreshToken;
    state.sessions.push({ id: 'sess-legacy-pat-old', user_id: 'pat-old', refresh_token: legacy.refreshToken, push_token: 'ExponentPushToken[old]', client: 'legacy', device_id: 'legacy', revoked_at: null });
    const out = await post('/auth/logout', null, { Authorization: 'Bearer ' + legacy.accessToken });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(liveSessions('pat-old').length, 0);
    assert.strictEqual(u.refresh_token, null);
    assert.strictEqual(u.push_token, null);
  });

  await check('C1: the patient refresh endpoint serves PATIENTS only — a doctor-role session is refused and burned', async () => {
    resetState();
    const d = seedDoctor({ id: 'doc-x' });
    const { generateDoctorTokens } = require('../../src/middleware/requireJWT');
    const pair = generateDoctorTokens(d, 'sess-docx');
    state.sessions.push({ id: 'sess-docx', user_id: 'doc-x', refresh_token: pair.refreshToken, client: 'doctor_app', device_id: null, revoked_at: null });
    const r = await post('/auth/refresh', { refreshToken: pair.refreshToken });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'REFRESH_REVOKED');
    assert.strictEqual(liveSessions('doc-x').length, 0, 'wrong-door token must die, not linger');
  });

  await check('C1 (spec S3): adopting the mirror token revokes a STALE seeded legacy row — a rotated-away pre-C1 token dies', async () => {
    resetState();
    const u = seedPatient({ id: 'pat-s3' });
    const { generateTokens } = require('../../src/middleware/requireJWT');
    const t0 = generateTokens(u); // seeded at migration snapshot…
    state.sessions.push({ id: 'sess-legacy-pat-s3', user_id: 'pat-s3', refresh_token: t0.refreshToken, push_token: null, client: 'legacy', device_id: 'legacy', revoked_at: null });
    const t1 = generateTokens(u); // …then old code rotated the mirror in the deploy window
    u.refresh_token = t1.refreshToken;
    const ok = await post('/auth/refresh', { refreshToken: t1.refreshToken });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const stale = await post('/auth/refresh', { refreshToken: t0.refreshToken });
    assert.strictEqual(stale.status, 401, 'the rotated-away seeded token must be dead');
    assert.strictEqual(stale.body.code, 'REFRESH_REVOKED');
  });

  await check('C1 (spec S4): sid logout of the LAST live session clears the push mirror (H6 — push must not follow a signed-out device)', async () => {
    resetState();
    const u = seedPatient({ id: 'pat-s4', push_token: 'ExponentPushToken[mirror-only]', phone: '+201003225401' });
    seedOtp('+2001003225401', '131313');
    const a = await post('/auth/otp/verify', { phone: '01003225401', countryCode: '+20', otp: '131313', deviceId: 'only-phone' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    const out = await post('/auth/logout', null, { Authorization: 'Bearer ' + a.body.data.accessToken });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(u.push_token, null, 'mirror push token survived the last device signing out');
  });

  await check('C1 (spec S4): sid logout of ONE device leaves another device\'s mirror push registration alone', async () => {
    resetState();
    const u = seedPatient({ id: 'pat-s4b', push_token: 'ExponentPushToken[device-A]', phone: '+201003225402' });
    const { generateTokens } = require('../../src/middleware/requireJWT');
    const tA = generateTokens(u); // device A, pre-C1: push in the mirror, legacy session live
    u.refresh_token = tA.refreshToken;
    state.sessions.push({ id: 'sess-legacy-pat-s4b', user_id: 'pat-s4b', refresh_token: tA.refreshToken, push_token: null, client: 'legacy', device_id: 'legacy', revoked_at: null });
    seedOtp('+2001003225402', '141414');
    const b = await post('/auth/otp/verify', { phone: '01003225402', countryCode: '+20', otp: '141414', deviceId: 'phone-B' });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    const out = await post('/auth/logout', null, { Authorization: 'Bearer ' + b.body.data.accessToken });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(u.push_token, 'ExponentPushToken[device-A]', 'device B\'s logout stole device A\'s push');
  });

  // ════ C2 — the doctor door ════

  await check('C2: unknown phone → NOT_A_DOCTOR, and NO users row is created (before/after count identical)', async () => {
    resetState();
    seedOtp('+2001112223334', '333333');
    const before = state.users.length;
    const r = await post('/doctor/auth/otp/verify', { phone: '01112223334', countryCode: '+20', otp: '333333' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'NOT_A_DOCTOR');
    assert.strictEqual(state.users.length, before);
    assert.strictEqual(state.userInserts, 0, 'INSERT INTO users was issued');
  });

  await check('C2: a PATIENT\'s phone at the doctor door → the SAME NOT_A_DOCTOR (no role fingerprinting)', async () => {
    resetState();
    seedPatient();
    seedOtp('+2001003225382', '444444');
    const r = await post('/doctor/auth/otp/verify', { phone: '01003225382', countryCode: '+20', otp: '444444' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'NOT_A_DOCTOR');
    assert.strictEqual(state.userInserts, 0);
  });

  await check('C2: pending doctor → ACCOUNT_PENDING_APPROVAL (its own answer)', async () => {
    resetState();
    seedDoctor({ pending_approval: true, phone: '+201007801001' });
    seedOtp('+2001007801001', '555555');
    const r = await post('/doctor/auth/otp/verify', { phone: '01007801001', countryCode: '+20', otp: '555555' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'ACCOUNT_PENDING_APPROVAL');
  });

  await check('C2: rejected doctor → ACCOUNT_REJECTED (distinct from plain deactivation)', async () => {
    resetState();
    seedDoctor({ is_active: false, rejection_reason: 'Not approved', phone: '+201007801002' });
    seedOtp('+2001007801002', '666666');
    const r = await post('/doctor/auth/otp/verify', { phone: '01007801002', countryCode: '+20', otp: '666666' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'ACCOUNT_REJECTED');
  });

  await check('C2: deactivated doctor → ACCOUNT_INACTIVE', async () => {
    resetState();
    seedDoctor({ is_active: false, phone: '+201007801003' });
    seedOtp('+2001007801003', '777777');
    const r = await post('/doctor/auth/otp/verify', { phone: '01007801003', countryCode: '+20', otp: '777777' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'ACCOUNT_INACTIVE');
  });

  await check('C2: paused doctor STILL signs in (is_paused is routing, not a lockout — login_gate.js)', async () => {
    resetState();
    seedDoctor({ is_paused: true, phone: '+201007801004' });
    seedOtp('+2001007801004', '788788');
    const r = await post('/doctor/auth/otp/verify', { phone: '01007801004', countryCode: '+20', otp: '788788' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await check('C2: active doctor signs in — 12-HOUR refresh (exactly 43200s, not 30d), sid, session row client=doctor_app', async () => {
    resetState();
    seedDoctor();
    seedOtp('+2001007801095', '888888');
    const r = await post('/doctor/auth/otp/verify', { phone: '01007801095', countryCode: '+20', otp: '888888', deviceId: 'doc-phone-1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const dec = jwt.decode(r.body.data.refreshToken);
    assert.strictEqual(dec.exp - dec.iat, 12 * 3600, 'refresh lifetime is ' + (dec.exp - dec.iat) + 's');
    assert.ok(dec.sid);
    const rows = liveSessions('doc-1');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].client, 'doctor_app');
    // no pricing keys in the identity payload
    assert.ok(!('doctor_fee' in r.body.data.user) && !('price' in r.body.data.user));
    global.__c2 = r.body.data;
  });

  await check('C2: doctor refresh rotates inside its row and re-mints 12h (no 30-day laundering)', async () => {
    const r = await post('/doctor/auth/refresh', { refreshToken: global.__c2.refreshToken });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const dec = jwt.decode(r.body.data.refreshToken);
    assert.strictEqual(dec.exp - dec.iat, 12 * 3600);
    assert.strictEqual(liveSessions('doc-1').length, 1);
    global.__c2b = r.body.data;
  });

  await check('C2: doctor refresh re-checks account state — deactivated after sign-in → REFRESH_REVOKED', async () => {
    const d = state.users.find(u => u.id === 'doc-1');
    d.is_active = false;
    const r = await post('/doctor/auth/refresh', { refreshToken: global.__c2b.refreshToken });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'REFRESH_REVOKED');
    assert.strictEqual(liveSessions('doc-1').length, 0);
  });

  await check('C2: the PATIENT door refuses a doctor\'s phone with DOCTOR_LOGIN_REQUIRED (and creates nothing)', async () => {
    resetState();
    seedDoctor();
    seedOtp('+2001007801095', '999999');
    const r = await post('/auth/otp/verify', { phone: '01007801095', countryCode: '+20', otp: '999999' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'DOCTOR_LOGIN_REQUIRED');
    assert.strictEqual(state.userInserts, 0);
  });

  await check('C2 control: the patient door still auto-creates a PATIENT for an unknown phone (unchanged for patients)', async () => {
    resetState();
    seedOtp('+2001555666777', '121212');
    const r = await post('/auth/otp/verify', { phone: '01555666777', countryCode: '+20', otp: '121212' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(state.userInserts, 1);
    assert.strictEqual(r.body.data.user.role, 'patient');
  });

  server.close();
})().catch((e) => {
  t.fail('batch-c auth test harness crashed', e);
  try { server && server.close(); } catch (_) {}
});
