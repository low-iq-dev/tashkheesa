// tests/auth/doctor-services-banner-flag.test.js
//
// §4.7 soft-nudge banner: the doctor topbar shows a "confirm your services"
// banner while onboarding_complete=false AND the service union is non-empty.
// The flag is computed ONCE per request in doctor.js middleware (no per-page
// N+1). Hermetic — stubs ../middleware, ../pg, ../services/doctor_service_catalog.
'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔔 doctor services-banner flag (§4.7)\n');

// Stub middleware so requiring doctor.js doesn't drag in real auth/DB wiring.
const mwPath = require.resolve('../../src/middleware');
require.cache[mwPath] = {
  id: mwPath, filename: mwPath, loaded: true,
  exports: {
    requireRole: function () { return function (req, res, next) { next(); }; },
    requireAuth: function () { return function (req, res, next) { next(); }; },
    baseMiddlewares: function () {}
  }
};

// Stub pg: queryOne returns whatever stubUserRow is; pool.connect gives a
// releasable client for doctor_landing's own acquire path.
let stubUserRow = null;
const pgPath = require.resolve('../../src/pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    queryOne: async function () { return stubUserRow; },
    queryAll: async function () { return []; },
    execute: async function () { return { rowCount: 0 }; },
    withTransaction: async function (fn) { return fn({ query: async () => ({ rows: [] }) }); },
    pool: { connect: async function () { return { release: function () {} }; }, totalCount: 0, idleCount: 0, waitingCount: 0 }
  }
};

// Stub the catalog loader used (transitively) by doctor_landing.
let stubCatalog = { isEmpty: true };
const catPath = require.resolve('../../src/services/doctor_service_catalog');
require.cache[catPath] = {
  id: catPath, filename: catPath, loaded: true,
  exports: { loadDoctorServiceCatalog: async function () { return stubCatalog; } }
};

const doctorRouter = require('../../src/routes/doctor');
const compute = doctorRouter._computeServicesBannerFlag;

if (typeof compute !== 'function') {
  t.fail('test seam', new Error('_computeServicesBannerFlag not exposed on doctor router'));
  process.exit(1);
}

function mkReq(user) { return { user: user, method: 'GET', originalUrl: '/portal/doctor' }; }
function mkRes() { return { locals: {} }; }

(async function run() {
  // 1. Unonboarded doctor + non-empty union → banner ON
  try {
    stubUserRow = { id: 'doc-a', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false };
    stubCatalog = { isEmpty: false };
    const req = mkReq({ id: 'doc-a', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, true, 'banner ON for unonboarded non-empty-union doctor');
    t.pass('onboarding_complete=false + non-empty union → doctorServicesBanner=true');
  } catch (e) { t.fail('banner on', e); }

  // 2. Empty-union doctor → banner OFF (escape-hatch doctor: nothing to confirm)
  try {
    stubUserRow = { id: 'doc-b', role: 'doctor', specialty_id: 'spec-empty', onboarding_complete: false };
    stubCatalog = { isEmpty: true };
    const req = mkReq({ id: 'doc-b', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'no banner for empty-union doctor');
    t.pass('empty union → doctorServicesBanner=false');
  } catch (e) { t.fail('banner off empty union', e); }

  // 3. Already onboarded → banner OFF
  try {
    stubUserRow = { id: 'doc-c', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: true };
    stubCatalog = { isEmpty: false };
    const req = mkReq({ id: 'doc-c', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'no banner once onboarding_complete=true');
    t.pass('onboarding_complete=true → doctorServicesBanner=false');
  } catch (e) { t.fail('banner off onboarded', e); }

  // 4. Failure is swallowed → flag defaults false (never throws off a page render)
  try {
    stubUserRow = { id: 'doc-d', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false };
    stubCatalog = null; // makes catalog.isEmpty throw
    const req = mkReq({ id: 'doc-d', role: 'doctor' }); const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'error path → banner false, no throw');
    t.pass('banner-flag error is swallowed → false (best-effort, never breaks page)');
  } catch (e) { t.fail('banner flag error swallowed', e); }

  // 5. Self-referential guard: /portal/doctor/services → banner OFF regardless
  try {
    stubUserRow = { id: 'doc-e', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false };
    stubCatalog = { isEmpty: false };
    const req = { user: { id: 'doc-e', role: 'doctor' }, method: 'GET', originalUrl: '/portal/doctor/services' };
    const res = mkRes();
    await compute(req, res);
    assert.strictEqual(res.locals.doctorServicesBanner, false, 'no banner on services page itself');
    t.pass('self-ref guard: /portal/doctor/services → doctorServicesBanner=false');
  } catch (e) { t.fail('self-ref guard', e); }

  // 6. Source-level registration-order assertion: banner middleware appears BEFORE first router.get
  try {
    const src = require('fs').readFileSync(require.resolve('../../src/routes/doctor.js'), 'utf8');
    const bannerUseIdx = src.indexOf('_computeServicesBannerFlag(req, res)');
    const firstRouterGetIdx = src.indexOf("router.get('");
    assert.ok(bannerUseIdx > 0, 'banner middleware registration found in source');
    assert.ok(firstRouterGetIdx > 0, 'first router.get found in source');
    assert.ok(bannerUseIdx < firstRouterGetIdx,
      `banner router.use (char ${bannerUseIdx}) must appear before first router.get (char ${firstRouterGetIdx})`);
    t.pass('registration order: _computeServicesBannerFlag router.use is before first router.get');
  } catch (e) { t.fail('registration order check', e); }
})().catch(function (err) { t.fail('harness crashed', err); });
