'use strict';

// Tashkheesa Command admin API — Phase B: tappable-KPI drill-down backend.
// Covers: GET /cases new filters (active, timer=none, tightened unassigned via
// composition) + price fields; GET /revenue (happy/empty/bad-scope/gate); GET
// /refunds new refundedMtd bucket + collected KPI coalesced date.
// Hermetic: router built via its factory with stubbed helpers; stubs capture the
// SQL so we can assert the WHERE clauses match each KPI's exact definition.
//   node --test tests/admin/admin_kpi_drilldowns.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-kpi';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = { id: 'su-1', email: 'ziad.wahsh@shifaegypt.com', role: 'superadmin', name: 'Ziad' };
const PATIENT = { id: 'p-1', email: 'p@x.com', role: 'patient', name: 'Pat' };
const ACTIVE_SQL = "LOWER(o.status) IN ('paid','in_progress','submitted','assigned')";

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function makeApp(stubs = {}) {
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async () => ({ rowCount: 0 })),
  };
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const deploy = { gitSha: 'abc1234', startedAt: 1718352000000, startedAtIso: '2026-06-14T07:00:00.000Z', version: '1.0.0', mode: 'test' };
  const notifiers = {
    ensureConversation: async () => 'c', queueMultiChannelNotification: async () => ({ ok: true, results: {} }), notifyCaseAssigned: async () => ({ ok: true }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function get(base, path, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/v1/admin${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// Complete fake /cases row (snake_case, as pg returns) — total_price_with_addons set.
const CASE_ROW = {
  id: 'ord-1', reference_id: 'TSH-1', status: 'paid', urgency_tier: 'standard', payment_status: 'paid',
  doctor_id: null, created_at: new Date('2026-06-01T00:00:00.000Z'), deadline_at: null, completed_at: null,
  base_price: 1000, price: 1200, total_price_with_addons: 1350,
  patient: 'Mona', gender: 'female', date_of_birth: '1990-01-01', specialty: 'Cardiology',
  service: 'Second opinion', doctor_name: null, sla_mins: null,
};

// /cases stubs: capture every safeAll SQL; rows query (has sla_mins) → [CASE_ROW],
// facets → []; safeGet (total) → {total:1}.
function casesStubs(capture) {
  return {
    safeAll: async (sql, params) => {
      capture.push({ sql, params });
      return /sla_mins/.test(sql) ? [CASE_ROW] : [];
    },
    safeGet: async () => ({ total: 1 }),
  };
}
const rowsSql = (cap) => (cap.find((c) => /sla_mins/.test(c.sql)) || {}).sql || '';

// ─────────────────────────── GET /cases — filters + price ───────────────────────────

test('GET /cases?active=1 — adds ACTIVE_STATUSES+not-completed; maps price fields', async () => {
  const cap = [];
  const { server, base } = makeApp(casesStubs(cap));
  try {
    const { res, body } = await get(base, '/cases?active=1', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.ok(rowsSql(cap).includes(`o.completed_at IS NULL AND ${ACTIVE_SQL}`), 'active constraint in WHERE');
    const c = body.data.cases[0];
    assert.equal(c.basePrice, 1000);
    assert.equal(c.price, 1200);
    assert.equal(c.grandTotal, 1350); // COALESCE(total_price_with_addons, price)
  } finally {
    server.close();
  }
});

test('GET /cases — grandTotal falls back to price when no add-ons', async () => {
  const cap = [];
  const { server, base } = makeApp({
    safeAll: async (sql) => (/sla_mins/.test(sql) ? [{ ...CASE_ROW, total_price_with_addons: null, price: 800 }] : []),
    safeGet: async () => ({ total: 1 }),
  });
  try {
    const { body } = await get(base, '/cases', mintToken(SUPERADMIN));
    assert.equal(body.data.cases[0].grandTotal, 800);
  } finally {
    server.close();
  }
});

test('GET /cases?timer=none — adds deadline_at IS NULL + active + not-completed', async () => {
  const cap = [];
  const { server, base } = makeApp(casesStubs(cap));
  try {
    const { res } = await get(base, '/cases?timer=none', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.ok(
      rowsSql(cap).includes(`o.completed_at IS NULL AND o.deadline_at IS NULL AND ${ACTIVE_SQL}`),
      'no-timer constraint in WHERE'
    );
  } finally {
    server.close();
  }
});

test('GET /cases?assigned=unassigned&active=1 — composes to the exact pulse Pending-assign def', async () => {
  const cap = [];
  const { server, base } = makeApp(casesStubs(cap));
  try {
    const { res } = await get(base, '/cases?assigned=unassigned&active=1', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    const sql = rowsSql(cap);
    assert.ok(sql.includes('o.doctor_id IS NULL'), 'unassigned still applied');
    assert.ok(sql.includes(`o.completed_at IS NULL AND ${ACTIVE_SQL}`), 'active constraint ANDed in');
  } finally {
    server.close();
  }
});

test('GET /cases?assigned=unassigned (alone) stays loose — Cases screen unchanged', async () => {
  const cap = [];
  const { server, base } = makeApp(casesStubs(cap));
  try {
    await get(base, '/cases?assigned=unassigned', mintToken(SUPERADMIN));
    const sql = rowsSql(cap);
    assert.ok(sql.includes('o.doctor_id IS NULL'), 'doctor_id IS NULL present');
    assert.ok(!sql.includes(ACTIVE_SQL), 'no active constraint when active flag absent (loose, as before)');
  } finally {
    server.close();
  }
});

// ─────────────────────────── GET /revenue ───────────────────────────

const REV_ROW = {
  id: 'ord-1', reference_id: 'TSH-1', patient: 'Mona', service: 'Second opinion',
  base_price: 1000, price: 1200, total_price_with_addons: 1350, currency: 'EGP', payment_method: 'card',
  collected_at: new Date('2026-06-15T10:00:00.000Z'),
};
const REV_ROW2 = {
  id: 'ord-2', reference_id: null, patient: '—', service: 'Second opinion',
  base_price: 800, price: 800, total_price_with_addons: null, currency: 'EGP', payment_method: 'instapay',
  collected_at: new Date('2026-06-10T10:00:00.000Z'),
};

test('GET /revenue?scope=today — maps rows, coalesced-date param, total = SUM(grandTotal)', async () => {
  const cap = [];
  const { server, base } = makeApp({
    safeAll: async (sql, params) => { cap.push({ sql, params }); return [REV_ROW, REV_ROW2]; },
  });
  try {
    const { res, body } = await get(base, '/revenue?scope=today', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.data.scope, 'today');
    assert.equal(cap[0].params[0], 'day', "scope=today → date_trunc unit 'day'");
    assert.ok(cap[0].sql.includes('COALESCE(o.paid_at, o.created_at) >= date_trunc($1, NOW())'), 'coalesced collected-date filter');
    assert.equal(body.data.orders.length, 2);
    const o = body.data.orders[0];
    assert.equal(o.orderReference, 'TSH-1');
    assert.equal(o.basePrice, 1000);
    assert.equal(o.price, 1200);
    assert.equal(o.grandTotal, 1350);
    assert.equal(o.collectedAt, '2026-06-15T10:00:00.000Z');
    assert.equal(body.data.orders[1].grandTotal, 800); // total_price_with_addons null → price
    assert.deepEqual(body.data.total, { count: 2, amount: 2150 }); // 1350 + 800
  } finally {
    server.close();
  }
});

test('GET /revenue?scope=mtd — empty → orders [], total zeroed, unit month', async () => {
  const cap = [];
  const { server, base } = makeApp({ safeAll: async (sql, params) => { cap.push({ sql, params }); return []; } });
  try {
    const { res, body } = await get(base, '/revenue?scope=mtd', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(cap[0].params[0], 'month');
    assert.deepEqual(body.data.orders, []);
    assert.deepEqual(body.data.total, { count: 0, amount: 0 });
  } finally {
    server.close();
  }
});

test('GET /revenue?scope=bogus → 400 BAD_REQUEST', async () => {
  const { server, base } = makeApp({ safeAll: async () => [REV_ROW] });
  try {
    const { res, body } = await get(base, '/revenue?scope=bogus', mintToken(SUPERADMIN));
    assert.equal(res.status, 400);
    assert.equal(body.code, 'BAD_REQUEST');
  } finally {
    server.close();
  }
});

test('GET /revenue (no scope) → 400 BAD_REQUEST', async () => {
  const { server, base } = makeApp({ safeAll: async () => [] });
  try {
    const { res, body } = await get(base, '/revenue', mintToken(SUPERADMIN));
    assert.equal(res.status, 400);
    assert.equal(body.code, 'BAD_REQUEST');
  } finally {
    server.close();
  }
});

test('GET /revenue — no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp({ safeAll: async () => [] });
  try {
    const { res, body } = await get(base, '/revenue?scope=today', null);
    assert.equal(res.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally {
    server.close();
  }
});

test('GET /revenue — patient role → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp({ safeAll: async () => [] });
  try {
    const { res, body } = await get(base, '/revenue?scope=today', mintToken(PATIENT));
    assert.equal(res.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});

// ─────────────────────────── GET /refunds — new bucket + coalesced collected ───────────────────────────

const REFUND_ROW = {
  id: 'rf-1', order_id: 'ord-1', amount_egp: '300.00', requested_amount: '300.00', approved_amount: '300.00',
  status: 'paid', reason: 'operator_refund', instapay_handle: '@x', instapay_reference: 'IP-1',
  refunded_at: new Date('2026-06-12T08:00:00.000Z'), reviewed_at: new Date('2026-06-12T09:00:00.000Z'),
  paid_at: new Date('2026-06-13T09:00:00.000Z'),
  patient_name: 'Mona', reference_id: 'TSH-1', service_id: 'svc', price: 1200, currency: 'EGP',
};

test('GET /refunds — adds queue.refundedMtd (committed, this month); collected KPI uses coalesced date', async () => {
  const cap = [];
  const { server, base } = makeApp({
    safeAll: async (sql) => {
      if (/r\.status = 'pending'/.test(sql)) return [];
      // refundedMtd is the only bucket with the 3-status set AND date_trunc('month')
      if (/'paid','approved','auto_approved'/.test(sql)) return [REFUND_ROW];
      if (/'approved','auto_approved'/.test(sql)) return []; // awaitingPayment
      if (/'paid','denied'/.test(sql)) return []; // recent
      return [];
    },
    safeGet: async (sql) => {
      cap.push(sql);
      if (/collected_today/.test(sql)) return { collected_today: 0, collected_mtd: 0 };
      if (/refunded_mtd/.test(sql)) return { refunded_mtd: '300', owed_count: '0', owed_total: '0' };
      return null;
    },
  });
  try {
    const { res, body } = await get(base, '/refunds', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    // new bucket present and populated
    assert.ok(Array.isArray(body.data.queue.refundedMtd), 'refundedMtd bucket exists');
    assert.equal(body.data.queue.refundedMtd.length, 1);
    assert.equal(body.data.queue.refundedMtd[0].id, 'rf-1');
    // existing buckets still present
    assert.ok(Array.isArray(body.data.queue.pending));
    assert.ok(Array.isArray(body.data.queue.awaitingPayment));
    assert.ok(Array.isArray(body.data.queue.recent));
    // collected KPI now buckets by COALESCE(paid_at, created_at)
    const collectedSql = cap.find((s) => /collected_today/.test(s)) || '';
    assert.ok(collectedSql.includes("COALESCE(paid_at, created_at) >= date_trunc('day'"), 'collectedToday coalesced date');
    assert.ok(collectedSql.includes("COALESCE(paid_at, created_at) >= date_trunc('month'"), 'collectedMTD coalesced date');
  } finally {
    server.close();
  }
});
