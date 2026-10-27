// tests/core/api-cases-coming-soon-reject.test.js
//
// Coming Soon + visibility guard — mobile API POST /api/v1/cases (spec §4.5).
// The route previously checked NEITHER is_visible NOR coming_soon: a direct
// POST could create an unfulfillable order. This hermetic test builds the
// cases router with mocked safeGet/safeRun, pulls the POST '/' handler out of
// the router stack, and drives it with a fake req/res. No DB, no boot.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');

// 2026-10-27 — since 7dfbdfd (2026-08-25) the handler resolves the service
// through services/case_intake_pricing.resolveServiceForBooking, which reads
// src/pg directly rather than the injected safeGet. With no database that read
// threw (INTERNAL_ERROR); with one, the fixture ids below do not exist
// (INVALID_SERVICE) — either way the rule under test never ran. A fake src/pg,
// installed before anything loads it, answers that one query with the
// fixture, so the REAL bookability rule decides.
let currentService = null;
const fakePool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
  on() {},
};
const pgPath = require.resolve(path.join(__dirname, '..', '..', 'src', 'pg'));
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true, children: [], paths: [],
  exports: {
    pool: fakePool,
    queryOne: async (sql) => (/FROM services sv/.test(String(sql)) ? currentService : null),
    queryAll: async () => [],
    execute: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: async (fn) => fn(await fakePool.connect()),
    verifyPoolSettings: async () => {},
    preflightPool: async () => {},
  },
};

const buildCasesRouter = require('../../src/routes/api/cases');
const { resolveServiceForBooking } = require('../../src/services/case_intake_pricing');

// The fixtures sit in a real, visible specialty: a service with none is
// refused for that reason alone, which would pass these tests for the wrong one.
const IN_SPECIALTY = { specialty_id: 'spec-cardiology', specialty_exists: true, specialty_is_visible: true };

// A minimal valid body that passes the express-validator chains on POST '/'.
function validBody(serviceId) {
  return {
    specialtyId: 'spec-cardiology',
    serviceId: serviceId,
    clinicalQuestion: 'This is a valid clinical question over ten chars.',
    files: [{ fileId: 'orders/draft/pat_1/scan.pdf' }],
    country: 'EG',
  };
}

// Pull the POST '/' handler (LAST layer whose route matches path '/' + POST).
// The cases module uses a module-level singleton router; repeated require()
// calls accumulate routes on it. We always want the LAST registered POST /
// (the most recent call's handler), not the first.
function postHandler(router) {
  let found = null;
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/' && layer.route.methods.post) {
      found = layer;
    }
  }
  if (!found) throw new Error('POST / handler not found on cases router');
  const stack = found.route.stack;
  return stack[stack.length - 1].handle; // final handler after validators
}

// Run express-validator chains so validationResult(req) is populated, then
// return the mock req/res pair.
async function drive(router, service, body) {
  currentService = service;
  let inserted = 0;
  const safeGet = async (sql) => {
    if (/FROM services WHERE id/.test(String(sql))) return service;   // service lookup
    if (/service_regional_prices/.test(String(sql))) return null;     // no regional price
    return null; // orders_active re-read etc. (should not be reached on reject)
  };
  const safeRun = async () => { inserted++; return { rowCount: 1 }; };
  const built = buildCasesRouter({}, { safeGet, safeAll: async () => [], safeRun });

  // Run the validator middlewares that precede the final handler.
  // Use findLast equivalent — the singleton router accumulates routes across
  // calls; we want the LAST registered POST / (the one we just built).
  const postLayers = built.stack.filter(l => l.route && l.route.path === '/' && l.route.methods.post);
  const route = postLayers[postLayers.length - 1].route;
  const req = { body, user: { id: 'pat_1' }, params: {}, query: {}, headers: {}, get: () => '' };
  for (const layer of route.stack.slice(0, -1)) {
    await new Promise((resolve) => layer.handle(req, {}, resolve));
  }

  const res = {
    statusCode: 200, _json: null, _failCode: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    ok(data) { this._json = { success: true, data }; return this; },
    fail(message, status = 400, code) {
      this.statusCode = status; this._failCode = code;
      this._json = { success: false, error: message, code };
      return this;
    },
  };
  const handler = postHandler(built);
  await handler(req, res);
  return { res, inserted: () => inserted };
}

test('rejects a coming_soon service with SERVICE_NOT_BOOKABLE and writes nothing', async () => {
  const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
  const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: true, coming_soon: true, ...IN_SPECIALTY };
  const { res, inserted } = await drive(router, svc, validBody('card_echo'));
  assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE', 'expected SERVICE_NOT_BOOKABLE, got ' + res._failCode);
  assert.equal(res.statusCode, 400);
  assert.equal(inserted(), 0, 'no orders/order_files INSERT may run on reject');
});

test('rejects a hidden (is_visible=false) service with SERVICE_NOT_BOOKABLE', async () => {
  const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
  const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: false, coming_soon: false, ...IN_SPECIALTY };
  const { res, inserted } = await drive(router, svc, validBody('card_echo'));
  assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE');
  assert.equal(inserted(), 0);
});

test('a missing service still fails (existing INVALID_SERVICE behavior preserved)', async () => {
  const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
  const { res } = await drive(router, null, validBody('nope'));
  assert.equal(res._failCode, 'INVALID_SERVICE', 'missing service must be rejected as INVALID_SERVICE; got ' + res._failCode);
});

test('control: the same service, visible and not coming soon, passes the bookability gate', async () => {
  currentService = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: true, coming_soon: false, ...IN_SPECIALTY };
  const svc = await resolveServiceForBooking('card_echo');
  assert.equal(svc.id, 'card_echo', 'a bookable service is returned, so the rejections above are the flags at work');
});
