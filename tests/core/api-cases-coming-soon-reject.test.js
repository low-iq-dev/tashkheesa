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

const buildCasesRouter = require('../../src/routes/api/cases');

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
  const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: true, coming_soon: true };
  const { res, inserted } = await drive(router, svc, validBody('card_echo'));
  assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE', 'expected SERVICE_NOT_BOOKABLE, got ' + res._failCode);
  assert.equal(res.statusCode, 400);
  assert.equal(inserted(), 0, 'no orders/order_files INSERT may run on reject');
});

test('rejects a hidden (is_visible=false) service with SERVICE_NOT_BOOKABLE', async () => {
  const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
  const svc = { id: 'card_echo', name: 'Echo', base_price: 1000, currency: 'EGP', is_visible: false, coming_soon: false };
  const { res, inserted } = await drive(router, svc, validBody('card_echo'));
  assert.equal(res._failCode, 'SERVICE_NOT_BOOKABLE');
  assert.equal(inserted(), 0);
});

test('a missing service still fails (existing INVALID_SERVICE behavior preserved)', async () => {
  const router = buildCasesRouter({}, { safeGet: async () => null, safeAll: async () => [], safeRun: async () => {} });
  const { res } = await drive(router, null, validBody('nope'));
  assert.ok(res._failCode === 'INVALID_SERVICE' || res._failCode === 'SERVICE_NOT_BOOKABLE',
    'missing service must be rejected; got ' + res._failCode);
});
