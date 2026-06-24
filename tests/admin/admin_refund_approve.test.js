'use strict';

// Refund APPROVE (pending → approved, supports partial) — slice 4. Hermetic
// suite on a REAL local Postgres (real types, real COMMIT/ROLLBACK; not mocks).
// Modeled on admin_refund.test.js + admin_doctor_approve.test.js. Money-path
// write, so: full approval, partial approval, every rejection (each asserting the
// row is UNCHANGED), and the atomicity proof. The notification is post-commit /
// off-txn and is mock-asserted in the route test, NOT here.
//
// Run: node --test tests/admin/admin_refund_approve.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setRefundApproval } = require('../../src/services/admin_refund_approve');

const SUFFIX = 'ra-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

async function mkOrder() {
  const id = uid('ord');
  await q(
    `INSERT INTO orders (id, payment_status, status, base_price, urgency_uplift_amount, paid_at, created_at)
       VALUES ($1, 'paid', 'PAID', 500, 100, NOW(), NOW())`,
    [id]
  );
  return id;
}

// A refund in a known state. Pending creates amount_egp == requested_amount
// (the create invariant); approved_amount NULL until approve.
async function mkRefund(orderId, { requested = 600, status = 'pending', approved = null } = {}) {
  const id = uid('rf');
  await q(
    `INSERT INTO refunds (id, order_id, amount_egp, requested_amount, approved_amount,
                          reason, status, requested_by, refunded_at, refunded_by)
       VALUES ($1, $2, $3, $3, $4, 'operator_refund', $5, $6, NOW(), $6)`,
    [id, orderId, requested, approved, status, ACTOR]
  );
  return id;
}

const getRefund = async (id) => (await q('SELECT * FROM refunds WHERE id = $1', [id])).rows[0];
const eventCount = async (orderId) =>
  Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='superadmin_refund_approved'`, [orderId])).rows[0].c);
const auditRow = async (refundId) =>
  (await q(`SELECT message, context FROM error_logs WHERE category='admin_audit' AND message=$1 LIMIT 1`, [`approved_refund: ${refundId}`])).rows[0] || null;
const auditCount = async (refundId) =>
  Number((await q(`SELECT COUNT(*) c FROM error_logs WHERE category='admin_audit' AND message=$1`, [`approved_refund: ${refundId}`])).rows[0].c);
const ctxOf = (row) => (row ? (typeof row.context === 'string' ? JSON.parse(row.context) : row.context) : null);

async function run(opts) {
  const client = await pool.connect();
  try { return await setRefundApproval(client, { actorId: ACTOR, ...opts }); }
  finally { client.release(); }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  let err;
  try { await setRefundApproval(client, { actorId: ACTOR, ...opts }); }
  catch (e) { err = e; }
  finally { client.release(); }
  assert.ok(err, 'expected a rejection, got success');
  assert.equal(err.code, code, `expected code ${code}, got ${err && err.code}`);
  return err;
}

function faultClient(real, shouldThrow) {
  return new Proxy(real, {
    get(t, prop) {
      if (prop === 'query') {
        return (sql, params) => (shouldThrow(sql, params)
          ? Promise.reject(new Error('injected fault'))
          : t.query(sql, params));
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

test.after(async () => {
  await q('DELETE FROM order_events WHERE order_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM error_logs WHERE user_id = $1', [ACTOR]);
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']); // ON DELETE CASCADE clears refunds
  await pool.end();
});

// ── full approval (approved == requested) ─────────────────────────────────────
test('full approval: approved=requested → status approved, approved_amount=amount_egp=requested, audits', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const out = await run({ refundId: rid, approvedAmount: 600, notes: 'verified' });

  assert.equal(out.status, 'approved');
  assert.equal(out.approvedAmount, 600);
  assert.equal(out.amountEgp, 600);
  assert.equal(out.requestedAmount, 600);
  assert.equal(out.orderId, ord);
  assert.ok(out.reviewedAt, 'reviewedAt is an ISO string');

  const row = await getRefund(rid);
  assert.equal(row.status, 'approved');
  assert.equal(Number(row.approved_amount), 600);
  assert.equal(Number(row.amount_egp), 600, 'amount_egp coherence: set to approved');
  assert.equal(Number(row.requested_amount), 600);
  assert.equal(row.reviewed_by, ACTOR);
  assert.ok(row.reviewed_at);
  assert.match(row.notes, /verified/);

  assert.equal(await eventCount(ord), 1, 'order_events superadmin_refund_approved written');
  assert.equal(await auditCount(rid), 1, 'admin audit written');
  const ctx = ctxOf(await auditRow(rid));
  assert.equal(ctx.action, 'approved_refund');
  assert.equal(ctx.target, rid);
  assert.equal(ctx.approved_amount, 600);
  assert.equal(ctx.requested_amount, 600);
});

// ── partial approval (approved < requested) ───────────────────────────────────
test('partial approval: approved<requested → approved_amount=amount_egp=partial (NOT requested)', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const out = await run({ refundId: rid, approvedAmount: 250 });

  assert.equal(out.approvedAmount, 250);
  assert.equal(out.amountEgp, 250);
  assert.equal(out.requestedAmount, 600, 'requested_amount preserved as the historical ask');

  const row = await getRefund(rid);
  assert.equal(Number(row.approved_amount), 250);
  assert.equal(Number(row.amount_egp), 250, 'amount_egp follows the partial figure, not requested');
  assert.equal(Number(row.requested_amount), 600);
});

// ── rejections — each asserts the row is UNCHANGED ────────────────────────────
test('INVALID_AMOUNT (0 and negative) → 400, row unchanged', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  let e = await expectReject({ refundId: rid, approvedAmount: 0 }, 'INVALID_AMOUNT');
  assert.equal(e.http, 400);
  await expectReject({ refundId: rid, approvedAmount: -50 }, 'INVALID_AMOUNT');
  const row = await getRefund(rid);
  assert.equal(row.status, 'pending');
  assert.equal(row.approved_amount, null);
  assert.equal(Number(row.amount_egp), 600, 'amount_egp untouched');
  assert.equal(await eventCount(ord), 0);
});

test('AMOUNT_EXCEEDS_REQUESTED (> requested) → 409, row unchanged', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const e = await expectReject({ refundId: rid, approvedAmount: 700 }, 'AMOUNT_EXCEEDS_REQUESTED');
  assert.equal(e.http, 409);
  const row = await getRefund(rid);
  assert.equal(row.status, 'pending');
  assert.equal(row.approved_amount, null);
});

test('NOT_APPROVABLE: already approved / denied / paid → 409, row unchanged', async () => {
  for (const st of ['approved', 'denied', 'paid']) {
    const ord = await mkOrder();
    const rid = await mkRefund(ord, { requested: 600, status: st, approved: st === 'pending' ? null : 400 });
    const e = await expectReject({ refundId: rid, approvedAmount: 300 }, 'NOT_APPROVABLE');
    assert.equal(e.http, 409);
    const row = await getRefund(rid);
    assert.equal(row.status, st, `status stays ${st}`);
  }
});

test('REFUND_NOT_FOUND → 404', async () => {
  const e = await expectReject({ refundId: 'no-such-' + SUFFIX, approvedAmount: 100 }, 'REFUND_NOT_FOUND');
  assert.equal(e.http, 404);
});

// ── atomicity: fault on the audit insert rolls the whole txn back ─────────────
test('atomicity: a fault on the error_logs audit insert rolls back everything', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql));
  await assert.rejects(
    () => setRefundApproval(proxy, { refundId: rid, approvedAmount: 600, actorId: ACTOR }),
    /injected fault/
  );
  real.release();

  const row = await getRefund(rid);
  assert.equal(row.status, 'pending', 'status rolled back to pending');
  assert.equal(row.approved_amount, null, 'approved_amount rolled back');
  assert.equal(Number(row.amount_egp), 600, 'amount_egp rolled back (unchanged)');
  assert.equal(await eventCount(ord), 0, 'order_events rolled back');
  assert.equal(await auditCount(rid), 0, 'audit rolled back');
});
