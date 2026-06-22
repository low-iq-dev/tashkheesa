'use strict';

// Tashkheesa Command admin API — GET /api/v1/admin/refunds (read-only queue + KPIs).
// Hermetic: the router is built via its (db, helpers, deploy, deps) factory with
// stubbed helpers (no real DB). safeAll/safeGet branch on the SQL text to return
// the right bucket / aggregate, shaped as node-postgres returns it (numeric →
// string, COUNT → string, float8 → number, timestamps → Date). Run with:
//   node --test tests/admin/admin_refunds.test.js
//
// JWT_SECRET + SUPERADMIN_EMAIL must be set BEFORE requiring the app modules —
// src/middleware/requireJWT.js captures JWT_SECRET at module-load time.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-refunds';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = {
  id: 'd1d04fb8-cc53-4928-b412-60f763546d09',
  email: 'ziad.wahsh@shifaegypt.com',
  role: 'superadmin',
  name: 'Ziad El Wahsh',
};
const PATIENT = { id: 'p-1', email: 'patient@example.com', role: 'patient', name: 'A Patient' };

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

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

async function getRefunds(base, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/v1/admin/refunds`, { headers });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// Fake rows as node-postgres returns them (numeric → string, float8 → number,
// timestamps → Date). One refund per bucket.
const PENDING_ROW = {
  id: 'rf-1', order_id: 'ord-1', amount_egp: '500.00', requested_amount: '500.00', approved_amount: null,
  status: 'pending', reason: 'operator_refund', instapay_handle: '@mona', instapay_reference: null,
  refunded_at: new Date('2026-06-20T08:00:00.000Z'), reviewed_at: null, paid_at: null,
  patient_name: 'Mona Ali', reference_id: 'TSH-1001', service_id: 'svc-cardio', price: 500, currency: 'EGP',
};
const APPROVED_ROW = {
  id: 'rf-2', order_id: 'ord-2', amount_egp: '300.00', requested_amount: '300.00', approved_amount: '300.00',
  status: 'approved', reason: 'patient_request', instapay_handle: '@sara', instapay_reference: null,
  refunded_at: new Date('2026-06-19T08:00:00.000Z'), reviewed_at: new Date('2026-06-19T10:00:00.000Z'), paid_at: null,
  patient_name: 'Sara Adel', reference_id: 'TSH-1002', service_id: 'svc-neuro', price: 300, currency: 'EGP',
};
const PAID_ROW = {
  id: 'rf-3', order_id: 'ord-3', amount_egp: '450.00', requested_amount: '450.00', approved_amount: '450.00',
  status: 'paid', reason: 'operator_refund', instapay_handle: '@omar', instapay_reference: 'IP-9988',
  refunded_at: new Date('2026-06-10T08:00:00.000Z'), reviewed_at: new Date('2026-06-10T09:00:00.000Z'),
  paid_at: new Date('2026-06-11T09:00:00.000Z'),
  patient_name: 'Omar Nabil', reference_id: 'TSH-1003', service_id: 'svc-cardio', price: 450, currency: 'EGP',
};

function fullStubs() {
  return {
    safeAll: async (sql) => {
      if (/r\.status = 'pending'/.test(sql)) return [PENDING_ROW];
      if (/'approved','auto_approved'/.test(sql)) return [APPROVED_ROW];
      if (/'paid','denied'/.test(sql)) return [PAID_ROW];
      return [];
    },
    safeGet: async (sql) => {
      if (/collected_today/.test(sql)) return { collected_today: 1000, collected_mtd: 5000 };
      if (/refunded_mtd/.test(sql)) return { refunded_mtd: '750.00', owed_count: '2', owed_total: '800.00' };
      return null;
    },
  };
}

// ─────────────────────────── 1. happy path ───────────────────────────

test('GET /refunds: happy path — buckets, mapping, kpis, counts', async () => {
  const { server, base } = makeApp(fullStubs());
  try {
    const { res, body } = await getRefunds(base, mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.success, true);

    const { queue, kpis, counts } = body.data;
    // three buckets present
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.awaitingPayment.length, 1);
    assert.equal(queue.recent.length, 1);

    // camelCase mapping + patient via order
    const p = queue.pending[0];
    assert.equal(p.id, 'rf-1');
    assert.equal(p.orderId, 'ord-1');
    assert.equal(p.patientName, 'Mona Ali');
    assert.equal(p.orderReference, 'TSH-1001');
    assert.equal(p.serviceId, 'svc-cardio');
    assert.equal(p.price, 500);
    assert.equal(p.currency, 'EGP');
    assert.equal(p.amountEgp, 500);
    assert.equal(p.requestedAmount, 500);
    assert.equal(p.approvedAmount, null);
    assert.equal(p.status, 'pending');
    assert.equal(p.reason, 'operator_refund');
    assert.equal(p.instapayHandle, '@mona');
    assert.equal(p.instapayReference, null);
    assert.equal(p.refundedAt, '2026-06-20T08:00:00.000Z'); // toIso
    assert.equal(p.reviewedAt, null);
    assert.equal(p.paidAt, null);

    // approved bucket carries approvedAmount + reviewedAt
    assert.equal(queue.awaitingPayment[0].approvedAmount, 300);
    assert.equal(queue.awaitingPayment[0].reviewedAt, '2026-06-19T10:00:00.000Z');
    // paid bucket carries paidAt + instapayReference
    assert.equal(queue.recent[0].paidAt, '2026-06-11T09:00:00.000Z');
    assert.equal(queue.recent[0].instapayReference, 'IP-9988');

    // kpis shape — collected, committed refunded MTD, and SEPARATE owed obligation
    assert.equal(kpis.collectedToday, 1000);
    assert.equal(kpis.collectedMTD, 5000);
    assert.equal(kpis.refundedMTD, 750);
    assert.deepEqual(kpis.refundsOwed, { count: 2, total: 800 });

    // counts for the tab badge (pending + awaiting only)
    assert.deepEqual(counts, { pending: 1, awaitingPayment: 1 });
  } finally {
    server.close();
  }
});

// ─────────────────────────── 2. empty ───────────────────────────

test('GET /refunds: empty — buckets [], kpis zeroed, counts zero', async () => {
  const { server, base } = makeApp({
    safeAll: async () => [],
    safeGet: async () => ({}), // aggregates absent → coerced to 0
  });
  try {
    const { res, body } = await getRefunds(base, mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.queue, { pending: [], awaitingPayment: [], recent: [] });
    assert.deepEqual(body.data.kpis, {
      collectedToday: 0,
      collectedMTD: 0,
      refundedMTD: 0,
      refundsOwed: { count: 0, total: 0 },
    });
    assert.deepEqual(body.data.counts, { pending: 0, awaitingPayment: 0 });
  } finally {
    server.close();
  }
});

// ─────────────────────────── 3. no token → 401 ───────────────────────────

test('GET /refunds: no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp(fullStubs());
  try {
    const { res, body } = await getRefunds(base, null);
    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally {
    server.close();
  }
});

// ─────────────────────────── 4. patient role → 403 ───────────────────────────

test('GET /refunds: patient-role token → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp(fullStubs());
  try {
    const { res, body } = await getRefunds(base, mintToken(PATIENT));
    assert.equal(res.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});
