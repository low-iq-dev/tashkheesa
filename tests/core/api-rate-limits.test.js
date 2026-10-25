// tests/core/api-rate-limits.test.js
//
// 2026-10-11 — the /api/v1 rate limiters (src/middleware/api_rate_limits.js)
// and the address they key on (src/middleware/client_ip.js).
//
// What this pins, each one a production fault from 7 Oct 2026:
//   1. "Per address" means the CALLER. On Render req.ip is an edge hop that
//      changes per request, so two callers shared a bucket and one caller was
//      spread over many.
//   2. Token refresh is not throttled with sign-in attempts. Access tokens
//      live 15 minutes; refresh used to share the 20-per-15-minutes sign-in
//      bucket, so twenty open apps behind one carrier address locked the
//      twenty-first patient out.
//   3. Wrong passwords are counted per ACCOUNT as well as per address.
//   4. Every 429 the API sends is JSON with a Retry-After header — the app's
//      wait-and-retry depends on both.
//   5. The app-wide limiter in src/middleware.js no longer runs in front of
//      /api/v1 (its plain-text 429 is what the app printed as "Request failed
//      (status 429)").
//
// No database, no server boot: a throwaway express app on an ephemeral port.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};

console.log('\n🚦 API rate limits — keyed on the caller, refresh apart from sign-in\n');

const { clientIp, clientIpKey } = require('../../src/middleware/client_ip');
const { buildApiLimiters, jsonLimitHandler, RATE_LIMITED_BODY } = require('../../src/middleware/api_rate_limits');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function test(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// A fresh app per test: every limiter store starts empty.
function makeApp() {
  const app = express();
  app.set('trust proxy', 1);            // same as src/server.js
  app.use(express.json());
  const { apiLimiter, authLimiter, tokenLimiter, loginAccountLimiter } = buildApiLimiters();
  app.use(apiLimiter);
  app.post('/auth/login', loginAccountLimiter);
  const auth = express.Router();
  auth.post('/login', (req, res) => {
    if (req.body && req.body.password === 'right') return res.json({ success: true });
    return res.status(401).json({ success: false, error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' });
  });
  auth.post('/refresh', (req, res) => res.json({ success: true }));
  auth.post('/logout', (req, res) => res.json({ success: true }));
  auth.post('/otp/request', (req, res) => res.json({ success: true }));
  app.use('/auth', authLimiter, tokenLimiter, auth);
  app.get('/cases', (req, res) => res.json({ success: true }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(server, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path: urlPath,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          headers
        ),
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// What Render delivers: the caller in CF-Connecting-IP, an edge hop last in XFF.
const via = (caller, edge) => ({ 'CF-Connecting-IP': caller, 'X-Forwarded-For': caller + ', ' + edge });

(async function main() {
  // ── 1. The address ──────────────────────────────────────────────────────
  await test('clientIp prefers a valid CF-Connecting-IP over req.ip', () => {
    assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': '41.33.10.7' }, ip: '172.71.1.1' }), '41.33.10.7');
    assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': ' 2a02:ed0:1::9 ' }, ip: '172.71.1.1' }), '2a02:ed0:1::9');
  });

  await test('clientIp ignores a header that is not one IP address and falls back to req.ip', () => {
    assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': 'not-an-ip' }, ip: '10.0.0.5' }), '10.0.0.5');
    assert.strictEqual(clientIp({ headers: { 'cf-connecting-ip': '1.1.1.1, 2.2.2.2' }, ip: '10.0.0.5' }), '10.0.0.5');
    assert.strictEqual(clientIp({ headers: {}, ip: '10.0.0.5' }), '10.0.0.5');
    assert.strictEqual(clientIp({ headers: {} }), 'unknown');
    assert.strictEqual(clientIp(undefined), 'unknown');
  });

  await test('clientIpKey collapses an IPv6 subscriber prefix to one key', () => {
    const a = clientIpKey({ headers: { 'cf-connecting-ip': '2a02:ed0:1:2:aaaa::1' } });
    const b = clientIpKey({ headers: { 'cf-connecting-ip': '2a02:ed0:1:2:bbbb::2' } });
    assert.strictEqual(a, b);
    assert.strictEqual(clientIpKey({ headers: { 'cf-connecting-ip': '41.33.10.7' } }), '41.33.10.7');
  });

  await test('one caller keeps ONE bucket while the edge hop changes under them', async () => {
    const server = await listen(makeApp());
    try {
      const seen = [];
      for (const edge of ['172.71.1.1', '172.71.2.2', '162.158.3.3', '172.71.4.4']) {
        const r = await call(server, 'GET', '/cases', { headers: via('41.33.10.7', edge) });
        assert.strictEqual(r.status, 200);
        seen.push(Number(r.headers['ratelimit-remaining']));
      }
      assert.deepStrictEqual(seen, [299, 298, 297, 296], 'remaining must only count down: ' + seen.join(','));
    } finally { server.close(); }
  });

  await test('two callers behind the SAME edge hop do not share a bucket', async () => {
    const server = await listen(makeApp());
    try {
      const a1 = await call(server, 'GET', '/cases', { headers: via('41.33.10.7', '172.71.1.1') });
      const a2 = await call(server, 'GET', '/cases', { headers: via('41.33.10.7', '172.71.1.1') });
      const b1 = await call(server, 'GET', '/cases', { headers: via('156.200.4.9', '172.71.1.1') });
      assert.strictEqual(Number(a1.headers['ratelimit-remaining']), 299);
      assert.strictEqual(Number(a2.headers['ratelimit-remaining']), 298);
      assert.strictEqual(Number(b1.headers['ratelimit-remaining']), 299, 'a second caller starts a fresh bucket');
    } finally { server.close(); }
  });

  await test('a signed-in caller is counted per token (600), not per address', async () => {
    const server = await listen(makeApp());
    try {
      const tokA = 'Bearer ' + 'a'.repeat(40);
      const tokB = 'Bearer ' + 'b'.repeat(40);
      const ip = via('41.33.10.7', '172.71.1.1');
      const a = await call(server, 'GET', '/cases', { headers: Object.assign({ Authorization: tokA }, ip) });
      const b = await call(server, 'GET', '/cases', { headers: Object.assign({ Authorization: tokB }, ip) });
      assert.strictEqual(a.headers['ratelimit-policy'], '600;w=900');
      assert.strictEqual(Number(a.headers['ratelimit-remaining']), 599);
      assert.strictEqual(Number(b.headers['ratelimit-remaining']), 599, 'same address, different token: own bucket');
    } finally { server.close(); }
  });

  // ── 2. Refresh is not a sign-in attempt ─────────────────────────────────
  await test('25 patients behind one address can each refresh; the sign-in bucket is untouched', async () => {
    const server = await listen(makeApp());
    try {
      const ip = via('41.33.10.7', '172.71.1.1');
      for (let i = 0; i < 25; i++) {
        const r = await call(server, 'POST', '/auth/refresh', {
          headers: ip, body: { refreshToken: 'refresh-token-of-patient-number-' + i },
        });
        assert.strictEqual(r.status, 200, 'refresh ' + i + ' was refused with ' + r.status);
      }
      // …and that address can still sign in afterwards.
      const login = await call(server, 'POST', '/auth/login', {
        headers: ip, body: { email: 'p@example.com', password: 'right' },
      });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(Number(login.headers['ratelimit-remaining']), 19, 'refreshes must not have drawn on the sign-in bucket');
    } finally { server.close(); }
  });

  await test('a spent sign-in bucket does not stop refresh or sign-out', async () => {
    const server = await listen(makeApp());
    try {
      const ip = via('41.33.10.7', '172.71.1.1');
      for (let i = 0; i < 20; i++) {
        const r = await call(server, 'POST', '/auth/otp/request', { headers: ip, body: { phone: '10' + i, countryCode: '+20' } });
        assert.strictEqual(r.status, 200);
      }
      const blocked = await call(server, 'POST', '/auth/otp/request', { headers: ip, body: { phone: '1099', countryCode: '+20' } });
      assert.strictEqual(blocked.status, 429, 'the 21st sign-in attempt from one address is refused');
      assert.strictEqual(blocked.json && blocked.json.code, 'RATE_LIMITED');
      assert.ok(Number(blocked.headers['retry-after']) > 0, 'Retry-After is set');

      const refresh = await call(server, 'POST', '/auth/refresh', { headers: ip, body: { refreshToken: 'a-live-refresh-token-0001' } });
      assert.strictEqual(refresh.status, 200, 'refresh must still work');
      const logout = await call(server, 'POST', '/auth/logout', {
        headers: Object.assign({ Authorization: 'Bearer ' + 'c'.repeat(40) }, ip),
      });
      assert.strictEqual(logout.status, 200, 'sign-out must still work');
    } finally { server.close(); }
  });

  await test('one refresh token replayed past its budget is refused (20 / 15 min), JSON + Retry-After', async () => {
    const server = await listen(makeApp());
    try {
      const body = { refreshToken: 'the-same-refresh-token-again' };
      let last = null;
      for (let i = 0; i < 21; i++) {
        // A different address each time: the key is the token, not the address.
        last = await call(server, 'POST', '/auth/refresh', { headers: via('41.33.10.' + (i + 1), '172.71.1.1'), body });
        if (i < 20) assert.strictEqual(last.status, 200, 'replay ' + i);
      }
      assert.strictEqual(last.status, 429);
      assert.strictEqual(last.json && last.json.code, 'RATE_LIMITED');
      assert.strictEqual(last.json && last.json.success, false);
      assert.ok(Number(last.headers['retry-after']) > 0);
    } finally { server.close(); }
  });

  // ── 3. Wrong passwords per account ──────────────────────────────────────
  await test('10 wrong passwords for one account lock it from ANY address; other accounts are unaffected', async () => {
    const server = await listen(makeApp());
    try {
      for (let i = 0; i < 10; i++) {
        const r = await call(server, 'POST', '/auth/login', {
          headers: via('41.33.20.' + (i + 1), '172.71.1.1'),
          // Spelling variants of ONE mailbox must not each get their own budget.
          body: { email: i % 2 ? 'V.ictim+tag' + i + '@Gmail.com' : 'Victim@gmail.com', password: 'wrong' + i },
        });
        assert.strictEqual(r.status, 401, 'guess ' + i);
      }
      const eleventh = await call(server, 'POST', '/auth/login', {
        headers: via('41.33.99.99', '172.71.1.1'),     // an address never seen before
        body: { email: 'victim@gmail.com', password: 'right' },
      });
      assert.strictEqual(eleventh.status, 429, 'the account is locked whatever the address or spelling of the mailbox');
      assert.strictEqual(eleventh.json && eleventh.json.code, 'RATE_LIMITED');
      assert.ok(Number(eleventh.headers['retry-after']) > 0);

      const other = await call(server, 'POST', '/auth/login', {
        headers: via('41.33.99.99', '172.71.1.1'),
        body: { email: 'someone-else@example.com', password: 'right' },
      });
      assert.strictEqual(other.status, 200, 'a different account signs in normally');
    } finally { server.close(); }
  });

  await test('successful sign-ins are not counted against the account', async () => {
    const server = await listen(makeApp());
    try {
      for (let i = 0; i < 15; i++) {
        const r = await call(server, 'POST', '/auth/login', {
          headers: via('41.33.30.' + (i + 1), '172.71.1.1'),
          body: { email: 'regular@example.com', password: 'right' },
        });
        assert.strictEqual(r.status, 200, 'sign-in ' + i + ' answered ' + r.status);
        // skipSuccessfulRequests decrements after the response is flushed.
        await new Promise((res) => setTimeout(res, 5));
      }
    } finally { server.close(); }
  });

  // ── 4. The 429 shape ────────────────────────────────────────────────────
  await test('jsonLimitHandler answers JSON and always sets Retry-After', () => {
    const headers = {};
    let status = 0;
    let sent = null;
    const res = {
      getHeader: (k) => headers[k],
      setHeader: (k, v) => { headers[k] = v; },
      status(s) { status = s; return this; },
      json(b) { sent = b; return this; },
    };
    jsonLimitHandler(RATE_LIMITED_BODY)({ rateLimit: { resetTime: new Date(Date.now() + 42_000) } }, res);
    assert.strictEqual(status, 429);
    assert.deepStrictEqual(sent, RATE_LIMITED_BODY);
    assert.ok(Number(headers['Retry-After']) >= 41 && Number(headers['Retry-After']) <= 42, 'got ' + headers['Retry-After']);

    // No reset time known (the ceiling limiter has no header family on).
    const headers2 = {};
    jsonLimitHandler(RATE_LIMITED_BODY)({}, {
      getHeader: (k) => headers2[k], setHeader: (k, v) => { headers2[k] = v; },
      status() { return this; }, json() { return this; },
    });
    assert.ok(Number(headers2['Retry-After']) > 0);
  });

  // ── 5. Wiring ───────────────────────────────────────────────────────────
  await test('api_v1.js mounts the limiters: account cap on /auth/login, token limiter on all three doors', () => {
    const src = read('src/routes/api_v1.js');
    assert.ok(/buildApiLimiters\(\)/.test(src), 'api_v1.js must build its limiters from api_rate_limits.js');
    assert.ok(!/rateLimit\(\{/.test(src), 'no inline rateLimit({...}) left in api_v1.js');
    assert.ok(/router\.post\('\/auth\/login',\s*loginAccountLimiter\)/.test(src));
    assert.ok(/router\.use\('\/auth',\s*authLimiter,\s*tokenLimiter,\s*authRoutes\)/.test(src));
    assert.ok(/router\.use\('\/admin\/auth',\s*authLimiter,\s*tokenLimiter\)/.test(src));
    assert.ok(/router\.use\('\/doctor\/auth',\s*authLimiter,\s*tokenLimiter,\s*doctorAuthRoutes\)/.test(src));
    // The account cap must be registered before the /auth router answers.
    assert.ok(src.indexOf("router.post('/auth/login', loginAccountLimiter)") < src.indexOf("router.use('/auth', authLimiter"));
  });

  await test('the payment-status poll and /health stay exempt from the API limiter', () => {
    const src = read('src/routes/api_v1.js');
    const m = /const RATE_LIMIT_EXEMPT = (\/.+\/);/.exec(src);
    assert.ok(m, 'RATE_LIMIT_EXEMPT not found');
    // eslint-disable-next-line no-eval
    const re = eval(m[1]);
    assert.ok(re.test('/health'));
    assert.ok(re.test('/cases/abc-123/payment'));
    assert.ok(!re.test('/cases/abc-123'));
    assert.ok(!re.test('/cases/abc-123/payment-claim'));
  });

  await test('the app-wide limiter skips /api/v1 and keys on the caller', () => {
    const src = read('src/middleware.js');
    const at = src.indexOf('const limiter = rateLimit({');
    assert.ok(at > 0, 'global limiter not found');
    const block = src.slice(at, src.indexOf('app.use(limiter);', at));
    assert.ok(/keyGenerator:\s*\(req\)\s*=>\s*clientIpKey\(req\)/.test(block), 'global limiter must key on clientIpKey');
    assert.ok(/skip:/.test(block) && /\/api\/v1/.test(block), 'global limiter must skip /api/v1');
    assert.ok(/max:\s*100/.test(block) && /windowMs:\s*1 \* 60 \* 1000/.test(block), 'website budget unchanged (100 / minute)');
  });

  await test('every per-address limiter in middleware.js, api/admin.js and api/ops_checks.js keys on the caller, with its cap unchanged', () => {
    const mw = read('src/middleware.js');
    const blocks = mw.match(/rateLimit\(\{[\s\S]*?\n  \}\)/g) || [];
    assert.ok(blocks.length >= 9, 'expected the 9 limiters of middleware.js, found ' + blocks.length);
    blocks.forEach((b) => assert.ok(/keyGenerator:/.test(b) && /clientIpKey/.test(b), 'limiter still keyed on req.ip:\n' + b.slice(0, 160)));
    assert.ok(!/req\.ip\b/.test(mw.replace(/\/\/.*$/gm, '')), 'middleware.js must not key anything on req.ip');
    // The caps this batch did NOT change.
    const caps = blocks.map((b) => (/max:\s*(\d+)/.exec(b) || [])[1]).join(',');
    assert.strictEqual(caps, '100,30,50,10,20,10,10,10,10', 'limiter caps changed: ' + caps);

    const invite = (read('src/routes/api/admin.js').match(/const inviteIpLimiter = rateLimit\(\{[\s\S]*?\}\);/) || [''])[0];
    assert.ok(/clientIpKey/.test(invite) && /max:\s*10\b/.test(invite));
    const ops = (read('src/routes/api/ops_checks.js').match(/const limiter = rateLimit\(\{[\s\S]*?\}\);/) || [''])[0];
    assert.ok(/clientIpKey/.test(ops) && /max:\s*30\b/.test(ops));
  });

  await test('OTP per-phone caps are unchanged (60s cooldown, 3 sends, 5 verifies per 15 min)', () => {
    const src = read('src/middleware/otp_phone_limits.js');
    assert.ok(/otpSendCooldown = rateLimit\(\{\s*windowMs: 60 \* 1000, max: 1,/.test(src));
    assert.ok(/otpSendCap = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000, max: 3,/.test(src));
    assert.ok(/otpVerifyCap = rateLimit\(\{\s*windowMs: 15 \* 60 \* 1000, max: 5,/.test(src));
    assert.ok(/'ip:' \+ clientIpKey\(req\)/.test(src), 'the no-phone fallback keys on the caller');
  });
})();
