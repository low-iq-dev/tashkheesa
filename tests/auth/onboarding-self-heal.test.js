// tests/auth/onboarding-self-heal.test.js
//
// P0-FORM-1 follow-up: stale-JWT self-heal in onboarding GET.
//
// Pre-fix scenario: a patient who logged in BEFORE phone was added to
// the JWT payload has a cookie where req.user.phone is undefined. They
// have a phone in the DB. requirePhone() middleware redirects them to
// /portal/patient/onboarding. Onboarding GET sees DB phone present and
// redirects to /dashboard. /dashboard middleware sees JWT phone still
// missing and redirects back to onboarding → infinite loop.
//
// Post-fix: onboarding GET detects the mismatch (DB phone present, JWT
// phone missing) and calls refreshSessionCookie() before redirecting.
// Next request carries a fresh cookie with phone in payload, gate clears.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔁 P0-FORM-1 onboarding self-heal (stale JWT)\n');

// ── Stub the pg module BEFORE requiring onboarding ─────────────────
// Module cache: when onboarding.js does require('../pg'), it gets our stub.
const path = require('path');
const pgPath = require.resolve('../../src/pg');
let stubbedDbUser = null;
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    queryOne: async function () { return stubbedDbUser; },
    execute: async function () { return { rowCount: 0 }; },
    queryAll: async function () { return []; },
    pool: { totalCount: 0, idleCount: 0, waitingCount: 0 }
  }
};

// ── Stub middleware so requireRole isn't part of the path ──────────
const middlewarePath = require.resolve('../../src/middleware');
require.cache[middlewarePath] = {
  id: middlewarePath,
  filename: middlewarePath,
  loaded: true,
  exports: {
    requireRole: function () { return function (req, res, next) { next(); }; },
    requireAuth: function () { return function (req, res, next) { next(); }; },
    baseMiddlewares: function () {}
  }
};

// ── Stub logger so onboarding doesn't try to write to a real DB ────
const loggerPath = require.resolve('../../src/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    logErrorToDb: function () {},
    logMajor: function () {},
    verbose: function () {}
  }
};

// Now require — the test seam exposes the GET handler.
const onboarding = require('../../src/routes/onboarding');
const handler = onboarding._handleOnboardingGet;

if (typeof handler !== 'function') {
  t.fail('test seam', new Error('_handleOnboardingGet not exposed on onboarding module'));
  process.exit(1);
}

// ── Stub req/res factory ───────────────────────────────────────────
function mkReq(user, query) {
  return {
    user: user,
    query: query || {},
    originalUrl: '/portal/patient/onboarding',
    method: 'GET'
  };
}
function mkRes() {
  var r = {
    locals: { lang: 'en' },
    statusCode: 200,
    cookies: [],
    rendered: null,
    redirected: null,
    cookie: function (name, val, opts) { r.cookies.push({ name: name, val: val, opts: opts }); },
    redirect: function (url) { r.redirected = url; },
    render: function (view, data) { r.rendered = { view: view, data: data }; },
    status: function (code) { r.statusCode = code; return r; },
    send: function () {}
  };
  return r;
}

(async function run() {
  // ── 1. Stale JWT (no phone field) + DB phone present + onboarding_complete
  //      → cookie SHOULD be refreshed, then redirect to /dashboard
  try {
    stubbedDbUser = {
      onboarding_complete: true,
      name: 'Stale User',
      phone: '+201012345678',
      lang: 'en'
    };
    var req = mkReq({ id: 'p-stale', role: 'patient', email: 'stale@test.local', name: 'Stale User', lang: 'en' /* phone field intentionally absent */ });
    var res = mkRes();
    await handler(req, res);
    assert.strictEqual(res.redirected, '/dashboard', 'redirected to /dashboard');
    assert.strictEqual(res.cookies.length, 1, 'one cookie set (refresh) — got ' + res.cookies.length);
    assert.ok(res.cookies[0].name && res.cookies[0].val, 'cookie has name + value');
    assert.ok(res.cookies[0].opts && res.cookies[0].opts.httpOnly === true, 'cookie httpOnly=true');
    // Decode the JWT to verify phone is now embedded.
    var payload = JSON.parse(Buffer.from(String(res.cookies[0].val).split('.')[1], 'base64').toString());
    assert.strictEqual(payload.phone, '+201012345678', 'fresh JWT payload includes phone — got ' + JSON.stringify(payload.phone));
    assert.strictEqual(payload.id, 'p-stale', 'JWT payload preserves user id');
    t.pass('stale JWT + DB phone present: cookie refreshed with phone in payload, then redirected');
  } catch (e) { t.fail('stale-JWT self-heal', e); }

  // ── 2. Fresh JWT (phone field present) + same DB state
  //      → NO cookie refresh needed, just redirect
  try {
    stubbedDbUser = {
      onboarding_complete: true,
      name: 'Fresh User',
      phone: '+201012345678',
      lang: 'en'
    };
    var req = mkReq({ id: 'p-fresh', role: 'patient', email: 'fresh@test.local', name: 'Fresh User', lang: 'en', phone: '+201012345678' });
    var res = mkRes();
    await handler(req, res);
    assert.strictEqual(res.redirected, '/dashboard', 'redirected to /dashboard');
    assert.strictEqual(res.cookies.length, 0, 'NO cookie refresh (already fresh) — got ' + res.cookies.length);
    t.pass('fresh JWT: no needless cookie refresh, redirect proceeds');
  } catch (e) { t.fail('fresh-JWT no-op refresh', e); }

  // ── 3. ?next= preserved on self-heal redirect ──────────────────────
  try {
    stubbedDbUser = {
      onboarding_complete: true,
      name: 'Stale User',
      phone: '+201012345678',
      lang: 'en'
    };
    var req = mkReq(
      { id: 'p-stale-next', role: 'patient', email: 'stale@test.local', lang: 'en' /* no phone */ },
      { next: '/portal/patient/orders/abc-123' }
    );
    var res = mkRes();
    await handler(req, res);
    assert.strictEqual(res.redirected, '/portal/patient/orders/abc-123', 'redirected to original ?next destination');
    assert.strictEqual(res.cookies.length, 1, 'cookie refreshed during ?next flow');
    t.pass('?next preserved on self-heal redirect');
  } catch (e) { t.fail('?next preservation', e); }

  // ── 4. DB phone MISSING + JWT phone MISSING (the original 29-patient case)
  //      → no redirect (renders wizard), no cookie refresh (nothing to heal)
  try {
    stubbedDbUser = {
      onboarding_complete: false,
      name: '',
      phone: null,
      lang: 'en'
    };
    var req = mkReq({ id: 'p-no-phone', role: 'patient', email: 'np@test.local', lang: 'en' });
    var res = mkRes();
    await handler(req, res);
    assert.strictEqual(res.redirected, null, 'no redirect — wizard renders');
    assert.ok(res.rendered, 'wizard rendered');
    assert.strictEqual(res.rendered.view, 'patient_onboarding', 'correct view');
    assert.strictEqual(res.rendered.data.forcePhone, true, 'forcePhone=true (implicit when DB phone missing)');
    assert.strictEqual(res.cookies.length, 0, 'no cookie refresh (DB has no phone to write into JWT)');
    t.pass('no DB phone + no JWT phone: wizard renders, no spurious refresh');
  } catch (e) { t.fail('no-phone case unaffected', e); }

  // ── 5. Empty-string JWT phone treated as missing (whitespace) ──────
  try {
    stubbedDbUser = {
      onboarding_complete: true,
      name: 'Stale User',
      phone: '+201012345678',
      lang: 'en'
    };
    var req = mkReq({ id: 'p-ws', role: 'patient', email: 'ws@test.local', lang: 'en', phone: '   ' });
    var res = mkRes();
    await handler(req, res);
    assert.strictEqual(res.cookies.length, 1, 'whitespace-only JWT phone treated as missing → refresh');
    t.pass('whitespace-only JWT phone: triggers self-heal');
  } catch (e) { t.fail('whitespace JWT phone', e); }
})().catch(function (err) {
  t.fail('harness crashed', err);
});
