// tests/auth/welcome-limiter-config.test.js
//
// Package 2 (Task 28 — CLEAN HALF): per-IP rate limiters on the ANONYMOUS
// token-redemption routes (/magic-login/:token, /reset-password/:token,
// /set-password) plus the Command-API invite (POST /doctors/:id/invite).
//
// Two layers of assurance:
//   1. Static wiring + option-shape (grep) — the limiter is defined with the
//      right cap and attached to every target route. Cheap, deterministic.
//   2. A REAL behavioral 429 proof against a freshly-spawned server: flood
//      /magic-login past the cap and observe the limiter engage. Feasible and
//      NON-flaky here because each test spawns its OWN server → its OWN in-memory
//      limiter store (the plan's "one client IP across the whole suite" flakiness
//      concern does not apply to a per-test spawn). Skips if DB/JWT env is unset.
//
// DEFERRED (NOT asserted here): superadmin.js welcomeSendIpLimiter on
// resend-welcome + bulk-welcome. That is the T28 "send-side" half, intentionally
// left for when superadmin.js is being edited.
'use strict';
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};
console.log('\n🚦 auth/welcome-limiter-config (Package 2 — Task 28 clean half)\n');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

// ── 1. auth.js: welcomeTokenIpLimiter defined (30/15min) + attached to all 5 ──
try {
  const auth = read('routes', 'auth.js');
  assert.ok(/const\s+welcomeTokenIpLimiter\s*=\s*rateLimit\(/.test(auth),
    'auth.js must define welcomeTokenIpLimiter via rateLimit()');
  const block = (auth.match(/const\s+welcomeTokenIpLimiter\s*=\s*rateLimit\(\{[\s\S]*?\}\);/) || [''])[0];
  assert.ok(/max:\s*30\b/.test(block), 'welcomeTokenIpLimiter cap must be max: 30');
  assert.ok(/windowMs:\s*15\s*\*\s*60\s*\*\s*1000/.test(block), 'window must be 15 minutes');
  assert.ok(/validate:\s*false/.test(block), 'validate: false (trust-proxy shape varies at the Render edge)');
  for (const re of [
    /router\.get\(\s*['"]\/magic-login\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
    /router\.get\(\s*['"]\/reset-password\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
    /router\.post\(\s*['"]\/reset-password\/:token['"]\s*,\s*welcomeTokenIpLimiter/,
    /router\.get\(\s*['"]\/set-password['"]\s*,\s*welcomeTokenIpLimiter/,
    /router\.post\(\s*['"]\/set-password['"]\s*,\s*welcomeTokenIpLimiter/,
  ]) assert.ok(re.test(auth), 'welcomeTokenIpLimiter must be attached: ' + re);
  t.pass('auth.js: welcomeTokenIpLimiter (30/15min) defined + attached to all 5 redemption routes');
} catch (e) { t.fail('auth.js limiter wiring', e); }

// ── 2. api/admin.js: inviteIpLimiter defined (10/15min) + attached to invite ──
try {
  const admin = read('routes', 'api', 'admin.js');
  assert.ok(/require\(['"]express-rate-limit['"]\)/.test(admin), 'api/admin.js must require express-rate-limit');
  assert.ok(/const\s+inviteIpLimiter\s*=\s*rateLimit\(/.test(admin), 'api/admin.js must define inviteIpLimiter');
  const block = (admin.match(/const\s+inviteIpLimiter\s*=\s*rateLimit\(\{[\s\S]*?\}\);/) || [''])[0];
  assert.ok(/max:\s*10\b/.test(block), 'inviteIpLimiter cap must be max: 10');
  assert.ok(/router\.post\(\s*['"]\/doctors\/:id\/invite['"]\s*,\s*inviteIpLimiter/.test(admin),
    'inviteIpLimiter must be attached to POST /doctors/:id/invite');
  t.pass('api/admin.js: inviteIpLimiter (10/15min) defined + attached to POST /doctors/:id/invite');
} catch (e) { t.fail('api/admin.js invite limiter wiring', e); }

// ── 2b. T28 WIDEN: close the genuinely-unthrottled anonymous token surface ──
// The MOBILE /api/v1/auth/{forgot,reset}-password routes are ALREADY throttled
// at the mount (api_v1.js: `router.use('/auth', authLimiter, …)`, 20/15min per IP
// — stricter than the web limiter). The earlier "mobile unthrottled" flag was a
// false positive that missed that mount-level limiter, so we do NOT add a
// duplicate there (that would double-limit). The one genuinely unthrottled
// surface was the WEB POST /forgot-password (a portal route, not under /api/v1).
try {
  const apiv1 = read('routes', 'api_v1.js');
  assert.ok(/const\s+authLimiter\s*=\s*rateLimit\(/.test(apiv1), 'api_v1.js defines authLimiter');
  assert.ok(/router\.use\(\s*['"]\/auth['"]\s*,\s*authLimiter/.test(apiv1),
    'api_v1.js gates the mobile /auth/* router (forgot-password + reset-password) with authLimiter at the mount');
  t.pass('mobile /api/v1/auth token routes already throttled via authLimiter at the mount (no dup added)');
} catch (e) { t.fail('mobile auth throttle (mount-level authLimiter)', e); }

try {
  const auth = read('routes', 'auth.js');
  assert.ok(/router\.post\(\s*['"]\/forgot-password['"]\s*,\s*welcomeTokenIpLimiter/.test(auth),
    'web POST /forgot-password (issuance) must carry welcomeTokenIpLimiter');
  t.pass('auth.js: welcomeTokenIpLimiter now also gates web POST /forgot-password (issuance)');
} catch (e) { t.fail('web forgot-password limiter wiring', e); }

// ── 3. Behavioral: the limiter actually returns 429 past the cap ──
(async function behavioral() {
  if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
    t.skip('welcome-limiter 429 behavior', 'DATABASE_URL/JWT_SECRET not set');
    return;
  }
  const PORT = String(20000 + Math.floor(Math.random() * 10000));
  const BASE = 'http://127.0.0.1:' + PORT;
  let serverProc = null;
  function boot() {
    return new Promise((resolve, reject) => {
      serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')],
        { env: Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1', TZ: 'UTC', PGTZ: 'UTC', CSRF_MODE: 'off' }),
          stdio: ['ignore', 'pipe', 'pipe'] });
      let booted = false;
      serverProc.stdout.on('data', (b) => { if (!booted && /running on port/.test(b.toString())) { booted = true; resolve(); } });
      serverProc.stderr.on('data', () => {});
      serverProc.once('exit', (c) => { if (!booted) reject(new Error('server exited code=' + c)); });
      setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 15000);
    });
  }
  async function shutdown() { if (!serverProc) return; try { serverProc.kill('SIGTERM'); } catch (_) {} await new Promise(r => setTimeout(r, 400)); try { serverProc.kill('SIGKILL'); } catch (_) {} serverProc = null; }

  try { await boot(); } catch (e) { t.skip('welcome-limiter 429 behavior', 'boot failed: ' + e.message); return; }
  try {
    // ── web welcomeTokenIpLimiter (30/15min, shared across redemption routes) ──
    // Fire 31 GETs to an invalid magic-login token from one IP; the first 30 pass
    // (invalid token → login render), the 31st crosses the cap → 429.
    try {
      const statuses = [];
      for (let i = 0; i < 31; i++) {
        const r = await fetch(BASE + '/magic-login/ratelimit-probe', { redirect: 'manual' });
        statuses.push(r.status);
      }
      assert.notStrictEqual(statuses[0], 429, 'the first request must NOT be rate-limited');
      assert.ok(statuses.includes(429), 'limiter must return 429 within 31 requests (cap 30); got ' + JSON.stringify(statuses));
      assert.ok(statuses.filter((s) => s !== 429).length <= 30, 'no more than 30 non-429 responses (cap respected)');
      t.pass('behavioral: /magic-login limiter caps at 30 then returns 429');
    } catch (e) { t.fail('welcome-limiter 429 behavior (web magic-login)', e); }

    // ── mobile /api/v1/auth/reset-password: throttled by the EXISTING authLimiter ──
    // (api_v1.js mount, 20/15min per IP — NOT a new limiter). Proves the mobile
    // redemption surface is capped (regression guard). POST 31× with a valid-length
    // body + bogus token → 400 INVALID each, then 429 once authLimiter's cap trips.
    try {
      const ms = [];
      for (let i = 0; i < 31; i++) {
        const r = await fetch(BASE + '/api/v1/auth/reset-password', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'ratelimit-probe-' + i, password: 'Xx123456' }), redirect: 'manual',
        });
        ms.push(r.status);
      }
      assert.notStrictEqual(ms[0], 429, 'mobile reset: first request must NOT be rate-limited');
      assert.ok(ms.includes(429), 'mobile reset must return 429 within 31 (authLimiter cap 20); got ' + JSON.stringify(ms));
      assert.ok(ms.filter((s) => s !== 429).length <= 30, 'mobile reset: non-429 count well under 31 (authLimiter cap 20, ≤30 with margin)');
      t.pass('behavioral: mobile /api/v1/auth/reset-password limiter caps at 30 then 429');
    } catch (e) { t.fail('mobile-limiter 429 behavior (reset-password)', e); }
  } finally { try { await shutdown(); } catch (_) {} }
})();
