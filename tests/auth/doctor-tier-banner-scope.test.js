// tests/auth/doctor-tier-banner-scope.test.js
//
// 2026-09-13 (mobile B4). The "confirm which turnaround speeds you accept"
// banner was computed true for EVERY doctor page, and partials/doctor/topbar.ejs
// renders it on every page with a topbar — six copies of the same full-width
// call to action (Today, Cases, Profile, Earnings, Alerts, Appointments, every
// case) before any content on a phone. It now shows on Today only, until
// users.sla_tiers_confirmed_at is set. The services page, where the answer is
// given, carries its own framing card (portal_doctor_services.ejs).
//
// Hermetic: stubs ../middleware, ../pg and the service catalog, like
// doctor-services-banner-flag.test.js.
'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🕒 doctor tier-confirm banner is scoped to Today (mobile B4)\n');

// The shared runner loads every test into one process. Another test may already
// have loaded routes/doctor.js bound to ITS pg stub, in which case this file's
// stub would silently never be consulted. Load a fresh copy under these stubs
// and put every cache entry back afterwards so no other test is affected.
const doctorPath = require.resolve('../../src/routes/doctor');
const mwPath = require.resolve('../../src/middleware');
const pgPath = require.resolve('../../src/pg');
const catPath = require.resolve('../../src/services/doctor_service_catalog');
const savedCache = {};
for (const p of [doctorPath, mwPath, pgPath, catPath]) savedCache[p] = require.cache[p];
delete require.cache[doctorPath];

require.cache[mwPath] = {
  id: mwPath, filename: mwPath, loaded: true,
  exports: {
    requireRole: function () { return function (req, res, next) { next(); }; },
    requireAuth: function () { return function (req, res, next) { next(); }; },
    baseMiddlewares: function () {}
  }
};

let stubUserRow = null;
let throwOnQuery = false;
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    queryOne: async function () { if (throwOnQuery) throw new Error('db down'); return stubUserRow; },
    queryAll: async function () { return []; },
    execute: async function () { return { rowCount: 0 }; },
    withTransaction: async function (fn) { return fn({ query: async () => ({ rows: [] }) }); },
    pool: { connect: async function () { return { release: function () {} }; }, totalCount: 0, idleCount: 0, waitingCount: 0 }
  }
};
require.cache[catPath] = {
  id: catPath, filename: catPath, loaded: true,
  exports: { loadDoctorServiceCatalog: async function () { return { isEmpty: true }; } }
};

const compute = require('../../src/routes/doctor')._computeTierConfirmBannerFlag;
for (const p of Object.keys(savedCache)) {
  if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p];
}
if (typeof compute !== 'function') {
  t.fail('test seam', new Error('_computeTierConfirmBannerFlag not exposed on doctor router'));
  process.exit(1);
}

const unconfirmed = { sla_tiers_confirmed_at: null, is_active: true, is_paused: false, pending_approval: false };
async function flagFor(url, row) {
  stubUserRow = row;
  const res = { locals: {} };
  await compute({ user: { id: 'doc-1', role: 'doctor' }, method: 'GET', originalUrl: url }, res);
  return res.locals.doctorTierBanner;
}

module.exports = (async function run() {
  throwOnQuery = false;
  for (const url of ['/portal/doctor', '/portal/doctor/', '/portal/doctor/today', '/portal/doctor/dashboard', '/portal/doctor/today?lang=ar']) {
    try {
      assert.strictEqual(await flagFor(url, unconfirmed), true);
      t.pass('unconfirmed doctor on ' + url + ' → banner ON');
    } catch (e) { t.fail('banner on ' + url, e); }
  }

  for (const url of ['/portal/doctor/cases', '/portal/doctor/queue', '/portal/doctor/profile', '/portal/doctor/earnings',
                     '/portal/doctor/alerts', '/portal/doctor/appointments', '/portal/doctor/case/abc',
                     '/portal/doctor/services', '/portal/doctor/today-extra']) {
    try {
      assert.strictEqual(await flagFor(url, unconfirmed), false);
      t.pass('unconfirmed doctor on ' + url + ' → banner OFF (Today only)');
    } catch (e) { t.fail('banner off ' + url, e); }
  }

  try {
    assert.strictEqual(await flagFor('/portal/doctor/today', Object.assign({}, unconfirmed, { sla_tiers_confirmed_at: new Date() })), false);
    t.pass('confirmed doctor on Today → banner OFF');
  } catch (e) { t.fail('confirmed', e); }

  try {
    assert.strictEqual(await flagFor('/portal/doctor/today', Object.assign({}, unconfirmed, { is_paused: true })), false);
    t.pass('paused doctor on Today → banner OFF (unchanged rule)');
  } catch (e) { t.fail('paused', e); }

  try {
    throwOnQuery = true;
    assert.strictEqual(await flagFor('/portal/doctor/today', unconfirmed), false);
    t.pass('DB error → banner OFF, no throw');
  } catch (e) { t.fail('db error', e); } finally { throwOnQuery = false; }
})().catch(function (err) { t.fail('harness crashed', err); });
