// tests/core/push-token-own-bucket.test.js
//
// 2026-10-26 — patient app builds 13-15 POST /profile/push-token about once a
// second on iPhone (expo-notifications' push-token listener re-fires on every
// getExpoPushTokenAsync). On the shared per-user API bucket (600 / 15 min)
// that locked the owner out of every screen in about ten minutes.
//
// Pins:
//   1. A verified user's POST push-token (patient, doctor, Command) has its
//      own bucket — 20 / 15 min, then 200 { deduped: true }, never 429 — and
//      never spends the 600 API bucket. 100 posts leave GET /cases at 200.
//   2. An unverified push-token POST still goes through the API limiter.
//   3. The same token again is not written (patient route, run for real).
//   4. user_sessions.pushTokenAlreadyStored matches how each route stores.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📲 push-token — its own bucket, and no write for the same token\n');

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-for-push-token';
const jwt = require('jsonwebtoken');
const { buildApiLimiters, verifiedUserId } = require('../../src/middleware/api_rate_limits');

const ROOT = path.join(__dirname, '..', '..');
const bearerFor = (id, extra = {}) => 'Bearer ' + jwt.sign(Object.assign({ id, role: 'patient' }, extra), process.env.JWT_SECRET, { expiresIn: '15m' });
const TOKEN = 'ExponentPushToken[abcDEF123]';

function freshRequire(rel) {
  const p = require.resolve(rel);
  const prev = require.cache[p];
  delete require.cache[p];
  try { return require(p); } finally { if (prev) require.cache[p] = prev; else delete require.cache[p]; }
}

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
function call(server, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers),
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function test(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// The routing exactly as src/routes/api_v1.js does it (pinned by the wiring
// check below).
function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const { apiLimiter, pushTokenLimiter } = buildApiLimiters();
  const PUSH_TOKEN_POST = /^\/(profile|doctor|admin)\/push-token$/;
  app.use((req, res, next) => {
    if (req.method === 'POST' && PUSH_TOKEN_POST.test(req.path) && verifiedUserId(req)) {
      return pushTokenLimiter(req, res, next);
    }
    return apiLimiter(req, res, next);
  });
  const hits = { push: 0 };
  for (const base of ['/profile', '/doctor', '/admin']) {
    app.post(base + '/push-token', (req, res) => { hits.push += 1; res.json({ success: true, data: { message: 'Push token registered' } }); });
  }
  app.get('/cases', (req, res) => res.json({ success: true }));
  app.hits = hits;
  return app;
}

module.exports = (async () => {
  const ip = { 'CF-Connecting-IP': '196.156.131.143', 'X-Forwarded-For': '196.156.131.143, 172.71.1.1' };

  await test('100 push-token posts from one user: all 200, 20 reach the route, and GET /cases is still 200 with the API bucket untouched', async () => {
    const app = makeApp();
    const server = await listen(app);
    try {
      const auth = Object.assign({ Authorization: bearerFor('f4956ab1-owner') }, ip);
      let deduped = 0;
      for (let i = 0; i < 100; i++) {
        const r = await call(server, 'POST', '/profile/push-token', { headers: auth, body: { token: TOKEN } });
        assert.strictEqual(r.status, 200, 'post ' + (i + 1) + ' answered ' + r.status);
        assert.ok(!r.headers['retry-after'], 'no Retry-After: an old build must not back off and retry');
        if (r.json && r.json.data && r.json.data.deduped === true) deduped += 1;
      }
      assert.strictEqual(app.hits.push, 20, 'only 20 reach the route (and the database)');
      assert.strictEqual(deduped, 80);
      const cases = await call(server, 'GET', '/cases', { headers: auth });
      assert.strictEqual(cases.status, 200);
      assert.strictEqual(Number(cases.headers['ratelimit-remaining']), 599, 'push-token posts never spent the 600 bucket');
    } finally { server.close(); }
  });

  await test('doctor and Command push-token posts use the same separate bucket', async () => {
    const app = makeApp();
    const server = await listen(app);
    try {
      for (const p of ['/doctor/push-token', '/admin/push-token']) {
        const auth = Object.assign({ Authorization: bearerFor('u-' + p, { role: 'doctor' }) }, ip);
        for (let i = 0; i < 30; i++) {
          const r = await call(server, 'POST', p, { headers: auth, body: { token: TOKEN } });
          assert.strictEqual(r.status, 200);
        }
        const cases = await call(server, 'GET', '/cases', { headers: auth });
        assert.strictEqual(Number(cases.headers['ratelimit-remaining']), 599, p);
      }
      assert.strictEqual(app.hits.push, 40);
    } finally { server.close(); }
  });

  await test('an unverified token posting push-token still spends the API limiter', async () => {
    const app = makeApp();
    const server = await listen(app);
    try {
      const forged = Object.assign({ Authorization: 'Bearer ' + jwt.sign({ id: 'x' }, 'not-our-secret') }, ip);
      const r1 = await call(server, 'POST', '/profile/push-token', { headers: forged, body: { token: TOKEN } });
      const r2 = await call(server, 'POST', '/profile/push-token', { headers: forged, body: { token: TOKEN } });
      assert.strictEqual(r1.headers['ratelimit-policy'], '600;w=900');
      assert.strictEqual(Number(r2.headers['ratelimit-remaining']), Number(r1.headers['ratelimit-remaining']) - 1);
    } finally { server.close(); }
  });

  await test('api_v1.js routes a verified POST push-token to pushTokenLimiter, everything else to apiLimiter', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/api_v1.js'), 'utf8');
    assert.ok(/const PUSH_TOKEN_POST = \/\^\\\/\(profile\|doctor\|admin\)\\\/push-token\$\/;/.test(src));
    assert.ok(/req\.method === 'POST' && PUSH_TOKEN_POST\.test\(req\.path\) && verifiedUserId\(req\)\)\s*\{\s*return pushTokenLimiter\(req, res, next\);/.test(src));
    const lim = fs.readFileSync(path.join(ROOT, 'src/middleware/api_rate_limits.js'), 'utf8');
    const block = lim.slice(lim.indexOf('const pushTokenLimiter = rateLimit({'));
    assert.ok(/max: 20,/.test(block.slice(0, 600)));
    assert.ok(/res\.status\(200\)\.json\(\{ success: true, data: \{ deduped: true \} \}\)/.test(block.slice(0, 600)));
  });

  // ── user_sessions.pushTokenAlreadyStored ────────────────────────────────
  function storeWith(rows) {
    const calls = [];
    const safeGet = async (sql, p) => {
      calls.push(sql);
      if (/FROM user_sessions/.test(sql)) return rows.session === undefined ? null : { push_token: rows.session };
      if (/FROM users/.test(sql)) return rows.mirror === undefined ? null : { push_token: rows.mirror };
      if (rows.throws) throw new Error('db');
      return null;
    };
    const svc = freshRequire('../../src/services/user_sessions')({ safeGet, safeAll: async () => [], safeRun: async () => ({ rowCount: 1 }) });
    return { svc, calls };
  }

  await test('pushTokenAlreadyStored: session row decides when it exists; else the mirror; alsoMirror needs both', async () => {
    let s = storeWith({ session: TOKEN });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: TOKEN }), true);
    s = storeWith({ session: 'ExponentPushToken[old]', mirror: TOKEN });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: TOKEN }), false, 'session holds another token');
    s = storeWith({ mirror: TOKEN });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's-gone', userId: 'u', pushToken: TOKEN }), true, 'no session row: the mirror is what the route writes');
    s = storeWith({ mirror: TOKEN });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ userId: 'u', pushToken: TOKEN }), true, 'sid-less token');
    s = storeWith({ session: TOKEN, mirror: 'ExponentPushToken[old]' });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: TOKEN, alsoMirror: true }), false);
    s = storeWith({ session: TOKEN, mirror: TOKEN });
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: TOKEN, alsoMirror: true }), true);
    assert.strictEqual(await s.svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: '' }), false);
  });

  await test('pushTokenAlreadyStored: a failing lookup answers false (the route writes, as before)', async () => {
    const svc = freshRequire('../../src/services/user_sessions')({
      safeGet: async () => { throw new Error('db down'); }, safeAll: async () => [], safeRun: async () => ({}),
    });
    assert.strictEqual(await svc.pushTokenAlreadyStored({ sessionId: 's1', userId: 'u', pushToken: TOKEN }), false);
  });

  // ── The patient route, for real ─────────────────────────────────────────
  await test('POST /profile/push-token with the token already stored: 200 and no write; a new token is written', async () => {
    const writes = [];
    let stored = TOKEN;
    const helpers = {
      safeGet: async (sql) => {
        if (/SELECT push_token FROM user_sessions/.test(sql)) return { push_token: stored };
        if (/SELECT push_token FROM users/.test(sql)) return { push_token: null };
        return null;
      },
      safeAll: async () => [],
      safeRun: async (sql, p) => { writes.push(sql); if (/UPDATE user_sessions SET push_token/.test(sql)) stored = p[0]; return { rowCount: 1 }; },
    };
    const app = express();
    app.use(require('../../src/middleware/apiResponse'));
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u-1', role: 'patient', sid: 'sess-1' }; next(); });
    app.use('/profile', freshRequire('../../src/routes/api/profile')(null, helpers));
    const server = await listen(app);
    try {
      const same = await call(server, 'POST', '/profile/push-token', { body: { token: TOKEN } });
      assert.strictEqual(same.status, 200, JSON.stringify(same.json));
      assert.strictEqual(same.json.data.deduped, true);
      assert.strictEqual(writes.length, 0, 'identical token: nothing written');
      const rotated = await call(server, 'POST', '/profile/push-token', { body: { token: 'ExponentPushToken[newOne]' } });
      assert.strictEqual(rotated.status, 200);
      assert.ok(!rotated.json.data.deduped);
      assert.strictEqual(writes.filter((s) => /UPDATE user_sessions SET push_token/.test(s)).length, 1, 'a new token is written once');
    } finally { server.close(); }
  });

  await test('doctor and Command routes skip the write for the same token too', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'src/routes/api/doctor_inbox.js'), 'utf8');
    assert.ok(/pushTokenAlreadyStored\(\{ sessionId: sid, userId: me, pushToken: token, alsoMirror: true \}\)/.test(doc));
    const adm = fs.readFileSync(path.join(ROOT, 'src/routes/api/admin.js'), 'utf8');
    assert.ok(/pushTokenAlreadyStored\(\{ sessionId: req\.user\.sid, userId: req\.user\.id, pushToken: token \}\)/.test(adm));
  });
})();
