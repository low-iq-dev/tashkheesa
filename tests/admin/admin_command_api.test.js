'use strict';

// Phase 1 — Tashkheesa Command admin API: superadmin login + gate + /admin/health.
// Hermetic: the router is built via its (db, helpers, deploy) factory with stubs,
// so no real DB is touched. Run with: node --test tests/admin/admin_command_api.test.js
//
// JWT_SECRET + SUPERADMIN_EMAIL must be set BEFORE requiring the app modules,
// because src/middleware/requireJWT.js captures JWT_SECRET at module-load time.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-phase1';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const apiResponse = require('../../src/middleware/apiResponse');
const { generateAdminTokens } = require('../../src/middleware/requireJWT');
const adminHealth = require('../../src/services/admin_health');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = {
  id: 'd1d04fb8-cc53-4928-b412-60f763546d09',
  email: 'ziad.wahsh@shifaegypt.com',
  role: 'superadmin',
  name: 'Ziad El Wahsh',
};

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// Build a throwaway express app with the admin router mounted exactly as
// api_v1.js will mount it (at /api/v1/admin), with injected stub helpers.
function makeApp(stubs = {}) {
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async () => ({ rowCount: 0 })),
  };
  const pool = stubs.pool || { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const deploy = stubs.deploy || {
    gitSha: 'abc1234',
    startedAt: 1718352000000,
    startedAtIso: '2026-06-14T07:00:00.000Z',
    version: '1.0.0',
    mode: 'test',
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// ─────────────────────────── unit: admin token TTLs ───────────────────────────

test('generateAdminTokens: access token expires in 15 minutes', () => {
  const { accessToken } = generateAdminTokens(SUPERADMIN);
  const d = jwt.decode(accessToken);
  assert.equal(d.exp - d.iat, 15 * 60);
  assert.equal(d.id, SUPERADMIN.id);
  assert.equal(d.role, 'superadmin');
  assert.equal(d.email, SUPERADMIN.email);
});

test('generateAdminTokens: refresh token expires in 12 hours and is typed', () => {
  const { refreshToken } = generateAdminTokens(SUPERADMIN);
  const d = jwt.decode(refreshToken);
  assert.equal(d.exp - d.iat, 12 * 60 * 60);
  assert.equal(d.type, 'refresh');
  assert.equal(d.id, SUPERADMIN.id);
});

// ──────────────── unit: worker liveness (alive / starting / down) ─────────────
// The 5th arg (uptimeSec) lets us distinguish a worker that is genuinely dead
// from one that simply hasn't pinged yet because the host instance just woke
// from idle (Render free-tier sleep). Only a long-uptime instance with a stale
// heartbeat is 'down'; a short-uptime one is 'starting'.

test('workerLiveness: a fresh ping is alive', () => {
  const now = 1_000_000_000_000;
  const r = adminHealth.workerLiveness('case_sla_worker', new Date(now - 60_000), now, 720, 100_000);
  assert.equal(r.alive, true);
  assert.equal(r.status, 'alive');
  assert.equal(r.name, 'case_sla_worker');
  assert.equal(r.ageSec, 60);
});

test('workerLiveness: stale ping + long uptime → genuinely down', () => {
  const now = 1_000_000_000_000;
  const r = adminHealth.workerLiveness('acceptance_watcher', new Date(now - 1_000_000), now, 360, 100_000);
  assert.equal(r.alive, false);
  assert.equal(r.status, 'down');
});

test('workerLiveness: stale ping + short uptime → starting (instance just woke, not dead)', () => {
  const now = 1_000_000_000_000;
  const r = adminHealth.workerLiveness('case_sla_worker', new Date(now - 1_000_000), now, 720, 30);
  assert.equal(r.alive, false);
  assert.equal(r.status, 'starting');
});

test('workerLiveness: missing ping + long uptime → down', () => {
  const now = 1_000_000_000_000;
  const r = adminHealth.workerLiveness('case_sla_worker', null, now, 720, 100_000);
  assert.equal(r.alive, false);
  assert.equal(r.status, 'down');
  assert.equal(r.lastRunAt, null);
});

test('workerLiveness: missing ping + short uptime → starting', () => {
  const now = 1_000_000_000_000;
  const r = adminHealth.workerLiveness('case_sla_worker', null, now, 720, 30);
  assert.equal(r.alive, false);
  assert.equal(r.status, 'starting');
});

test('buildHealthPayload: assembles api/db/workers/deploy with both canonical workers', () => {
  const now = 1_000_000_000_000;
  const payload = adminHealth.buildHealthPayload({
    uptimeSec: 86400,
    pool: { totalCount: 2, idleCount: 2, waitingCount: 0 },
    heartbeatRows: [
      { agent_name: 'case_sla_worker', last_run: new Date(now - 60_000) },
      { agent_name: 'acceptance_watcher', last_run: new Date(now - 60_000) },
    ],
    deploy: { gitSha: 'abc1234', startedAtIso: '2026-06-14T07:00:00.000Z', version: '1.0.0', mode: 'test' },
    now,
  });
  assert.equal(payload.api.reachable, true);
  assert.equal(payload.api.uptimeSec, 86400);
  assert.equal(payload.db.connected, true);
  assert.equal(payload.workers.case_sla_worker.alive, true);
  assert.equal(payload.workers.case_sla_worker.status, 'alive');
  assert.equal(payload.workers.acceptance_watcher.alive, true);
  assert.equal(payload.deploy.sha, 'abc1234');
  assert.equal(payload.deploy.version, '1.0.0');
});

test('buildHealthPayload: a long-up instance with stale heartbeats reports workers down', () => {
  const now = 1_000_000_000_000;
  const payload = adminHealth.buildHealthPayload({
    uptimeSec: 86400, // up a full day — stale pings here are real failures
    pool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
    heartbeatRows: [
      { agent_name: 'case_sla_worker', last_run: new Date(now - 3 * 3600 * 1000) },
      { agent_name: 'acceptance_watcher', last_run: new Date(now - 3 * 3600 * 1000) },
    ],
    deploy: {},
    now,
  });
  assert.equal(payload.workers.case_sla_worker.status, 'down');
  assert.equal(payload.workers.acceptance_watcher.status, 'down');
});

test('buildHealthPayload: a just-woken instance with stale heartbeats reports starting, not down', () => {
  const now = 1_000_000_000_000;
  const payload = adminHealth.buildHealthPayload({
    uptimeSec: 8, // instance woke 8s ago on this very request
    pool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
    heartbeatRows: [
      { agent_name: 'case_sla_worker', last_run: new Date(now - 3 * 3600 * 1000) },
    ],
    deploy: {},
    now,
  });
  assert.equal(payload.workers.case_sla_worker.status, 'starting');
  assert.equal(payload.workers.acceptance_watcher.status, 'starting'); // missing + short uptime
});

// ─────────────────────────── integration: gate ────────────────────────────────

test('GET /admin/health without a token → 401', async () => {
  const { server, base } = makeApp();
  try {
    const res = await fetch(`${base}/api/v1/admin/health`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally { server.close(); }
});

test('GET /admin/health with a patient token → 403', async () => {
  const { server, base } = makeApp();
  try {
    const token = mintToken({ id: 'p1', email: 'p@x.com', role: 'patient', name: 'P' });
    const res = await fetch(`${base}/api/v1/admin/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN');
  } finally { server.close(); }
});

test('GET /admin/health with a superadmin token → 200 + health payload', async () => {
  const now = Date.now();
  const { server, base } = makeApp({
    safeAll: async () => ([
      { agent_name: 'case_sla_worker', last_run: new Date(now - 60_000) },
      { agent_name: 'acceptance_watcher', last_run: new Date(now - 60_000) },
    ]),
  });
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.api.reachable, true);
    assert.equal(body.data.db.connected, true);
    assert.equal(body.data.workers.case_sla_worker.alive, true);
    assert.equal(body.data.workers.acceptance_watcher.alive, true);
    assert.equal(body.data.deploy.sha, 'abc1234');
  } finally { server.close(); }
});

// ─────────────────────────── integration: admin login ─────────────────────────

test('POST /admin/auth/login with missing fields → 401', async () => {
  const { server, base } = makeApp();
  try {
    const res = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  } finally { server.close(); }
});

test('POST /admin/auth/login with a non-allowlisted email → 401 (no DB lookup)', async () => {
  let dbHit = false;
  const { server, base } = makeApp({ safeGet: async () => { dbHit = true; return null; } });
  try {
    const res = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@evil.com', password: 'whatever' }),
    });
    assert.equal(res.status, 401);
    assert.equal(dbHit, false, 'must not query the DB for a non-allowlisted email');
  } finally { server.close(); }
});

test('POST /admin/auth/login with the superadmin email + wrong password → 401', async () => {
  const hash = await bcrypt.hash('correct-horse', 10);
  const { server, base } = makeApp({
    safeGet: async () => ({ ...SUPERADMIN, password_hash: hash }),
  });
  try {
    const res = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERADMIN.email, password: 'wrong-password' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  } finally { server.close(); }
});

test('POST /admin/auth/login with the superadmin email + correct password → 200 + tokens; stores refresh', async () => {
  const hash = await bcrypt.hash('correct-horse', 10);
  let storedRefresh = null;
  const { server, base } = makeApp({
    safeGet: async () => ({ ...SUPERADMIN, password_hash: hash }),
    safeRun: async (sql, params) => { if (/refresh_token/i.test(sql)) storedRefresh = params[0]; return { rowCount: 1 }; },
  });
  try {
    const res = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERADMIN.email, password: 'correct-horse' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.accessToken, 'returns an access token');
    assert.ok(body.data.refreshToken, 'returns a refresh token');
    assert.equal(body.data.user.role, 'superadmin');
    assert.ok(!('password_hash' in body.data.user), 'never leak password_hash');
    assert.equal(storedRefresh, body.data.refreshToken, 'persists the issued refresh token');
    // refresh token must carry the admin 12h TTL
    const d = jwt.decode(body.data.refreshToken);
    assert.equal(d.exp - d.iat, 12 * 60 * 60);
  } finally { server.close(); }
});

test('POST /admin/auth/login: a correctly-authenticated non-superadmin role → 401', async () => {
  // Defense-in-depth: even if a row comes back for the allowlisted email,
  // a non-superadmin role must never receive admin tokens.
  const hash = await bcrypt.hash('correct-horse', 10);
  const { server, base } = makeApp({
    safeGet: async () => ({ ...SUPERADMIN, role: 'patient', password_hash: hash }),
  });
  try {
    const res = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERADMIN.email, password: 'correct-horse' }),
    });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});
