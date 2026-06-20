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
  // Post-commit notification helpers are injected (4th factory arg). Default
  // to inert stubs so every assign test stays hermetic — no real pool is hit.
  const notifiers = stubs.notifiers || {
    ensureConversation: async () => 'convo-stub',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true, messageId: 'stub' }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
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

// ─────────────────────────── integration: /pulse ──────────────────────────────
// Stubs branch on the SQL so one safeGet/safeAll pair can answer all six
// queries the route fires. Mirrors live prod shapes (reference_id NULL,
// gender 'male'/'female', heterogeneous order_events labels).

const PULSE_STUBS = {
  safeGet: async (sql) => {
    if (/FROM users/i.test(sql) && /pending_approval/i.test(sql)) return { pending_approvals: 0 };
    if (/FROM orders_active/i.test(sql)) {
      return {
        active_cases: 4, awaiting_review: 1, pending_assignment: 3,
        sla_breached: 1, no_sla_timer: 3, oldest_pending_mins: 95,
      };
    }
    return null;
  },
  safeAll: async (sql) => {
    if (/order_events/i.test(sql)) {
      return [
        { id: 'ev1', label: 'payment_confirmed', at: new Date('2026-06-16T06:21:36.926Z'), actor_role: 'system', actor_name: null, reference_id: null, order_id: 'ord-12345678abcdef' },
        { id: 'ev2', label: 'draft_created', at: new Date('2026-06-16T06:19:38.542Z'), actor_role: 'patient', actor_name: 'Ziad EL Wahsh', reference_id: null, order_id: 'ord-9999' },
      ];
    }
    if (/deadline_at::timestamptz < NOW\(\)/i.test(sql)) {
      return [{ id: 'ord-breach-1', reference_id: null, patient: 'Layla Kamal', specialty: 'Oncology', sla_mins: -46 }];
    }
    return [{
      id: 'ord-pend-1', reference_id: null, status: 'paid', urgency_tier: 'urgent',
      patient: 'Hassan Mahmoud', gender: 'male', date_of_birth: '1971-05-01',
      specialty: 'Cardiology', service: '12-Lead ECG Interpretation', sla_mins: null,
    }];
  },
};

test('GET /admin/pulse without a token → 401', async () => {
  const { server, base } = makeApp();
  try {
    const res = await fetch(`${base}/api/v1/admin/pulse`);
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('GET /admin/pulse with a patient token → 403', async () => {
  const { server, base } = makeApp();
  try {
    const token = mintToken({ id: 'p1', email: 'p@x.com', role: 'patient', name: 'P' });
    const res = await fetch(`${base}/api/v1/admin/pulse`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('GET /admin/pulse with a superadmin token → 200 + honest pulse payload', async () => {
  const { server, base } = makeApp(PULSE_STUBS);
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/pulse`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { data: d, success } = await res.json();
    assert.equal(success, true);

    assert.equal(d.operator.name, SUPERADMIN.name);
    assert.equal(typeof d.generatedAt, 'string');

    assert.equal(d.kpis.activeCases, 4);
    assert.equal(d.kpis.awaitingReview, 1);
    assert.equal(d.kpis.pendingAssignment, 3);
    assert.equal(d.kpis.oldestPendingMins, 95);
    assert.equal(d.kpis.slaBreached, 1);
    assert.equal(d.kpis.noSlaTimer, 3);

    // decision B — SLA approaching/healthy deferred, never fabricated
    assert.equal(d.kpis.slaApproaching, null);
    assert.equal(d.sla.healthy, null);
    assert.equal(d.sla.approaching, null);
    assert.equal(d.sla.breached, 1);
    assert.equal(d.sla.noTimer, 3);

    // breached: id falls back to raw id when reference_id is null
    assert.equal(d.needsAction.pendingAssignmentCount, 3);
    assert.equal(d.needsAction.breached.length, 1);
    assert.equal(d.needsAction.breached[0].id, 'ord-breach-1');
    assert.equal(d.needsAction.breached[0].slaMins, -46);

    // pending: id fallback, ageSex derived, service-as-summary, null SLA
    assert.equal(d.pendingAssignment.length, 1);
    const pc = d.pendingAssignment[0];
    assert.equal(pc.id, 'ord-pend-1');
    assert.equal(pc.service, '12-Lead ECG Interpretation');
    assert.equal(pc.tier, 'urgent');
    assert.equal(pc.status, 'paid');
    assert.equal(pc.slaMins, null);
    assert.match(pc.ageSex, /^\d{1,3}M$/);

    assert.equal(d.doctorBacklog.pendingApprovals, 0);

    // recent activity — actor-attributed, kind classified, label humanized
    assert.equal(d.recentActivity.length, 2);
    assert.equal(d.recentActivity[0].kind, 'payment');
    assert.equal(d.recentActivity[0].actor, 'System');
    assert.equal(d.recentActivity[0].title, 'Payment confirmed');
    assert.equal(d.recentActivity[1].kind, 'draft');
    assert.equal(d.recentActivity[1].actor, 'Ziad EL Wahsh');
    assert.equal(d.recentActivity[1].title, 'Draft created');
  } finally { server.close(); }
});

test('GET /admin/pulse on a cold/empty DB → 200 with zeroed honest payload (no throw)', async () => {
  const { server, base } = makeApp(); // safeGet→null, safeAll→[]
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/pulse`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { data: d } = await res.json();
    assert.equal(d.kpis.activeCases, 0);
    assert.equal(d.kpis.oldestPendingMins, null);
    assert.equal(d.kpis.slaApproaching, null);
    assert.equal(d.sla.breached, 0);
    assert.deepEqual(d.pendingAssignment, []);
    assert.deepEqual(d.recentActivity, []);
    assert.equal(d.doctorBacklog.pendingApprovals, 0);
  } finally { server.close(); }
});

// ─────────────────────────── integration: /cases (list) ───────────────────────

const LIST_STUBS = {
  safeAll: async (sql) => {
    if (/GROUP BY LOWER\(o\.status\)/.test(sql)) {
      return [
        { s: 'paid', n: 2, unassigned: 2, breached: 0 },
        { s: 'in_progress', n: 1, unassigned: 0, breached: 1 },
        { s: 'completed', n: 1, unassigned: 0, breached: 0 },
        { s: 'expired_unpaid', n: 22, unassigned: 0, breached: 0 },
      ];
    }
    return [
      { id: 'ord-1', reference_id: null, status: 'in_progress', urgency_tier: 'urgent', payment_status: 'paid', doctor_id: 'doc-1', created_at: new Date('2026-06-16T06:00:00Z'), deadline_at: new Date('2026-06-15T00:00:00Z'), completed_at: null, patient: 'Layla Kamal', gender: 'female', date_of_birth: '1996-01-01', specialty: 'Oncology', service: 'Histopathology', doctor_name: 'Dr. Heba Sami', sla_mins: -46 },
      { id: 'ord-2', reference_id: null, status: 'paid', urgency_tier: 'standard', payment_status: 'paid', doctor_id: null, created_at: new Date('2026-06-16T05:00:00Z'), deadline_at: null, completed_at: null, patient: 'Hassan Mahmoud', gender: 'male', date_of_birth: '1971-05-01', specialty: 'Cardiology', service: '12-Lead ECG Interpretation', doctor_name: null, sla_mins: null },
    ];
  },
  safeGet: async (sql) => (/COUNT\(\*\) AS total/.test(sql) ? { total: 2 } : null),
};

test('GET /admin/cases without a token → 401', async () => {
  const { server, base } = makeApp();
  try { assert.equal((await fetch(`${base}/api/v1/admin/cases`)).status, 401); } finally { server.close(); }
});

test('GET /admin/cases with a patient token → 403', async () => {
  const { server, base } = makeApp();
  try {
    const token = mintToken({ id: 'p1', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await fetch(`${base}/api/v1/admin/cases`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  } finally { server.close(); }
});

test('GET /admin/cases → 200, normalized statuses, flags, facet counts', async () => {
  const { server, base } = makeApp(LIST_STUBS);
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/cases`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { data: d } = await res.json();

    assert.equal(d.total, 2);
    assert.equal(d.limit, 25);
    assert.equal(d.cases.length, 2);

    const a = d.cases[0];
    assert.equal(a.id, 'ord-1'); // raw id, the routing key
    assert.equal(a.reference, null);
    assert.equal(a.status, 'in_review'); // 'in_progress' folded → canonical
    assert.equal(a.doctor, 'Dr. Heba Sami');
    assert.equal(a.unassigned, false);
    assert.equal(a.breached, true);
    assert.match(a.ageSex, /^\d{1,3}F$/);

    const b = d.cases[1];
    assert.equal(b.status, 'paid');
    assert.equal(b.doctor, null);
    assert.equal(b.unassigned, true); // paid + no doctor
    assert.equal(b.slaMins, null);
    assert.equal(b.breached, false);

    // facet counts (global, normalized)
    assert.equal(d.counts.all, 26);
    assert.equal(d.counts.unassigned, 2);
    assert.equal(d.counts.breached, 1);
    assert.equal(d.counts.byStatus.in_review, 1); // in_progress folded
    assert.equal(d.counts.byStatus.paid, 2);
    assert.equal(d.counts.byStatus.expired_unpaid, 22);
  } finally { server.close(); }
});

// ─────────────────────────── integration: /cases/:id (detail) ─────────────────

const DETAIL_STUBS = {
  safeGet: async (sql) => {
    if (/diagnosis_text/.test(sql) && /WHERE o\.id = \$1/.test(sql)) {
      return {
        id: 'ord-2', reference_id: null, status: 'paid', urgency_tier: 'standard', payment_status: 'paid',
        paid_at: new Date('2026-06-16T05:30:00Z'), payment_method: 'card', price: 1250,
        created_at: new Date('2026-06-16T05:00:00Z'), completed_at: null, accepted_at: null, deadline_at: null, sla_hours: 48,
        doctor_id: null, specialty_id: 'spec-cardiology', service_id: 'card_ecg_12lead',
        diagnosis_text: null, impression_text: null, recommendation_text: null, clinical_question: null, report_url: null,
        patient_name: 'Ziad EL Wahsh', gender: null, date_of_birth: '2001-03-21',
        doctor_name: null, specialty: 'Cardiology', service: '12-Lead ECG Interpretation', doctor_specialty: null, sla_mins: null,
      };
    }
    if (/specialty_classifications/.test(sql)) return { specialty_id: 'spec-cardiology', service_id: 'card_ecg_12lead', confidence: 0.95, reasoning: 'ECG second opinion', model: 'claude-haiku-4-5', ai_specialty: 'Cardiology', ai_service: '12-Lead ECG Interpretation' };
    if (/max_active_cases/.test(sql)) return null; // unassigned
    if (/FROM refunds/.test(sql)) return null;
    return null;
  },
  safeAll: async (sql) => {
    if (/FROM order_files/.test(sql)) return [{ id: 'file-1', filename: null, label: null, mime_type: null, size: null, url: 'orders/ord-2/00ee4c8b-c6bd-484e-8535-d79c378a32fb.jpeg', created_at: new Date() }];
    if (/order_additional_files/.test(sql)) return [];
    if (/order_events/.test(sql)) return [{ id: 'ev1', label: 'payment_confirmed', at: new Date('2026-06-16T05:30:00Z'), actor_role: 'system', actor_name: null }];
    return [];
  },
};

test('GET /admin/cases/:id (not found) → 404', async () => {
  const { server, base } = makeApp(); // safeGet→null → no row
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/cases/nope`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'NOT_FOUND');
  } finally { server.close(); }
});

test('GET /admin/cases/:id → 200 full detail: AI, derived file, empty report, unassigned', async () => {
  const { server, base } = makeApp(DETAIL_STUBS);
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/cases/ord-2`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { data: d } = await res.json();

    assert.equal(d.id, 'ord-2');
    assert.equal(d.status, 'paid');
    assert.equal(d.patient.name, 'Ziad EL Wahsh');
    assert.match(d.patient.ageSex, /^\d{1,3}$/); // dob present, gender null → age only

    assert.equal(d.routing.specialty, 'Cardiology');
    assert.equal(d.sla.hasTimer, false);
    assert.equal(d.sla.slaHours, 48);
    assert.equal(d.payment.state, 'paid');
    assert.equal(d.payment.price, 1250);

    assert.equal(d.assignment, null); // unassigned

    // AI specialty (real classifier shape)
    assert.equal(d.ai.specialty, 'Cardiology');
    assert.equal(d.ai.confidencePct, 95);
    assert.equal(d.ai.model, 'claude-haiku-4-5');
    assert.equal(d.ai.matchesRouting, true);

    // file name derived from the R2 key (filename/label null in prod), kind from ext
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].name, '00ee4c8b-c6bd-484e-8535-d79c378a32fb.jpeg');
    assert.equal(d.files[0].kind, 'image');
    assert.equal(d.files[0].downloadPath, '/files/file-1');

    // report honest empty-state (paid, not completed)
    assert.equal(d.report.present, false);
    assert.equal(d.report.signed, false);

    // timeline from order_events
    assert.equal(d.timeline.length, 1);
    assert.equal(d.timeline[0].kind, 'payment');
    assert.equal(d.timeline[0].actor, 'System');
    assert.equal(d.timeline[0].title, 'Payment confirmed');
  } finally { server.close(); }
});

test('GET /admin/cases/:id → assignment + signed report present when assigned & completed', async () => {
  const stubs = {
    safeGet: async (sql) => {
      if (/diagnosis_text/.test(sql) && /WHERE o\.id = \$1/.test(sql)) {
        return {
          id: 'ord-9', reference_id: null, status: 'completed', urgency_tier: 'standard', payment_status: 'paid',
          paid_at: new Date(), payment_method: 'card', price: 2000, created_at: new Date(), completed_at: new Date(), accepted_at: new Date(), deadline_at: null, sla_hours: 48,
          doctor_id: 'doc-1', specialty_id: 'spec-cardiology', service_id: 'svc-1',
          diagnosis_text: 'Findings: normal sinus rhythm.', impression_text: 'No acute abnormality.', recommendation_text: 'Routine follow-up.', clinical_question: 'Palpitations.', report_url: 'orders/ord-9/report.pdf',
          patient_name: 'Demo Patient', gender: 'male', date_of_birth: '1980-01-01', doctor_name: 'Dr. Ahmed Hassan', specialty: 'Cardiology', service: 'ECG', doctor_specialty: 'Cardiology', sla_mins: null,
        };
      }
      if (/specialty_classifications/.test(sql)) return null;
      if (/max_active_cases/.test(sql)) return { cap: 8, load: 3, sla_hit: 0.92, rating: 4.8 };
      if (/FROM refunds/.test(sql)) return null;
      return null;
    },
    safeAll: async () => [],
  };
  const { server, base } = makeApp(stubs);
  try {
    const token = mintToken(SUPERADMIN);
    const res = await fetch(`${base}/api/v1/admin/cases/ord-9`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { data: d } = await res.json();
    assert.equal(d.status, 'completed');
    assert.ok(d.assignment, 'assignment present');
    assert.equal(d.assignment.doctor.name, 'Dr. Ahmed Hassan');
    assert.equal(d.assignment.doctor.cap, 8);
    assert.equal(d.assignment.doctor.load, 3);
    assert.equal(d.assignment.doctor.slaPct, 92);
    assert.equal(d.assignment.doctor.rating, 4.8);
    assert.equal(d.ai, null);
    assert.equal(d.report.present, true);
    assert.equal(d.report.findings, 'Findings: normal sinus rhythm.');
    assert.equal(d.report.signed, true); // completed
    assert.equal(d.report.pdfPath, 'orders/ord-9/report.pdf');
  } finally { server.close(); }
});

// ─────────────────────────── integration: /candidates + /assign ───────────────

const CAND_STUBS = {
  safeGet: async (sql) => (/FROM orders_active o LEFT JOIN specialties/.test(sql)
    ? { id: 'ord-1', specialty_id: 'spec-cardiology', urgency_tier: 'urgent', doctor_id: null, specialty: 'Cardiology' }
    : null),
  safeAll: async () => ([
    { id: 'doc-a', name: 'Dr A', is_active: true, is_paused: false, specialty_id: 'spec-cardiology', specialty: 'Cardiology', max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: ['standard', 'urgent'], load: 2 },
    { id: 'doc-b', name: 'Dr B', is_active: false, is_paused: false, specialty_id: 'spec-cardiology', specialty: 'Cardiology', max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: ['standard'], load: 0 },
    { id: 'doc-c', name: 'Dr C', is_active: true, is_paused: false, specialty_id: 'spec-cardiology', specialty: 'Cardiology', max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: ['standard', 'urgent'], load: 8 },
  ]),
};

test('GET /admin/cases/:id/candidates → 403 for patient, 200 with eligibility flags for superadmin', async () => {
  let app = makeApp();
  try {
    const pt = mintToken({ id: 'p', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/candidates`, { headers: { Authorization: `Bearer ${pt}` } })).status, 403);
  } finally { app.server.close(); }
  app = makeApp(CAND_STUBS);
  try {
    const res = await fetch(`${app.base}/api/v1/admin/cases/ord-1/candidates`, { headers: { Authorization: `Bearer ${mintToken(SUPERADMIN)}` } });
    assert.equal(res.status, 200);
    const { data: d } = await res.json();
    assert.equal(d.case.tier, 'urgent');
    const byId = Object.fromEntries(d.candidates.map((c) => [c.id, c]));
    assert.equal(byId['doc-a'].eligible, true);
    assert.equal(byId['doc-a'].supportsTier, true);
    assert.equal(byId['doc-b'].eligible, false); // inactive
    assert.equal(byId['doc-b'].supportsTier, false);
    assert.equal(byId['doc-c'].atCapacity, true); // load 8 >= urgent cap 8
    assert.equal(byId['doc-c'].eligible, false);
    assert.equal(d.candidates[0].id, 'doc-a'); // eligible-first sort
  } finally { app.server.close(); }
});

// Mock transaction client so the atomic write is hermetic (no real DB).
function txClient(handler) {
  const calls = [];
  const client = {
    calls,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
      return handler(s, params);
    },
    release() {},
  };
  return client;
}
function poolWith(client) { return { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => client }; }

function assignHandler(over = {}) {
  const order = over.order === null ? null : {
    id: 'ord-1', doctor_id: null, status: 'paid', payment_status: 'paid', paid_at: new Date(),
    specialty_id: 'spec-cardiology', urgency_tier: 'standard', sla_hours: 48, ...(over.order || {}),
  };
  const doctor = over.doctor === null ? null : {
    id: 'doc-1', name: 'Dr X', role: 'doctor', is_active: true, is_paused: false,
    specialty_id: 'spec-cardiology', max_active_cases: 5, max_active_cases_urgent: 8, ...(over.doctor || {}),
  };
  const load = over.load != null ? over.load : 2;
  return (sql) => {
    if (/FOR UPDATE/.test(sql)) return { rows: order ? [order] : [] };
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: doctor ? [doctor] : [] };
    if (/COUNT\(\*\) AS c FROM orders WHERE doctor_id/.test(sql)) return { rows: [{ c: load }] };
    if (/^(UPDATE|INSERT)/i.test(sql)) { if (over.failOn && over.failOn.test(sql)) throw new Error('injected failure'); return { rows: [] }; }
    return { rows: [] };
  };
}

async function assignReq(over, body = { doctorId: 'doc-1' }) {
  const client = txClient(assignHandler(over));
  const app = makeApp({ pool: poolWith(client) });
  try {
    const res = await fetch(`${app.base}/api/v1/admin/cases/ord-1/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(SUPERADMIN)}` },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json().catch(() => null), calls: client.calls };
  } finally { app.server.close(); }
}

test('POST /admin/cases/:id/assign — gate: 401 no token, 403 patient', async () => {
  const app = makeApp({ pool: poolWith(txClient(assignHandler())) });
  try {
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const pt = mintToken({ id: 'p', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pt}` }, body: JSON.stringify({ doctorId: 'doc-1' }) })).status, 403);
  } finally { app.server.close(); }
});

test('POST /assign — happy first-assign: 200, commits, writes orders+assignment+event+audit', async () => {
  const { res, body, calls } = await assignReq({});
  assert.equal(res.status, 200);
  assert.equal(body.data.status, 'assigned');
  assert.equal(body.data.reassigned, false);
  assert.deepEqual(body.data.doctor, { id: 'doc-1', name: 'Dr X' });
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.ok(calls.some((s) => /UPDATE orders SET doctor_id = \$1, status = 'ASSIGNED'/.test(s)));
  assert.ok(calls.some((s) => /INSERT INTO doctor_assignments/.test(s)));
  assert.ok(calls.some((s) => /INSERT INTO order_events/.test(s)));
  assert.ok(calls.some((s) => /INSERT INTO error_logs/.test(s)));
});

test('POST /assign — happy reassign: swap + reassigned_count + close prior window', async () => {
  const { res, body, calls } = await assignReq({ order: { doctor_id: 'doc-old', status: 'in_progress' } });
  assert.equal(res.status, 200);
  assert.equal(body.data.reassigned, true);
  assert.ok(calls.some((s) => /reassigned_count = COALESCE\(reassigned_count,0\) \+ 1/.test(s)));
  assert.ok(calls.some((s) => /UPDATE doctor_assignments SET completed_at/.test(s)));
  assert.ok(calls.includes('COMMIT'));
});

test('POST /assign — rejections roll back with the right codes', async () => {
  assert.equal((await assignReq({ order: { paid_at: null } })).body.code, 'PAYMENT_NOT_CONFIRMED');
  assert.equal((await assignReq({ order: { status: 'completed', completed_at: new Date() } })).body.code, 'NOT_ASSIGNABLE');
  assert.equal((await assignReq({ doctor: { specialty_id: 'spec-derm' } })).body.code, 'SPECIALTY_MISMATCH');
  assert.equal((await assignReq({ doctor: { is_active: false } })).body.code, 'DOCTOR_INACTIVE');
  assert.equal((await assignReq({ load: 5 })).body.code, 'DOCTOR_AT_CAPACITY'); // 5 >= cap 5 (standard)
  assert.equal((await assignReq({ order: { doctor_id: 'doc-1', status: 'assigned' } })).body.code, 'ALREADY_ASSIGNED_TO_DOCTOR');
  const missing = await assignReq({ order: null });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

test('POST /assign — ATOMICITY: failure mid-write rolls back ALL writes (no COMMIT)', async () => {
  const { res, calls } = await assignReq({ failOn: /INSERT INTO order_events/ });
  assert.equal(res.status, 500);
  assert.ok(calls.includes('ROLLBACK'), 'must ROLLBACK on mid-transaction failure');
  assert.ok(!calls.includes('COMMIT'), 'must NOT COMMIT a failed transaction');
  // the orders UPDATE was attempted before the failure — rollback is what undoes it
  assert.ok(calls.some((s) => /UPDATE orders SET doctor_id/.test(s)));
});

test('POST /assign — 400 when doctorId missing', async () => {
  const { res, body } = await assignReq({}, {});
  assert.equal(res.status, 400);
  assert.equal(body.code, 'BAD_REQUEST');
});

// ───────────── integration: post-commit assignment notifications ─────────────
// The 4-write transaction is unchanged and proven above. These prove the
// post-commit step: it fires the right notifications, is idempotent by design,
// and — critically — a notification failure NEVER rolls back the committed
// assignment (it runs after COMMIT, on separate pools).

// Records every post-commit notifier call so tests can assert exact templates,
// channels, dedupe keys, and recipients. Overridable to simulate failures.
function notifierSpy(over = {}) {
  const calls = { convo: [], queue: [], email: [] };
  return {
    calls,
    ensureConversation: over.ensureConversation
      || (async (orderId, patientId, doctorId) => { calls.convo.push({ orderId, patientId, doctorId }); return 'convo-1'; }),
    queueMultiChannelNotification: over.queueMultiChannelNotification
      || (async (opts) => { calls.queue.push(opts); return { ok: true, results: {} }; }),
    notifyCaseAssigned: over.notifyCaseAssigned
      || (async (patient, ref, doctorName, sla) => { calls.email.push({ patient, ref, doctorName, sla }); return { ok: true, messageId: 'm1' }; }),
  };
}

// Like assignReq but injects a notifier spy + a safeGet that answers the
// post-commit patient lookup (orders LEFT JOIN users).
async function assignReqN(over, spy, body = { doctorId: 'doc-1' }) {
  const client = txClient(assignHandler(over));
  const app = makeApp({
    pool: poolWith(client),
    notifiers: spy,
    safeGet: over.safeGet || (async (sql) => (/LEFT JOIN users/.test(sql)
      ? { patient_id: 'pat-1', reference_id: null, patient_email: 'pat@example.com', patient_name: 'Pat' }
      : null)),
    safeRun: async () => ({ rowCount: 1 }),
  });
  try {
    const res = await fetch(`${app.base}/api/v1/admin/cases/ord-1/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(SUPERADMIN)}` },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json().catch(() => null), calls: client.calls, spy };
  } finally { app.server.close(); }
}

test('POST /assign — first-assign: post-commit fires conversation + doctor + patient bell + inline patient email; assignment still committed', async () => {
  const spy = notifierSpy();
  const { res, body, calls } = await assignReqN({}, spy);
  assert.equal(res.status, 200);

  // assignment write is unaffected (committed, all 4 writes present)
  assert.equal(body.data.status, 'assigned');
  assert.equal(body.data.reassigned, false);
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.ok(calls.some((s) => /INSERT INTO doctor_assignments/.test(s)));

  // conversation created for the patient↔doctor pair
  assert.deepEqual(spy.calls.convo[0], { orderId: 'ord-1', patientId: 'pat-1', doctorId: 'doc-1' });

  // doctor: order_assigned_doctor, all three channels, deterministic dedupe key
  const doc = spy.calls.queue.find((q) => q.template === 'order_assigned_doctor');
  assert.ok(doc, 'doctor notification queued');
  assert.deepEqual(doc.channels, ['internal', 'email', 'whatsapp']);
  assert.equal(doc.toUserId, 'doc-1');
  assert.equal(doc.dedupe_key, 'order_assigned:ord-1:doc-1');

  // patient in-app bell: order_assigned_patient, internal only (email/whatsapp unmapped)
  const pat = spy.calls.queue.find((q) => q.template === 'order_assigned_patient');
  assert.ok(pat, 'patient in-app bell queued');
  assert.deepEqual(pat.channels, ['internal']);
  assert.equal(pat.toUserId, 'pat-1');

  // canonical inline patient email fired exactly once to the patient address
  assert.equal(spy.calls.email.length, 1);
  assert.equal(spy.calls.email[0].patient.email, 'pat@example.com');

  // honest per-target flags
  assert.deepEqual(body.data.notifications, {
    conversation: 'ok', doctor: 'queued', patient: 'queued', patientEmail: 'sent',
  });
});

test('POST /assign — reassign: notifies new doctor + previous doctor + patient (no inline email); conversation for new pair', async () => {
  const spy = notifierSpy();
  const { res, body } = await assignReqN({ order: { doctor_id: 'doc-old', status: 'in_progress' } }, spy);
  assert.equal(res.status, 200);
  assert.equal(body.data.reassigned, true);

  const tmpls = spy.calls.queue.map((q) => q.template).sort();
  assert.deepEqual(tmpls, ['order_reassigned_doctor', 'order_reassigned_from_doctor', 'order_reassigned_patient']);

  const newDoc = spy.calls.queue.find((q) => q.template === 'order_reassigned_doctor');
  assert.equal(newDoc.toUserId, 'doc-1');
  assert.deepEqual(newDoc.channels, ['internal', 'email', 'whatsapp']);

  const prevDoc = spy.calls.queue.find((q) => q.template === 'order_reassigned_from_doctor');
  assert.equal(prevDoc.toUserId, 'doc-old');
  assert.deepEqual(prevDoc.channels, ['internal', 'email']); // no whatsapp template mapped

  const pat = spy.calls.queue.find((q) => q.template === 'order_reassigned_patient');
  assert.deepEqual(pat.channels, ['internal', 'whatsapp']); // email unmapped for this template

  assert.equal(spy.calls.email.length, 0, 'no inline patient email on reassign');
  assert.equal(body.data.notifications.previousDoctor, 'queued');
  assert.equal(body.data.notifications.patientEmail, undefined);
  // conversation for the NEW pair
  assert.deepEqual(spy.calls.convo[0], { orderId: 'ord-1', patientId: 'pat-1', doctorId: 'doc-1' });
});

test('POST /assign — a notification failure does NOT roll back the committed assignment (200, COMMIT, no ROLLBACK, flags=failed)', async () => {
  const spy = notifierSpy({
    ensureConversation: async () => { throw new Error('convo down'); },
    queueMultiChannelNotification: async () => { throw new Error('notify down'); },
    notifyCaseAssigned: async () => { throw new Error('smtp down'); },
  });
  const { res, body, calls } = await assignReqN({}, spy);

  assert.equal(res.status, 200, 'assignment still succeeds despite notification failures');
  assert.equal(body.data.status, 'assigned');
  assert.ok(calls.includes('COMMIT'), 'assignment was committed');
  assert.ok(!calls.includes('ROLLBACK'), 'a notification failure must NOT roll back the assignment');

  assert.equal(body.data.notifications.conversation, 'failed');
  assert.equal(body.data.notifications.doctor, 'failed');
  assert.equal(body.data.notifications.patient, 'failed');
  assert.equal(body.data.notifications.patientEmail, 'failed');
});

test('POST /assign — a queue helper returning {ok:false} surfaces as failed without throwing', async () => {
  const spy = notifierSpy({ queueMultiChannelNotification: async () => ({ ok: false, skipped: true }) });
  const { res, body } = await assignReqN({}, spy);
  assert.equal(res.status, 200);
  assert.equal(body.data.notifications.doctor, 'failed');
  assert.equal(body.data.notifications.patient, 'failed');
  // conversation + inline email use different helpers, so they still succeed
  assert.equal(body.data.notifications.conversation, 'ok');
  assert.equal(body.data.notifications.patientEmail, 'sent');
});

// ───────────── integration: SLA override (POST /cases/:id/sla-override) ─────────────
// Mirrors the assign write: atomic BEGIN…FOR UPDATE…COMMIT, validations re-checked
// in-txn, order_events + admin_audit on the txn client. Extend-only +N hours,
// clobber-proof (sla_hours += N AND deadline_at += N h), future-guard in the UPDATE WHERE.

function slaHandler(over = {}) {
  const order = over.order === null ? null : {
    id: 'ord-1', status: 'in_review',
    accepted_at: '2026-06-15T00:00:00.000Z',
    deadline_at: '2026-06-17T00:00:00.000Z',
    sla_hours: 48, sla_paused_at: null, breached_at: null,
    ...(over.order || {}),
  };
  return (sql) => {
    if (/FOR UPDATE/.test(sql)) return { rows: order ? [order] : [] };
    if (/^UPDATE orders/i.test(sql)) {
      if (over.failOn && over.failOn.test(sql)) throw new Error('injected failure');
      // deadlineInPast simulates the future-guard WHERE matching 0 rows.
      if (over.deadlineInPast) return { rows: [], rowCount: 0 };
      return { rows: [{ deadline_at: '2026-06-17T06:00:00.000Z', sla_hours: (order ? order.sla_hours : 48) + 6 }], rowCount: 1 };
    }
    if (/^INSERT/i.test(sql)) {
      if (over.failOn && over.failOn.test(sql)) throw new Error('injected failure');
      return { rows: [] };
    }
    return { rows: [] };
  };
}

async function slaReq(over, body = { extendHours: 6, reason: 'patient uploaded missing files late' }) {
  const client = txClient(slaHandler(over));
  const app = makeApp({ pool: poolWith(client) });
  try {
    const res = await fetch(`${app.base}/api/v1/admin/cases/ord-1/sla-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(SUPERADMIN)}` },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json().catch(() => null), calls: client.calls };
  } finally { app.server.close(); }
}

test('POST /sla-override — gate: 401 no token, 403 patient', async () => {
  const app = makeApp({ pool: poolWith(txClient(slaHandler())) });
  try {
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/sla-override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const pt = mintToken({ id: 'p', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/sla-override`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pt}` }, body: JSON.stringify({ extendHours: 6, reason: 'x' }) })).status, 403);
  } finally { app.server.close(); }
});

test('POST /sla-override — happy: +6h on a running clock commits the deadline+sla_hours bump, clears breach markers, writes both audit rows', async () => {
  const { res, body, calls } = await slaReq({});
  assert.equal(res.status, 200);
  assert.equal(body.data.id, 'ord-1');
  assert.equal(body.data.extendedHours, 6);
  assert.equal(body.data.previousDeadlineAt, '2026-06-17T00:00:00.000Z');
  assert.equal(body.data.sla.deadlineAt, '2026-06-17T06:00:00.000Z');
  assert.equal(body.data.sla.slaHours, 54);
  assert.equal(body.data.sla.breached, false);
  assert.equal(body.data.sla.hasTimer, true);
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.ok(calls.some((s) => /UPDATE orders SET sla_hours = COALESCE\(sla_hours, 0\) \+ \$2::int/.test(s)), 'bumps sla_hours by N');
  assert.ok(calls.some((s) => /deadline_at = deadline_at \+ make_interval\(hours => \$2::int\)/.test(s)), 'bumps deadline_at by N h');
  assert.ok(calls.some((s) => /breached_at = NULL/.test(s)), 'clears breach marker');
  assert.ok(calls.some((s) => /INSERT INTO order_events/.test(s)), 'order_events audit on txn client');
  assert.ok(calls.some((s) => /INSERT INTO error_logs/.test(s)), 'admin_audit on txn client');
});

test('POST /sla-override — breach-rescue: a breached case extended past now un-breaches (sla_breach→IN_REVIEW) and commits', async () => {
  const { res, body, calls } = await slaReq(
    { order: { status: 'sla_breach', deadline_at: '2026-06-16T00:00:00.000Z', breached_at: '2026-06-16T00:00:01.000Z' } },
    { extendHours: 48, reason: 'doctor reassigned after breach — granting time' }
  );
  assert.equal(res.status, 200);
  assert.equal(body.data.sla.breached, false);
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.ok(calls.some((s) => /IN \('sla_breach', 'breached'\)/.test(s) && /THEN 'IN_REVIEW'/.test(s)), 'reverts sla_breach status to IN_REVIEW');
  assert.ok(calls.some((s) => /breached_at = NULL/.test(s)), 'clears breached_at');
});

test('POST /sla-override — input rejections → 400 BAD_REQUEST, before any txn is opened', async () => {
  assert.equal((await slaReq({}, { extendHours: 0, reason: 'x' })).body.code, 'BAD_REQUEST');
  assert.equal((await slaReq({}, { extendHours: -5, reason: 'x' })).body.code, 'BAD_REQUEST');
  assert.equal((await slaReq({}, { extendHours: 200, reason: 'x' })).body.code, 'BAD_REQUEST'); // > 168h cap
  assert.equal((await slaReq({}, { extendHours: 6.5, reason: 'x' })).body.code, 'BAD_REQUEST'); // non-integer
  assert.equal((await slaReq({}, { reason: 'x' })).body.code, 'BAD_REQUEST'); // missing extendHours
  assert.equal((await slaReq({}, { extendHours: 6 })).body.code, 'BAD_REQUEST'); // missing reason
  assert.equal((await slaReq({}, { extendHours: 6, reason: '   ' })).body.code, 'BAD_REQUEST'); // blank reason
  const r = await slaReq({}, { extendHours: 0, reason: 'x' });
  assert.ok(!r.calls.includes('BEGIN'), 'input validation rejects before opening a transaction');
});

test('POST /sla-override — state rejections roll back with the right codes', async () => {
  const notFound = await slaReq({ order: null });
  assert.equal(notFound.res.status, 404);
  assert.equal(notFound.body.code, 'NOT_FOUND');
  assert.equal((await slaReq({ order: { status: 'completed' } })).body.code, 'NOT_OVERRIDABLE');
  assert.equal((await slaReq({ order: { status: 'expired_unpaid' } })).body.code, 'NOT_OVERRIDABLE');
  assert.equal((await slaReq({ order: { accepted_at: null } })).body.code, 'SLA_NOT_STARTED'); // unaccepted → no clock
  assert.equal((await slaReq({ order: { deadline_at: null } })).body.code, 'SLA_NOT_STARTED'); // no deadline
  assert.equal((await slaReq({ order: { sla_paused_at: '2026-06-16T00:00:00.000Z' } })).body.code, 'SLA_PAUSED');
  assert.equal((await slaReq({ deadlineInPast: true })).body.code, 'DEADLINE_IN_PAST'); // future-guard WHERE matched 0 rows
  // a state rejection still rolls the (empty) txn back, never commits
  const paused = await slaReq({ order: { sla_paused_at: '2026-06-16T00:00:00.000Z' } });
  assert.ok(paused.calls.includes('ROLLBACK'));
  assert.ok(!paused.calls.includes('COMMIT'));
});

test('POST /sla-override — ATOMICITY: failure at the order_events insert rolls back ALL writes (no COMMIT)', async () => {
  const { res, calls } = await slaReq({ failOn: /INSERT INTO order_events/ });
  assert.equal(res.status, 500);
  assert.ok(calls.includes('ROLLBACK'), 'must ROLLBACK on mid-transaction failure');
  assert.ok(!calls.includes('COMMIT'), 'must NOT COMMIT a failed transaction');
  assert.ok(calls.some((s) => /UPDATE orders SET sla_hours/.test(s)), 'the orders UPDATE was attempted before the failure');
});

// ─────────────────────────── POST /cases/:id/refund ───────────────────────────
// Money-path write. The full happy/partial/rejection/atomicity behaviour is
// proven against a REAL Postgres in tests/admin/admin_refund.test.js; these
// mock-route tests cover the gate, route-level input validation (before any
// txn), the success shape, code mapping, and ROLLBACK-on-fault at the HTTP layer.
function refundHandler(over = {}) {
  const order = over.order === null ? null : {
    id: 'ord-1', patient_id: 'pat-1', payment_status: 'paid',
    base_price: 500, urgency_uplift_amount: 100, ...(over.order || {}),
  };
  return (sql) => {
    if (/FOR UPDATE/.test(sql)) return { rows: order ? [order] : [] };
    if (/FROM refunds WHERE order_id/.test(sql)) return { rows: over.existingRefund ? [{ id: 'rf-existing' }] : [] };
    if (/INSERT INTO refunds/.test(sql)) {
      if (over.failOn && over.failOn.test(sql)) throw new Error('injected failure');
      return { rows: [{ refunded_at: new Date('2026-06-20T10:00:00Z') }] };
    }
    if (/^INSERT/i.test(sql)) {
      if (over.failOn && over.failOn.test(sql)) throw new Error('injected failure');
      return { rows: [] };
    }
    return { rows: [] };
  };
}

async function refundReq(over = {}, body = { amount: 600, instapayHandle: '@patient.handle' }) {
  const client = txClient(refundHandler(over));
  const app = makeApp({ pool: poolWith(client) });
  try {
    const res = await fetch(`${app.base}/api/v1/admin/cases/ord-1/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(SUPERADMIN)}` },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json().catch(() => null), calls: client.calls };
  } finally { app.server.close(); }
}

test('POST /cases/:id/refund — gate: 401 no token, 403 patient', async () => {
  const app = makeApp({ pool: poolWith(txClient(refundHandler())) });
  try {
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const pt = mintToken({ id: 'p', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await fetch(`${app.base}/api/v1/admin/cases/ord-1/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pt}` }, body: JSON.stringify({ amount: 600, instapayHandle: '@p.handle' }) })).status, 403);
  } finally { app.server.close(); }
});

test('POST /refund — happy: 200, COMMIT, writes refunds+event+audit, pending shape', async () => {
  const { res, body, calls } = await refundReq();
  assert.equal(res.status, 200);
  assert.equal(body.data.refund.status, 'pending');
  assert.equal(body.data.refund.amountEgp, 600);
  assert.equal(body.data.refund.reason, 'operator_refund');
  assert.equal(body.data.refund.instapayHandle, '@patient.handle');
  assert.ok(body.data.refund.id && body.data.refund.createdAt);
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
  assert.ok(calls.some((s) => /INSERT INTO refunds/.test(s)));
  assert.ok(calls.some((s) => /INSERT INTO order_events/.test(s)));
  assert.ok(calls.some((s) => /INSERT INTO error_logs/.test(s)));
});

test('POST /refund — input validation rejects with 400 BEFORE opening a transaction', async () => {
  for (const body of [{ instapayHandle: '@p.handle' }, { amount: 0, instapayHandle: '@p.handle' }, { amount: -5, instapayHandle: '@p.handle' }, { amount: 600, instapayHandle: 'ab' }, { amount: 600 }]) {
    const { res, body: rb, calls } = await refundReq({}, body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(rb.code, 'BAD_REQUEST');
    assert.ok(!calls.includes('BEGIN'), 'must not open a txn on invalid input');
  }
});

test('POST /refund — rejections roll back with the right codes', async () => {
  assert.equal((await refundReq({ order: null })).body.code, 'ORDER_NOT_FOUND');
  assert.equal((await refundReq({ order: { payment_status: 'unpaid' } })).body.code, 'ORDER_NOT_PAID');
  assert.equal((await refundReq({ existingRefund: true })).body.code, 'REFUND_ALREADY_EXISTS');
  assert.equal((await refundReq({}, { amount: 700, instapayHandle: '@p.handle' })).body.code, 'AMOUNT_EXCEEDS_MAX');
  const rolledBack = await refundReq({ order: { payment_status: 'unpaid' } });
  assert.ok(rolledBack.calls.includes('ROLLBACK'));
});

test('POST /refund — ATOMICITY: a fault at the admin-audit insert rolls back (no COMMIT)', async () => {
  const { res, calls } = await refundReq({ failOn: /INSERT INTO error_logs/ });
  assert.equal(res.status, 500);
  assert.ok(calls.includes('ROLLBACK'), 'must ROLLBACK on mid-transaction failure');
  assert.ok(!calls.includes('COMMIT'), 'must NOT COMMIT a failed transaction');
  assert.ok(calls.some((s) => /INSERT INTO refunds/.test(s)), 'the refunds INSERT was attempted before the failure');
});
