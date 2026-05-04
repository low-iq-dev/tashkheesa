// tests/auth/phone-backfill-gate.test.js
//
// P0-FORM-1: requirePhone() middleware unit tests.
//
// Pure-function tests: stubs req/res/next and exercises every branch of
// the middleware. No HTTP server boot, no DB.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🚧 P0-FORM-1 requirePhone() backfill gate\n');

const { requirePhone, EXEMPT_PREFIXES } = require('../../src/middleware/requirePhone');

function mkReq(overrides) {
  var defaults = {
    user: null,
    path: '/',
    originalUrl: '/',
    url: '/'
  };
  return Object.assign(defaults, overrides || {});
}
function mkRes() {
  var redirected = null;
  return {
    redirect: function (url) { redirected = url; },
    _redirected: function () { return redirected; }
  };
}

function runGate(req) {
  var res = mkRes();
  var nextCalled = false;
  var middleware = requirePhone();
  middleware(req, res, function () { nextCalled = true; });
  return { redirected: res._redirected(), nextCalled: nextCalled };
}

// ── 1. Unauthenticated request: pass through ──────────────────────
try {
  var r = runGate(mkReq({ user: null, path: '/dashboard' }));
  assert.strictEqual(r.nextCalled, true, 'next() called');
  assert.strictEqual(r.redirected, null, 'no redirect');
  t.pass('unauth: passes through (let auth middleware decide)');
} catch (e) { t.fail('unauth pass-through', e); }

// ── 2. Doctor without phone: pass through (gate is patient-only) ─
try {
  var r = runGate(mkReq({
    user: { id: 'd1', role: 'doctor', phone: null },
    path: '/portal/messages/abc'
  }));
  assert.strictEqual(r.nextCalled, true, 'next() called for doctor');
  assert.strictEqual(r.redirected, null, 'no redirect for doctor');
  t.pass('doctor without phone: passes through (shared route safe)');
} catch (e) { t.fail('doctor pass-through', e); }

// ── 3. Admin / superadmin: pass through ────────────────────────────
['admin', 'superadmin'].forEach(function (role) {
  try {
    var r = runGate(mkReq({
      user: { id: role + '1', role: role, phone: null },
      path: '/superadmin'
    }));
    assert.strictEqual(r.nextCalled, true);
    assert.strictEqual(r.redirected, null);
    t.pass(role + ': passes through');
  } catch (e) { t.fail(role + ' pass-through', e); }
});

// ── 4. Patient WITH phone: pass through ────────────────────────────
try {
  var r = runGate(mkReq({
    user: { id: 'p1', role: 'patient', phone: '+201012345678' },
    path: '/dashboard'
  }));
  assert.strictEqual(r.nextCalled, true);
  assert.strictEqual(r.redirected, null);
  t.pass('patient with phone: passes through to dashboard');
} catch (e) { t.fail('patient-with-phone pass-through', e); }

// ── 5. Patient WITHOUT phone on gated route: REDIRECT ─────────────
try {
  var r = runGate(mkReq({
    user: { id: 'p1', role: 'patient', phone: null },
    path: '/dashboard',
    originalUrl: '/dashboard'
  }));
  assert.strictEqual(r.nextCalled, false, 'next() NOT called');
  assert.ok(r.redirected, 'redirect issued');
  assert.ok(/\/portal\/patient\/onboarding/.test(r.redirected), 'redirect to onboarding');
  assert.ok(/force_phone=1/.test(r.redirected), 'force_phone=1 set');
  assert.ok(/next=%2Fdashboard/.test(r.redirected), 'next= preserves original URL');
  t.pass('patient without phone on /dashboard: redirected with force_phone=1&next=/dashboard');
} catch (e) { t.fail('gated redirect', e); }

// ── 6. Empty-string phone counts as missing ────────────────────────
try {
  var r = runGate(mkReq({
    user: { id: 'p1', role: 'patient', phone: '   ' },
    path: '/portal/patient/orders/abc'
  }));
  assert.strictEqual(r.nextCalled, false);
  assert.ok(/force_phone=1/.test(r.redirected), 'whitespace-only phone treated as missing');
  t.pass('whitespace-only phone: treated as missing → redirect');
} catch (e) { t.fail('whitespace phone', e); }

// ── 7. Exempt paths: no redirect even when phone missing ──────────
EXEMPT_PREFIXES.forEach(function (prefix) {
  try {
    // Use the prefix + something after it (most are dirs)
    var path = (prefix === '/logout') ? prefix : (prefix + '/foo');
    var r = runGate(mkReq({
      user: { id: 'p1', role: 'patient', phone: null },
      path: path,
      originalUrl: path
    }));
    assert.strictEqual(r.nextCalled, true, 'next() called for exempt prefix ' + prefix);
    assert.strictEqual(r.redirected, null, 'no redirect for exempt ' + prefix);
    t.pass('exempt prefix: ' + prefix + ' (path=' + path + ')');
  } catch (e) { t.fail('exempt prefix ' + prefix, e); }
});

// ── 8. /api/* routes: no redirect (P3-AUTH-2 deferred) ────────────
try {
  var r = runGate(mkReq({
    user: { id: 'p1', role: 'patient', phone: null },
    path: '/api/v1/cases',
    originalUrl: '/api/v1/cases'
  }));
  assert.strictEqual(r.nextCalled, true, 'next() called for API path');
  assert.strictEqual(r.redirected, null, 'no redirect for API (P3-AUTH-2)');
  t.pass('API path /api/v1/*: no redirect (filed as P3-AUTH-2)');
} catch (e) { t.fail('api exempt', e); }

// ── 9. Exact /portal/patient/onboarding (no trailing slash) ───────
try {
  var r = runGate(mkReq({
    user: { id: 'p1', role: 'patient', phone: null },
    path: '/portal/patient/onboarding',
    originalUrl: '/portal/patient/onboarding'
  }));
  assert.strictEqual(r.nextCalled, true, 'next() called for /portal/patient/onboarding');
  assert.strictEqual(r.redirected, null, 'no redirect — would loop otherwise');
  t.pass('/portal/patient/onboarding: passes through (loop prevention)');
} catch (e) { t.fail('onboarding loop prevention', e); }

// ── 10. Exempt list source-grep: critical paths present ───────────
try {
  var critical = ['/portal/patient/onboarding', '/patient/profile', '/logout'];
  critical.forEach(function (p) {
    assert.ok(EXEMPT_PREFIXES.indexOf(p) !== -1, 'exempt list includes ' + p);
  });
  t.pass('exempt list includes onboarding + profile + logout');
} catch (e) { t.fail('exempt list audit', e); }
