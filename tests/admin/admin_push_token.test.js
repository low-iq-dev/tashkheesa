'use strict';
// POST /api/v1/admin/push-token — superadmin Expo push-token registration
// (Batch 2a). Registers the authenticated superadmin's own users.push_token so
// watchdog-triggered worker-down pushes can reach the Command device.
//
// Hermetic route suite — mirrors admin_payment_events.test.js. safeRun is stubbed
// to capture the write; auth gating comes from the router's requireJWT +
// requireRole('superadmin') gate.
//
// JWT_SECRET + SUPERADMIN_EMAIL must be set BEFORE requiring the app modules.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-push-token';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = { id: 'd1d04fb8-cc53-4928-b412-60f763546d09', email: 'ziad.wahsh@shifaegypt.com', role: 'superadmin', name: 'Ziad El Wahsh' };
const PATIENT = { id: 'p-1', email: 'patient@example.com', role: 'patient', name: 'A Patient' };

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function makeApp(stubs = {}) {
  const runCalls = [];
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1 }; }),
    // AUDIT-KPI-HONESTY (2026-08-29) — the money/KPI endpoints now read through
    // mustGet/mustAll (src/sql-utils.js), which THROW instead of swallowing so
    // a failed query becomes a 500 rather than a fabricated zero. They are
    // injected exactly like the soft helpers; these stubs map them onto the
    // same fakes so every existing assertion (including the captured SQL) is
    // unchanged, and a test that wants to exercise the failure path can pass
    // mustGet/mustAll explicitly.
    mustGet: stubs.mustGet || stubs.safeGet || (async () => null),
    mustAll: stubs.mustAll || stubs.safeAll || (async () => []),
  };
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const deploy = { gitSha: 'abc1234', startedAt: 1718352000000, startedAtIso: '2026-06-14T07:00:00.000Z', version: '1.0.0', mode: 'test' };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, {}));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}`, runCalls };
}

async function call(base, method, path, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const parsed = await res.json().catch(() => null);
  return { res, body: parsed };
}

const PATH = '/api/v1/admin/push-token';

// ── auth gating ─────────────────────────────────────────────────────────────

test('POST /push-token: no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, null, { token: 'ExponentPushToken[x]' });
    assert.equal(res.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally { server.close(); }
});

test('POST /push-token: patient-role token → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(PATIENT), { token: 'ExponentPushToken[x]' });
    assert.equal(res.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  } finally { server.close(); }
});

// ── happy path + format validation ───────────────────────────────────────────

test('POST /push-token: superadmin + valid ExponentPushToken → 200, writes own row', async () => {
  const { server, base, runCalls } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: 'ExponentPushToken[abc123]' });
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.message, 'Push token registered');
    assert.equal(runCalls.length, 1);
    assert.match(runCalls[0].sql, /UPDATE users SET push_token/);
    assert.deepEqual(runCalls[0].params, ['ExponentPushToken[abc123]', SUPERADMIN.id]);
  } finally { server.close(); }
});

test('POST /push-token: ExpoPushToken[...] alt prefix accepted → 200', async () => {
  const { server, base, runCalls } = makeApp();
  try {
    const { res } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: 'ExpoPushToken[zzz]' });
    assert.equal(res.status, 200);
    assert.deepEqual(runCalls[0].params, ['ExpoPushToken[zzz]', SUPERADMIN.id]);
  } finally { server.close(); }
});

test('POST /push-token: trims surrounding whitespace before validate + store', async () => {
  const { server, base, runCalls } = makeApp();
  try {
    const { res } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: '  ExponentPushToken[trim]  ' });
    assert.equal(res.status, 200);
    assert.deepEqual(runCalls[0].params, ['ExponentPushToken[trim]', SUPERADMIN.id]);
  } finally { server.close(); }
});

test('POST /push-token: bad format → 400 INVALID_PUSH_TOKEN, no write', async () => {
  const { server, base, runCalls } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: 'garbage' });
    assert.equal(res.status, 400);
    assert.equal(body.code, 'INVALID_PUSH_TOKEN');
    assert.equal(runCalls.length, 0);
  } finally { server.close(); }
});

test('POST /push-token: missing token field → 400 INVALID_PUSH_TOKEN', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), {});
    assert.equal(res.status, 400);
    assert.equal(body.code, 'INVALID_PUSH_TOKEN');
  } finally { server.close(); }
});

test('POST /push-token: whitespace-only token → 400 INVALID_PUSH_TOKEN', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: '   ' });
    assert.equal(res.status, 400);
    assert.equal(body.code, 'INVALID_PUSH_TOKEN');
  } finally { server.close(); }
});

test('POST /push-token: DB write failure → 500 PUSH_TOKEN_ERROR', async () => {
  const { server, base } = makeApp({ safeRun: async () => { throw new Error('db down'); } });
  try {
    const { res, body } = await call(base, 'POST', PATH, mintToken(SUPERADMIN), { token: 'ExponentPushToken[x]' });
    assert.equal(res.status, 500);
    assert.equal(body.code, 'PUSH_TOKEN_ERROR');
  } finally { server.close(); }
});
