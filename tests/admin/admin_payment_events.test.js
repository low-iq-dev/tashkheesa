'use strict';

// Tashkheesa Command admin API — amount-mismatch triage (Batch 1):
//   GET  /api/v1/admin/payment-events?type=amount_mismatch   (read queue)
//   POST /api/v1/admin/payment-events/:id/review             (mark reviewed)
//
// Hermetic route suite (mirrors admin_refunds.test.js). The GET path stubs
// safeAll (branch on SQL text). The POST path stubs db.connect() to a fake pg
// client so the REAL reviewPaymentEvent slice runs against it end-to-end —
// exercising the route → slice → res.ok envelope without a real DB. Deep upsert
// idempotency is proven separately against real Postgres in
// payment_event_review.test.js.
//
// JWT_SECRET + SUPERADMIN_EMAIL must be set BEFORE requiring the app modules.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-payment-events';
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
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async () => ({ rowCount: 0 })),
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
  // pool carries connect() for the write path; the fake client branches on SQL.
  const pool = stubs.pool || {
    totalCount: 1, idleCount: 1, waitingCount: 0,
    connect: stubs.connect || (async () => ({ query: async () => ({ rows: [] }), release() {} })),
  };
  const deploy = { gitSha: 'abc1234', startedAt: 1718352000000, startedAtIso: '2026-06-14T07:00:00.000Z', version: '1.0.0', mode: 'test' };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, {}));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, path, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const parsed = await res.json().catch(() => null);
  return { res, body: parsed };
}

// A mismatch row exactly as node-postgres returns the GET join (jsonb → object,
// timestamps → Date). owed/paid/currency/txn live inside payload_json.
const MISMATCH_ROW = {
  id: 'pe-1', order_id: 'ord-1', received_at: new Date('2026-07-01T10:00:00.000Z'),
  payload_json: { owed_cents: 50000, paid_cents: 45000, currency: 'EGP', paymob_transaction_id: 'txn-1' },
  reference_id: 'TSH-2001', payment_status: 'unpaid', order_deleted: false,
  patient_name: 'Mona Ali', patient_phone: '+201234567890', patient_email: 'mona@example.com',
  reviewed_by: null, review_reviewed_at: null, review_note: null,
};
const REVIEWED_ROW = {
  ...MISMATCH_ROW, id: 'pe-2', order_id: 'ord-2', reference_id: 'TSH-2002',
  payload_json: { owed_cents: 30000, paid_cents: 30000, currency: 'EGP', paymob_transaction_id: 'txn-2' },
  reviewed_by: 'sa-1', review_reviewed_at: new Date('2026-07-02T09:00:00.000Z'), review_note: 'reconciled',
};

const eventsStub = (rows) => ({ safeAll: async (sql) => (/FROM payment_events pe/.test(sql) ? rows : []) });

// ─────────────────────────── GET — parse + shape ───────────────────────────

test('GET /payment-events: parses payload_json (owed/paid/currency/txn), patient join, counts', async () => {
  const { server, base } = makeApp(eventsStub([MISMATCH_ROW]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events?type=amount_mismatch', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.success, true);

    const e = body.data.events[0];
    assert.equal(e.id, 'pe-1');
    assert.equal(e.orderId, 'ord-1');
    assert.equal(e.orderReference, 'TSH-2001');
    assert.equal(e.orderPaymentStatus, 'unpaid');
    assert.equal(e.orderDeleted, false);
    assert.equal(e.receivedAt, '2026-07-01T10:00:00.000Z'); // toIso
    assert.equal(e.owedCents, 50000);
    assert.equal(e.paidCents, 45000);
    assert.equal(e.currency, 'EGP');
    assert.equal(e.paymobTransactionId, 'txn-1');
    assert.deepEqual(e.patient, { name: 'Mona Ali', phone: '+201234567890', email: 'mona@example.com' });
    assert.equal(e.reviewed, null);

    assert.deepEqual(body.data.counts, { total: 1, unreviewed: 1 });
  } finally { server.close(); }
});

test('GET /payment-events: a reviewed row exposes reviewed{by,at,note} and drops from unreviewed', async () => {
  const { server, base } = makeApp(eventsStub([MISMATCH_ROW, REVIEWED_ROW]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    const reviewed = body.data.events.find((x) => x.id === 'pe-2');
    assert.deepEqual(reviewed.reviewed, { by: 'sa-1', at: '2026-07-02T09:00:00.000Z', note: 'reconciled' });
    assert.deepEqual(body.data.counts, { total: 2, unreviewed: 1 });
  } finally { server.close(); }
});

test('GET /payment-events: empty → events [], counts zeroed', async () => {
  const { server, base } = makeApp(eventsStub([]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.events, []);
    assert.deepEqual(body.data.counts, { total: 0, unreviewed: 0 });
  } finally { server.close(); }
});

test('GET /payment-events: unsupported type → 400 BAD_REQUEST', async () => {
  const { server, base } = makeApp(eventsStub([MISMATCH_ROW]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events?type=hmac_failure', mintToken(SUPERADMIN));
    assert.equal(res.status, 400);
    assert.equal(body.code, 'BAD_REQUEST');
  } finally { server.close(); }
});

// ─────────────────────────── GET — auth gating ─────────────────────────────

test('GET /payment-events: no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp(eventsStub([MISMATCH_ROW]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events', null);
    assert.equal(res.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally { server.close(); }
});

test('GET /payment-events: patient-role token → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp(eventsStub([MISMATCH_ROW]));
  try {
    const { res, body } = await call(base, 'GET', '/api/v1/admin/payment-events', mintToken(PATIENT));
    assert.equal(res.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  } finally { server.close(); }
});

// ─────────────────────────── POST /review — auth gating ────────────────────

test('POST /payment-events/:id/review: no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', '/api/v1/admin/payment-events/pe-1/review', null, { note: 'x' });
    assert.equal(res.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally { server.close(); }
});

test('POST /payment-events/:id/review: patient-role token → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp();
  try {
    const { res, body } = await call(base, 'POST', '/api/v1/admin/payment-events/pe-1/review', mintToken(PATIENT), { note: 'x' });
    assert.equal(res.status, 403);
    assert.equal(body.code, 'FORBIDDEN');
  } finally { server.close(); }
});

// ─────────────────────── POST /review — route → slice → envelope ────────────

// Fake pg client: BEGIN/COMMIT ok; SELECT finds the event; UPSERT returns the
// row; audits ok. Runs the REAL reviewPaymentEvent slice against it.
function reviewClient({ found = true } = {}) {
  return {
    query: async (sql) => {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return {};
      if (/FROM payment_events WHERE id/.test(sql)) return { rows: found ? [{ id: 'pe-1', order_id: 'ord-1', event_type: 'amount_mismatch' }] : [] };
      if (/INSERT INTO payment_event_reviews/.test(sql)) return { rows: [{ reviewed_by: SUPERADMIN.id, reviewed_at: new Date('2026-07-03T08:00:00.000Z'), note: 'called patient' }] };
      if (/INSERT INTO order_events|INSERT INTO error_logs/.test(sql)) return {};
      return { rows: [] };
    },
    release() {},
  };
}

test('POST /payment-events/:id/review: happy path → 200, review echoed', async () => {
  const { server, base } = makeApp({ connect: async () => reviewClient({ found: true }) });
  try {
    const { res, body } = await call(base, 'POST', '/api/v1/admin/payment-events/pe-1/review', mintToken(SUPERADMIN), { note: 'called patient' });
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.review.paymentEventId, 'pe-1');
    assert.equal(body.data.review.reviewedBy, SUPERADMIN.id);
    assert.equal(body.data.review.reviewedAt, '2026-07-03T08:00:00.000Z');
    assert.equal(body.data.review.note, 'called patient');
  } finally { server.close(); }
});

test('POST /payment-events/:id/review: unknown event → 404 EVENT_NOT_FOUND', async () => {
  const { server, base } = makeApp({ connect: async () => reviewClient({ found: false }) });
  try {
    const { res, body } = await call(base, 'POST', '/api/v1/admin/payment-events/nope/review', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 404);
    assert.equal(body.code, 'EVENT_NOT_FOUND');
  } finally { server.close(); }
});
