// tests/auth/doctor-services-landing.test.js
//
// §4.7 first-login landing: a doctor with onboarding_complete=false AND a
// non-empty service union lands on /portal/doctor/services; an empty-union
// doctor (and any onboarding_complete=true doctor, and non-doctors) lands on
// their normal home. Hermetic — stubs ../pg + ../services/doctor_service_catalog
// via require.cache, no live DB (mirrors onboarding-self-heal.test.js).
'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧭 doctor first-login services landing (§4.7)\n');

// Stub ../pg so acquiring a client never touches a real DB.
const pgPath = require.resolve('../../src/pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    pool: { connect: async function () { return { release: function () {} }; } },
    queryOne: async function () { return null; },
    queryAll: async function () { return []; },
    execute: async function () { return { rowCount: 0 }; }
  }
};

// Stub the catalog loader — resolveDoctorLanding must consult isEmpty.
let stubCatalog = { isEmpty: true };
let catalogCalls = 0;
const catPath = require.resolve('../../src/services/doctor_service_catalog');
require.cache[catPath] = {
  id: catPath, filename: catPath, loaded: true,
  exports: {
    loadDoctorServiceCatalog: async function (client, args) {
      catalogCalls++;
      stubCatalog._lastArgs = args;
      return stubCatalog;
    }
  }
};

// AUDIT (2026-08-16) — evict doctor_landing before requiring it.
//
// The stubs above are injected into require.cache, which only takes effect for
// a module that has not been loaded yet: doctor_landing destructures `pool` and
// `loadDoctorServiceCatalog` ONCE at its own load time. Any earlier test file
// that pulled in routes/auth.js or routes/doctor.js had already loaded it
// against the real modules, so this file silently tested the real catalog
// loader against a real (absent) database and reported three failures that had
// nothing to do with the code — it passed when run on its own, and only failed
// inside the suite, which is the signature of require-cache order dependence.
delete require.cache[require.resolve('../../src/services/doctor_landing')];
const { resolveDoctorLanding, shouldLandOnServices } = require('../../src/services/doctor_landing');

module.exports = (async function run() {
  // 1. Non-empty union + not onboarded → /portal/doctor/services
  try {
    stubCatalog = { isEmpty: false };
    const dest = await resolveDoctorLanding(
      { id: 'doc-1', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: false }
    );
    assert.strictEqual(dest, '/portal/doctor/services', 'non-empty-union unonboarded doctor → services');
    assert.deepStrictEqual(stubCatalog._lastArgs, { doctorId: 'doc-1', specialtyId: 'spec-card' }, 'catalog queried by doctorId+specialtyId');
    t.pass('non-empty union, onboarding_complete=false → /portal/doctor/services');
  } catch (e) { t.fail('normal doctor lands on services', e); }

  // 2. Empty union + not onboarded → normal doctor home (NOT services → no loop)
  try {
    stubCatalog = { isEmpty: true };
    const dest = await resolveDoctorLanding(
      { id: 'doc-2', role: 'doctor', specialty_id: 'spec-empty', onboarding_complete: false }
    );
    assert.strictEqual(dest, '/portal/doctor', 'empty-union doctor → dashboard, never services');
    t.pass('empty union, onboarding_complete=false → /portal/doctor (no redirect loop)');
  } catch (e) { t.fail('empty-union doctor lands on dashboard', e); }

  // 3. Already onboarded doctor → dashboard, catalog not even consulted
  try {
    stubCatalog = { isEmpty: false };
    catalogCalls = 0;
    const dest = await resolveDoctorLanding(
      { id: 'doc-3', role: 'doctor', specialty_id: 'spec-card', onboarding_complete: true }
    );
    assert.strictEqual(dest, '/portal/doctor', 'onboarded doctor → dashboard');
    assert.strictEqual(catalogCalls, 0, 'onboarded doctor: catalog short-circuited (no union query)');
    t.pass('onboarding_complete=true → /portal/doctor, no catalog query');
  } catch (e) { t.fail('onboarded doctor short-circuit', e); }

  // 4. Non-doctor (patient) → null so caller keeps its own default
  try {
    stubCatalog = { isEmpty: false };
    catalogCalls = 0;
    const dest = await resolveDoctorLanding(
      { id: 'p-1', role: 'patient', onboarding_complete: false }
    );
    assert.strictEqual(dest, null, 'non-doctor → null (caller falls back to getHomeByRole)');
    assert.strictEqual(catalogCalls, 0, 'non-doctor: no catalog query');
    t.pass('patient → null landing (caller uses its own redirect)');
  } catch (e) { t.fail('patient null landing', e); }

  // 5. shouldLandOnServices predicate mirrors the decision (banner slice reuses it)
  try {
    stubCatalog = { isEmpty: false };
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-4', role: 'doctor', specialty_id: 's', onboarding_complete: false }), true, 'true when unonboarded + non-empty');
    stubCatalog = { isEmpty: true };
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-5', role: 'doctor', specialty_id: 's', onboarding_complete: false }), false, 'false when empty union');
    assert.strictEqual(await shouldLandOnServices({ id: 'doc-6', role: 'doctor', specialty_id: 's', onboarding_complete: true }), false, 'false when already onboarded');
    t.pass('shouldLandOnServices predicate matches landing decision');
  } catch (e) { t.fail('shouldLandOnServices predicate', e); }

  // 6. Wiring guard: POST /set-password must call the shared landing helper (not a
  //    hardcoded getHomeByRole for doctors). NOTE: Task 26 (magic-login backdoor
  //    fix) removed the /magic-login landing branch — a password-holding doctor is
  //    now bounced to /login (never auto-logged-in), so magic-login no longer calls
  //    resolveDoctorLanding at all. The doctor's first-login services landing is
  //    owned entirely by POST /set-password, the only path that can reach it with a
  //    freshly-set password. Cheap source assertion — the full HTTP redirect is
  //    exercised by the doctor-services integration test that boots the app.
  try {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../src/routes/auth.js'), 'utf8');
    assert.ok(/require\(['"]\.\.\/services\/doctor_landing['"]\)/.test(src), 'auth.js imports doctor_landing');
    const calls = (src.match(/resolveDoctorLanding\(user\)/g) || []).length;
    assert.ok(calls >= 1, 'resolveDoctorLanding(user) wired into the POST /set-password first-login redirect (got ' + calls + ')');
    t.pass('auth.js wires resolveDoctorLanding into the /set-password first-login redirect');
  } catch (e) { t.fail('auth.js wiring guard', e); }
})().catch(function (err) { t.fail('harness crashed', err); });
