'use strict';

// Slice 1 — Command API transfer-claim verify/reject + logout + launch-week
// guards. HERMETIC: the router is built via its (db, helpers, deploy, deps)
// factory with stubs — no real DB. The verify service's real SQL/transaction
// behaviour is proven separately on a local Postgres in
// tests/admin/admin_verify_claim.test.js (including the B4 atomicity fault
// injection); here the routes' mapping, guards, post-commit orchestration and
// response contracts are pinned.
//
// Run: node --test tests/admin/admin_payment_claim_actions.test.js

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-claims-slice1';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = { id: 'sa-1', email: 'ziad.wahsh@shifaegypt.com', role: 'superadmin', name: 'Ziad El Wahsh' };

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function makeApp(stubs = {}) {
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async () => ({ rowCount: 0 })),
    mustGet: stubs.mustGet || stubs.safeGet || (async () => null),
    mustAll: stubs.mustAll || stubs.safeAll || (async () => []),
  };
  const pool = stubs.pool || {
    totalCount: 1, idleCount: 1, waitingCount: 0,
    connect: stubs.connect || (async () => ({ query: async () => ({ rows: [] }), release() {} })),
  };
  const deploy = { gitSha: 'abc1234', startedAt: 1718352000000, startedAtIso: '2026-06-14T07:00:00.000Z', version: '1.0.0', mode: 'test' };
  const deps = Object.assign({
    ensureConversation: async () => 'convo-stub',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true, messageId: 'stub' }),
  }, stubs.deps || {});
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, deps));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, p, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const parsed = await res.json().catch(() => null);
  return { res, body: parsed };
}

// A service error the way admin_verify_claim throws them.
function afErr(msg, http, code) { const e = new Error(msg); e.http = http; e.code = code; return e; }

const VERIFIED_OK = {
  claim: { id: 'pc-1', status: 'confirmed', method: 'instapay', reference: 'TRX-123', senderName: 'Mona', submittedAt: '2026-09-25T08:00:00.000Z', rejectionReason: null, createdAt: '2026-09-25T07:00:00.000Z', resolvedAt: '2026-09-25T09:00:00.000Z' },
  order: { id: 'ord-1', reference: 'TSH-2001', paymentStatus: 'paid', paymentMethod: 'instapay', paymentReference: 'TRX-123', paidAt: '2026-09-25T09:00:00.000Z' },
  patientId: 'pat-1',
  alreadyVerified: false,
};

// ─────────────────────────── POST /payment-claims/:id/verify ────────────────

test('verify — gate: 401 without a token, 403 for a patient token', async () => {
  const app = makeApp();
  try {
    assert.equal((await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', null, {})).res.status, 401);
    const pt = mintToken({ id: 'p1', email: 'p@x.com', role: 'patient', name: 'P' });
    assert.equal((await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', pt, {})).res.status, 403);
  } finally { app.server.close(); }
});

test('verify — body validation: overlong method/reference are 400 BAD_REQUEST before any DB work', async () => {
  let connected = 0;
  const app = makeApp({ connect: async () => { connected++; return { query: async () => ({ rows: [] }), release() {} }; } });
  try {
    const a = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), { method: 'x'.repeat(81) });
    assert.equal(a.res.status, 400);
    assert.equal(a.body.code, 'BAD_REQUEST');
    const b = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), { reference: 'x'.repeat(101) });
    assert.equal(b.res.status, 400);
    assert.equal(connected, 0, 'no connection was taken for an invalid body');
  } finally { app.server.close(); }
});

test('verify — happy: 200 {claim, order, routed:true, patient queued}; markCasePaid + notice fire AFTER the service', async () => {
  const sequence = [];
  const noticed = [];
  const app = makeApp({
    deps: {
      verifyPaymentClaim: async (client, opts) => {
        sequence.push('service');
        assert.equal(opts.claimId, 'pc-1');
        assert.equal(opts.actorId, SUPERADMIN.id);
        return VERIFIED_OK;
      },
      markCasePaid: async (orderId) => { sequence.push('markCasePaid:' + orderId); },
      queueNotification: async (opts) => { sequence.push('notify'); noticed.push(opts); },
      sendCriticalAlert: async () => { sequence.push('alert'); },
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.claim, VERIFIED_OK.claim);
    assert.deepEqual(body.data.order, VERIFIED_OK.order);
    assert.equal(body.data.alreadyVerified, false);
    assert.equal(body.data.routed, true);
    assert.deepEqual(body.data.notifications, { patient: 'queued' });
    assert.deepEqual(sequence, ['service', 'markCasePaid:ord-1', 'notify'], 'web order: atomic core, then boundary, then notice — and no alert');
    assert.equal(noticed[0].toUserId, 'pat-1');
    assert.equal(noticed[0].template, 'payment_marked_paid_patient');
    assert.equal(noticed[0].channel, 'internal');
    assert.equal(noticed[0].orderId, 'ord-1');
  } finally { app.server.close(); }
});

test('verify — markCasePaid non-benign failure: still 200 (money recorded), routed:false, on-call alerted', async () => {
  let alerted = null;
  const app = makeApp({
    deps: {
      verifyPaymentClaim: async () => VERIFIED_OK,
      markCasePaid: async () => { throw new Error('column q does not exist'); },
      queueNotification: async () => {},
      sendCriticalAlert: async (msg, kind) => { alerted = { msg, kind }; },
      logErrorToDb: async () => {},
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 200);
    assert.equal(body.data.routed, false, 'the operator is told the case is NOT in the pipeline');
    assert.ok(alerted && alerted.kind === 'markcasepaid_failed', 'sendCriticalAlert fired');
    assert.match(alerted.msg, /ord-1/);
    assert.equal(body.data.notifications.patient, 'queued', 'the paid notice still goes out — the payment DID happen');
  } finally { app.server.close(); }
});

test('verify — markCasePaid benign re-entry ("already paid"): routed stays true, no alert', async () => {
  let alerted = false;
  const app = makeApp({
    deps: {
      verifyPaymentClaim: async () => VERIFIED_OK,
      markCasePaid: async () => { throw new Error('Case already paid — idempotent no-op'); },
      queueNotification: async () => {},
      sendCriticalAlert: async () => { alerted = true; },
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 200);
    assert.equal(body.data.routed, true);
    assert.equal(alerted, false);
  } finally { app.server.close(); }
});

test('verify — idempotent replay: alreadyVerified:true fires NOTHING (no boundary, no notice)', async () => {
  const fired = [];
  const app = makeApp({
    deps: {
      verifyPaymentClaim: async () => Object.assign({}, VERIFIED_OK, { alreadyVerified: true }),
      markCasePaid: async () => { fired.push('markCasePaid'); },
      queueNotification: async () => { fired.push('notify'); },
      sendCriticalAlert: async () => { fired.push('alert'); },
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 200);
    assert.equal(body.data.alreadyVerified, true);
    assert.equal(body.data.routed, null);
    assert.deepEqual(body.data.notifications, { patient: 'not_attempted' });
    assert.deepEqual(fired, [], 'a replay is a read');
  } finally { app.server.close(); }
});

test('verify — service rejects map to their status+code; nothing post-commit fires', async () => {
  const cases = [
    [afErr('Claim not found', 404, 'CLAIM_NOT_FOUND'), 404, 'CLAIM_NOT_FOUND'],
    [afErr('Case not found', 404, 'ORDER_NOT_FOUND'), 404, 'ORDER_NOT_FOUND'],
    [afErr('already rejected', 409, 'CLAIM_ALREADY_DECIDED'), 409, 'CLAIM_ALREADY_DECIDED'],
    [afErr('practice', 409, 'PRACTICE_CASE'), 409, 'PRACTICE_CASE'],
    [afErr('paid', 409, 'ORDER_ALREADY_PAID'), 409, 'ORDER_ALREADY_PAID'],
  ];
  for (const [err, status, code] of cases) {
    const fired = [];
    const app = makeApp({
      deps: {
        verifyPaymentClaim: async () => { throw err; },
        markCasePaid: async () => { fired.push('markCasePaid'); },
        queueNotification: async () => { fired.push('notify'); },
      },
    });
    try {
      const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
      assert.equal(res.status, status, code);
      assert.equal(body.code, code);
      assert.deepEqual(fired, []);
    } finally { app.server.close(); }
  }
});

test('verify — an unmapped service crash is 500 CLAIM_VERIFY_ERROR', async () => {
  const app = makeApp({ deps: { verifyPaymentClaim: async () => { throw new Error('pool exploded'); } } });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-1/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 500);
    assert.equal(body.code, 'CLAIM_VERIFY_ERROR');
  } finally { app.server.close(); }
});

test('verify — route + REAL service over a fake txn client: COMMIT lands before markCasePaid', async () => {
  const CLAIM = {
    id: 'pc-9', order_id: 'ord-9', patient_id: 'pat-9', method: 'bank', reference: 'BT-77', sender_name: null,
    status: 'pending', rejection_reason: null, created_at: new Date('2026-09-25T07:00:00Z'),
    updated_at: new Date('2026-09-25T07:30:00Z'), resolved_at: null, resolved_by: null,
  };
  const ORDER = {
    id: 'ord-9', reference_id: 'TSH-2009', patient_id: 'pat-9', status: 'SUBMITTED', payment_status: 'unpaid',
    payment_method: null, payment_reference: null, paid_at: null, is_practice: false,
  };
  const calls = [];
  const client = {
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
      if (/FROM payment_claims WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [CLAIM] };
      if (/SELECT id, order_id FROM payment_claims WHERE id = \$1/.test(s)) return { rows: [{ id: 'pc-9', order_id: 'ord-9' }] };
      if (/FROM orders WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(s)) return { rows: [ORDER] };
      if (/UPDATE payment_claims SET status = 'confirmed'/.test(s)) {
        return { rows: [Object.assign({}, CLAIM, { status: 'confirmed', resolved_at: new Date('2026-09-25T09:00:00Z'), resolved_by: params[0] })] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const sequence = [];
  const origQuery = client.query;
  client.query = async (sql, params) => { const r = await origQuery(sql, params); if (/^COMMIT/i.test(String(sql).trim())) sequence.push('COMMIT'); return r; };
  const app = makeApp({
    pool: { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => client },
    deps: {
      markCasePaid: async (orderId) => { sequence.push('markCasePaid:' + orderId); },
      queueNotification: async () => {},
      sendCriticalAlert: async () => {},
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-9/verify', mintToken(SUPERADMIN), {});
    assert.equal(res.status, 200);
    assert.equal(body.data.claim.status, 'confirmed');
    assert.equal(body.data.order.paymentStatus, 'paid');
    assert.equal(body.data.order.paymentMethod, 'bank', 'defaults to the claim method');
    assert.equal(body.data.order.paymentReference, 'BT-77', 'defaults to the claim reference');
    assert.deepEqual(sequence, ['COMMIT', 'markCasePaid:ord-9'], 'the boundary fires strictly after the atomic core commits');
    assert.ok(calls.some((s) => /UPDATE orders SET payment_status = 'paid'/.test(s)));
    assert.ok(calls.some((s) => /INSERT INTO order_events/.test(s)));
    assert.ok(calls.some((s) => /INSERT INTO error_logs/.test(s)));
  } finally { app.server.close(); }
});

// ─────────────────────────── POST /payment-claims/:id/reject ────────────────

const PENDING_ROW = {
  id: 'pc-2', order_id: 'ord-2', patient_id: 'pat-2', method: 'instapay', reference: 'TRX-9', sender_name: 'Ali',
  status: 'pending', rejection_reason: null, created_at: new Date('2026-09-25T07:00:00Z'),
  updated_at: new Date('2026-09-25T07:30:00Z'), resolved_at: null,
  is_practice: false, payment_status: 'unpaid', reference_id: 'TSH-2002',
};

test('reject — gate + 400s: reason is required (the patient reads it), 500-char cap', async () => {
  const app = makeApp();
  try {
    assert.equal((await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', null, { reason: 'x' })).res.status, 401);
    const a = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), {});
    assert.equal(a.res.status, 400);
    assert.equal(a.body.code, 'REASON_REQUIRED');
    const b = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'x'.repeat(501) });
    assert.equal(b.res.status, 400);
    assert.equal(b.body.code, 'REASON_TOO_LONG');
  } finally { app.server.close(); }
});

test('reject — happy: calls the SAME service function as web (rejectClaim) with the claim\'s order id', async () => {
  let calledWith = null;
  const app = makeApp({
    mustGet: async () => PENDING_ROW,
    deps: {
      rejectPaymentClaim: async (opts) => {
        calledWith = opts;
        return { ok: true, claim: Object.assign({}, PENDING_ROW, { status: 'rejected', rejection_reason: opts.reason, resolved_at: new Date('2026-09-25T09:00:00Z') }) };
      },
    },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'No matching transfer on the statement' });
    assert.equal(res.status, 200);
    assert.deepEqual(calledWith, { orderId: 'ord-2', claimId: 'pc-2', reason: 'No matching transfer on the statement', actorId: SUPERADMIN.id });
    assert.equal(body.data.claim.status, 'rejected');
    assert.equal(body.data.claim.rejectionReason, 'No matching transfer on the statement');
    assert.equal(body.data.alreadyRejected, false);
    assert.deepEqual(body.data.order, { id: 'ord-2', reference: 'TSH-2002', paymentStatus: 'unpaid' }, 'the order is NOT touched');
  } finally { app.server.close(); }
});

test('reject — 404 unknown claim; service not called', async () => {
  let called = false;
  const app = makeApp({ mustGet: async () => null, deps: { rejectPaymentClaim: async () => { called = true; } } });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/ghost/reject', mintToken(SUPERADMIN), { reason: 'x' });
    assert.equal(res.status, 404);
    assert.equal(body.code, 'CLAIM_NOT_FOUND');
    assert.equal(called, false);
  } finally { app.server.close(); }
});

test('reject — 409 PRACTICE_CASE on a training case; service not called', async () => {
  let called = false;
  const app = makeApp({
    mustGet: async () => Object.assign({}, PENDING_ROW, { is_practice: true }),
    deps: { rejectPaymentClaim: async () => { called = true; } },
  });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'x' });
    assert.equal(res.status, 409);
    assert.equal(body.code, 'PRACTICE_CASE');
    assert.equal(called, false);
  } finally { app.server.close(); }
});

test('reject — a verified claim is 409 CLAIM_ALREADY_DECIDED; an already-rejected one replays 200', async () => {
  const appA = makeApp({ mustGet: async () => Object.assign({}, PENDING_ROW, { status: 'confirmed' }) });
  try {
    const a = await call(appA.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'x' });
    assert.equal(a.res.status, 409);
    assert.equal(a.body.code, 'CLAIM_ALREADY_DECIDED');
  } finally { appA.server.close(); }

  let called = false;
  const appB = makeApp({
    mustGet: async () => Object.assign({}, PENDING_ROW, { status: 'rejected', rejection_reason: 'first reason stands', resolved_at: new Date() }),
    deps: { rejectPaymentClaim: async () => { called = true; } },
  });
  try {
    const b = await call(appB.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'a different reason' });
    assert.equal(b.res.status, 200);
    assert.equal(b.body.data.alreadyRejected, true);
    assert.equal(b.body.data.claim.rejectionReason, 'first reason stands', 'the stored decision stands; nothing is rewritten');
    assert.equal(called, false);
  } finally { appB.server.close(); }
});

test('reject — lost race (service not_pending): re-read decides between replay and 409', async () => {
  // Raced with another REJECT → replay.
  let reads = 0;
  const appA = makeApp({
    mustGet: async () => {
      reads++;
      if (reads === 1) return PENDING_ROW; // pre-read: still pending
      return Object.assign({}, PENDING_ROW, { status: 'rejected', rejection_reason: 'the other operator won', resolved_at: new Date() });
    },
    deps: { rejectPaymentClaim: async () => ({ ok: false, code: 'not_pending' }) },
  });
  try {
    const a = await call(appA.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'mine' });
    assert.equal(a.res.status, 200);
    assert.equal(a.body.data.alreadyRejected, true);
    assert.equal(a.body.data.claim.rejectionReason, 'the other operator won');
  } finally { appA.server.close(); }

  // Raced with a VERIFY → decided claim.
  let reads2 = 0;
  const appB = makeApp({
    mustGet: async () => {
      reads2++;
      if (reads2 === 1) return PENDING_ROW;
      return Object.assign({}, PENDING_ROW, { status: 'confirmed' });
    },
    deps: { rejectPaymentClaim: async () => ({ ok: false, code: 'not_pending' }) },
  });
  try {
    const b = await call(appB.base, 'POST', '/api/v1/admin/payment-claims/pc-2/reject', mintToken(SUPERADMIN), { reason: 'mine' });
    assert.equal(b.res.status, 409);
    assert.equal(b.body.code, 'CLAIM_ALREADY_DECIDED');
  } finally { appB.server.close(); }
});

// ─────────────────────────── POST /auth/logout (B7) ─────────────────────────

test('logout — with a sid: revokes THIS session row + clears its push token; 200', async () => {
  const runs = [];
  const app = makeApp({ safeRun: async (sql, params) => { runs.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rowCount: 1 }; } });
  try {
    const token = mintToken(Object.assign({}, SUPERADMIN, { sid: 'sess-abc' }));
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/auth/logout', token);
    assert.equal(res.status, 200);
    assert.equal(body.data.message, 'Signed out');
    const revoke = runs.find((r) => /UPDATE user_sessions SET revoked_at = NOW\(\)/.test(r.sql));
    assert.ok(revoke, 'the session row is revoked');
    assert.deepEqual(revoke.params, ['sess-abc', SUPERADMIN.id], 'scoped to the caller\'s OWN sid + user id');
    const pushNull = runs.find((r) => /UPDATE user_sessions SET push_token = NULL WHERE id = \$1 AND user_id = \$2/.test(r.sql));
    assert.ok(pushNull, 'the revoked row\'s push token is cleared');
    assert.deepEqual(pushNull.params, ['sess-abc', SUPERADMIN.id]);
  } finally { app.server.close(); }
});

test('logout — pre-C1 token (no sid): 200 and a NO-OP (no user_sessions or users write)', async () => {
  const runs = [];
  const app = makeApp({ safeRun: async (sql, params) => { runs.push(String(sql)); return { rowCount: 0 }; } });
  try {
    const { res, body } = await call(app.base, 'POST', '/api/v1/admin/auth/logout', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.data.message, 'Signed out');
    assert.deepEqual(runs, [], 'nothing is written for a no-sid token');
  } finally { app.server.close(); }
});

test('logout — idempotent (row already revoked → rowCount 0) and failure-proof: still 200', async () => {
  const appA = makeApp({ safeRun: async () => ({ rowCount: 0 }) });
  try {
    assert.equal((await call(appA.base, 'POST', '/api/v1/admin/auth/logout', mintToken(Object.assign({}, SUPERADMIN, { sid: 'sess-x' })))).res.status, 200);
  } finally { appA.server.close(); }
  const appB = makeApp({ safeRun: async () => { throw new Error('db down'); } });
  try {
    // safeRun swallows; but even a throwing store must not fail a logout.
    assert.equal((await call(appB.base, 'POST', '/api/v1/admin/auth/logout', mintToken(Object.assign({}, SUPERADMIN, { sid: 'sess-x' })))).res.status, 200);
  } finally { appB.server.close(); }
});

test('logout — gate: 401 without a token, 403 for a patient token', async () => {
  const app = makeApp();
  try {
    assert.equal((await call(app.base, 'POST', '/api/v1/admin/auth/logout', null)).res.status, 401);
    const pt = mintToken({ id: 'p1', email: 'p@x.com', role: 'patient', name: 'P', sid: 'sess-p' });
    assert.equal((await call(app.base, 'POST', '/api/v1/admin/auth/logout', pt)).res.status, 403);
  } finally { app.server.close(); }
});

// ─────────────────────────── GET /payment-claims (B3, additive) ─────────────

test('GET /payment-claims — additive tier + patient.age; practice filter in the SQL; existing fields untouched', async () => {
  const manualPayment = require('../../src/services/manual_payment');
  let captured = null;
  const dob = '1990-03-10';
  const restore = manualPayment.__setTestDeps({
    pg: () => ({
      queryAll: async (sql, params) => {
        captured = { sql: String(sql), params };
        return [{
          id: 'pc-7', order_id: 'ord-7', patient_id: 'pat-7', method: 'instapay', reference: 'TRX-77',
          sender_name: 'Mona', status: 'pending', rejection_reason: null,
          created_at: new Date('2026-09-25T07:00:00Z'), updated_at: new Date('2026-09-25T07:30:00Z'),
          resolved_at: null, resolved_by: null,
          reference_id: 'TSH-2007', price: 1600, currency: 'EGP', addons_json: null, payment_status: 'unpaid',
          urgency_tier: 'urgent', patient_name: 'Mona Ali', patient_email: 'mona@x.com',
          patient_phone: '+201234567890', date_of_birth: dob,
        }];
      },
    }),
  });
  const app = makeApp();
  try {
    const { res, body } = await call(app.base, 'GET', '/api/v1/admin/payment-claims', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.match(captured.sql, /NOT COALESCE\(o\.is_practice, false\)/, 'operator list carries the practice predicate');
    const c = body.data.claims[0];
    // Existing contract, unchanged:
    assert.equal(c.id, 'pc-7');
    assert.equal(c.orderId, 'ord-7');
    assert.equal(c.orderReference, 'TSH-2007');
    assert.equal(c.method, 'instapay');
    assert.equal(c.reference, 'TRX-77');
    assert.equal(c.senderName, 'Mona');
    assert.equal(c.amount, 1600);
    assert.equal(c.currency, 'EGP');
    assert.deepEqual(Object.keys(c.patient).sort(), ['age', 'email', 'name', 'phone']);
    // Additive:
    assert.equal(c.tier, 'urgent');
    assert.equal(c.urgencyTier, 'urgent');
    const expectedAge = Math.floor((Date.now() - Date.parse(dob)) / (365.25 * 24 * 3600 * 1000));
    assert.equal(c.patient.age, expectedAge);
    assert.equal(body.data.count, 1);
  } finally {
    restore();
    app.server.close();
  }
});

// ─────────────────────────── B5 practice guards on the write routes ─────────

function guardClient(practiceRow) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
      if (/FOR UPDATE/.test(s)) return { rows: [practiceRow] };
      return { rows: [] };
    },
    release() {},
  };
}

async function expectPractice409(routePath, body, row) {
  const client = guardClient(row);
  const app = makeApp({ pool: { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => client } });
  try {
    const { res, body: b } = await call(app.base, 'POST', routePath, mintToken(SUPERADMIN), body);
    assert.equal(res.status, 409, routePath);
    assert.equal(b.code, 'PRACTICE_CASE', routePath);
    assert.ok(client.calls.includes('ROLLBACK'), routePath + ': txn rolled back');
    assert.ok(!client.calls.some((s) => /^(UPDATE|INSERT)/i.test(s)), routePath + ': nothing written');
  } finally { app.server.close(); }
}

test('B5 — assign / sla-override / manual-queue approve / unsuitable all refuse a practice case with 409 PRACTICE_CASE', async () => {
  await expectPractice409('/api/v1/admin/cases/ord-p/assign', { doctorId: 'doc-1' },
    { id: 'ord-p', doctor_id: null, status: 'paid', payment_status: 'paid', paid_at: new Date(), specialty_id: 'sp', service_id: 'sv', urgency_tier: 'standard', sla_hours: 48, is_practice: true });
  await expectPractice409('/api/v1/admin/cases/ord-p/sla-override', { extendHours: 4, reason: 'test' },
    { id: 'ord-p', status: 'in_review', accepted_at: new Date(), deadline_at: new Date(Date.now() + 3600e3), sla_hours: 48, sla_paused_at: null, breached_at: null, is_practice: true });
  await expectPractice409('/api/v1/admin/manual-queue/ord-p/approve', { specialtyId: 'sp', serviceId: 'sv' },
    { id: 'ord-p', patient_id: 'pat-1', assignment_status: 'manual_queue', payment_status: 'paid', specialty_id: null, service_id: null, is_practice: true });
  await expectPractice409('/api/v1/admin/manual-queue/ord-p/unsuitable', { reason: 'other | not suitable' },
    { id: 'ord-p', patient_id: 'pat-1', assignment_status: 'manual_queue', status: 'paid', payment_status: 'paid', base_price: 500, urgency_uplift_amount: 0, price: 500, addons_json: null, video_consultation_selected: false, video_consultation_price: null, is_practice: true });
});

// ─────────────────────────── B6 — maxRefundable is the write's number ───────

const DETAIL_ROW = {
  id: 'ord-6', reference_id: 'TSH-2006', status: 'completed', urgency_tier: 'standard', payment_status: 'paid',
  paid_at: new Date('2026-09-01T10:00:00Z'), payment_method: 'card',
  price: 1600, base_price: 1400, urgency_uplift_amount: 0, addons_json: null,
  video_consultation_selected: false, video_consultation_price: null,
  created_at: new Date('2026-08-30T10:00:00Z'), completed_at: new Date('2026-09-02T10:00:00Z'),
  accepted_at: new Date('2026-09-01T11:00:00Z'), deadline_at: new Date('2026-09-03T10:00:00Z'), sla_hours: 48,
  doctor_id: null, specialty_id: 'sp', service_id: 'sv', is_practice: false,
  diagnosis_text: null, impression_text: null, recommendation_text: null, clinical_question: null, report_url: null,
  patient_name: 'Mona', gender: 'female', date_of_birth: '1990-01-01',
  doctor_name: null, specialty: 'Cardiology', service: 'ECG', doctor_specialty: null, sla_mins: 100,
};

test('GET /cases/:id — maxRefundable = ceiling MINUS refunds already paid; remainingRefundableEgp rides along', async () => {
  const app = makeApp({
    mustGet: async (sql) => {
      const s = String(sql);
      if (/FROM orders_active o/.test(s) && /LEFT JOIN users p/.test(s)) return DETAIL_ROW;
      return null; // doctor card + latest-refund row
    },
    mustAll: async (sql) => {
      const s = String(sql);
      if (/FROM refunds/.test(s) && /SUM/.test(s)) return [{ total: 400 }];
      return [];
    },
    safeAll: async () => [],
    safeGet: async () => null,
  });
  try {
    const { res, body } = await call(app.base, 'GET', '/api/v1/admin/cases/ord-6', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.data.payment.grandTotal, 1600, 'grandTotal stays the full charge');
    assert.equal(body.data.payment.maxRefundable, 1200, '1600 charged − 400 already paid back');
    assert.equal(body.data.payment.remainingRefundableEgp, 1200);
  } finally { app.server.close(); }
});

test('GET /cases — the list caps are batched per page: a paid partial refund lowers ONLY its own row', async () => {
  const rowBase = {
    status: 'paid', urgency_tier: 'standard', payment_status: 'paid', doctor_id: null,
    created_at: new Date(), deadline_at: null, completed_at: null,
    base_price: null, urgency_uplift_amount: null, addons_json: null,
    video_consultation_selected: false, video_consultation_price: null,
    patient: 'P', gender: null, date_of_birth: null, specialty: 'S', service: 'V', doctor_name: null, sla_mins: null,
  };
  let refundsQuery = null;
  const app = makeApp({
    mustAll: async (sql, params) => {
      const s = String(sql);
      if (/FROM refunds/.test(s) && /ANY\(\$1::text\[\]\)/.test(s)) {
        refundsQuery = { sql: s, params };
        return [{ order_id: 'o1', total: 500 }];
      }
      if (/FROM orders_active o/.test(s) && /LIMIT/.test(s)) {
        return [
          Object.assign({ id: 'o1', reference_id: 'TSH-1', price: 1600 }, rowBase),
          Object.assign({ id: 'o2', reference_id: 'TSH-2', price: 800 }, rowBase),
        ];
      }
      return []; // facets
    },
    mustGet: async () => ({ total: 2 }),
  });
  try {
    const { res, body } = await call(app.base, 'GET', '/api/v1/admin/cases', mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(body.data.cases.map((c) => [c.id, c]));
    assert.equal(byId.o1.maxRefundable, 1100, '1600 − 500 paid back');
    assert.equal(byId.o1.remainingRefundableEgp, 1100);
    assert.equal(byId.o2.maxRefundable, 800, 'untouched row keeps its full ceiling');
    assert.equal(byId.o2.remainingRefundableEgp, 800);
    assert.deepEqual(refundsQuery.params, [['o1', 'o2']], 'ONE refunds query for the whole page');
    assert.match(refundsQuery.sql, /status = 'paid'/, 'only refunds actually PAID count against the cap');
  } finally { app.server.close(); }
});

// ─────────────────────────── source pins (shared-predicate wiring) ──────────

test('pin — countOpenCasesForDoctor (web reassign picker) carries the shared practice predicate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/superadmin.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function countOpenCasesForDoctor'), src.indexOf('async function findBestAlternateDoctor'));
  assert.ok(fn.includes("realCaseSql('')"), 'countOpenCasesForDoctor lost the practice guard');
});

test('pin — bulk-auto-assign skips practice rows first, with reason practice_case', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/admin_bulk_assign.js'), 'utf8');
  assert.ok(/is_practice === true[\s\S]{0,120}reason: 'practice_case'/.test(src), 'bulk skip lost the practice reason');
  assert.ok(src.indexOf("reason: 'practice_case'") < src.indexOf("reason: 'already_assigned'"), 'practice check runs first');
});
