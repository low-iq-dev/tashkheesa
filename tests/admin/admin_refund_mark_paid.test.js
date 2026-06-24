'use strict';

// Refund MARK-PAID (approved → paid) — slice 6. Hermetic suite on a REAL local
// Postgres. RECORDS-ONLY (no payout API). Covers: paid from 'approved', the
// 'auto_approved' direct path (approved_amount NULL → backfilled), NOT_PAYABLE,
// REFUND_NOT_FOUND, and the atomicity proof. The clawback + notify are
// post-commit/route-level and are NOT exercised here.
//
// Run: node --test tests/admin/admin_refund_mark_paid.test.js
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setRefundPaid } = require('../../src/services/admin_refund_mark_paid');

const SUFFIX = 'rmp-' + process.pid + '-' + Date.now();
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

// A refund in a known state. `approved` is the approved_amount (null on the
// auto_approved direct path); amount_egp seeded = approved ?? requested (the
// invariant slice 4 maintains for approved rows).
async function mkRefund(orderId, { requested = 600, status = 'approved', approved = 600 } = {}) {
  const id = uid('rf');
  const amountEgp = approved != null ? approved : requested;
  await q(
    `INSERT INTO refunds (id, order_id, amount_egp, requested_amount, approved_amount,
                          reason, status, requested_by, refunded_at, refunded_by)
       VALUES ($1, $2, $3, $4, $5, 'operator_refund', $6, $7, NOW(), $7)`,
    [id, orderId, amountEgp, requested, approved, status, ACTOR]
  );
  return id;
}

const getRefund = async (id) => (await q('SELECT * FROM refunds WHERE id = $1', [id])).rows[0];
const eventCount = async (orderId) =>
  Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='superadmin_refund_marked_paid'`, [orderId])).rows[0].c);
const auditCount = async (refundId) =>
  Number((await q(`SELECT COUNT(*) c FROM error_logs WHERE category='admin_audit' AND message=$1`, [`marked_paid_refund: ${refundId}`])).rows[0].c);

async function run(opts) {
  const client = await pool.connect();
  try { return await setRefundPaid(client, { actorId: ACTOR, ...opts }); }
  finally { client.release(); }
}
async function expectReject(opts, code) {
  const client = await pool.connect();
  let err;
  try { await setRefundPaid(client, { actorId: ACTOR, ...opts }); }
  catch (e) { err = e; }
  finally { client.release(); }
  assert.ok(err, 'expected a rejection, got success');
  assert.equal(err.code, code, `expected ${code}, got ${err && err.code}`);
  return err;
}
function faultClient(real, shouldThrow) {
  return new Proxy(real, {
    get(t, prop) {
      if (prop === 'query') {
        return (sql, params) => (shouldThrow(sql, params) ? Promise.reject(new Error('injected fault')) : t.query(sql, params));
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

test.after(async () => {
  await q('DELETE FROM order_events WHERE order_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM error_logs WHERE user_id = $1', [ACTOR]);
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']); // CASCADE clears refunds
  await pool.end();
});

// ── happy from approved ───────────────────────────────────────────────────────
test('mark-paid from approved: status=paid, reference + paid_at, amount_egp=approved, audits', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600, status: 'approved', approved: 400 });
  const out = await run({ refundId: rid, instapayReference: 'IPN-12345' });

  assert.equal(out.status, 'paid');
  assert.equal(out.instapayReference, 'IPN-12345');
  assert.equal(out.amountEgp, 400);
  assert.equal(out.approvedAmount, 400);
  assert.equal(out.finalAmount, 400);
  assert.ok(out.paidAt, 'paidAt is an ISO string');

  const row = await getRefund(rid);
  assert.equal(row.status, 'paid');
  assert.equal(row.instapay_reference, 'IPN-12345');
  assert.ok(row.paid_at);
  assert.equal(Number(row.amount_egp), 400);
  assert.equal(Number(row.approved_amount), 400);
  assert.equal(await eventCount(ord), 1);
  assert.equal(await auditCount(rid), 1);
});

// ── auto_approved direct path: approved_amount NULL → backfilled to requested ──
test('mark-paid from auto_approved (approved_amount NULL): amount_egp=requested AND approved_amount backfilled', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600, status: 'auto_approved', approved: null });
  const out = await run({ refundId: rid, instapayReference: 'IPN-AUTO' });

  assert.equal(out.status, 'paid');
  assert.equal(out.finalAmount, 600, 'finalAmount = requested when approved was null');
  assert.equal(out.amountEgp, 600);
  assert.equal(out.approvedAmount, 600, 'approved_amount backfilled to requested');

  const row = await getRefund(rid);
  assert.equal(Number(row.amount_egp), 600);
  assert.equal(Number(row.approved_amount), 600);
});

// ── NOT_PAYABLE — row unchanged ───────────────────────────────────────────────
test('NOT_PAYABLE: pending / denied / paid → 409, row unchanged', async () => {
  for (const st of ['pending', 'denied', 'paid']) {
    const ord = await mkOrder();
    const rid = await mkRefund(ord, { requested: 600, status: st, approved: st === 'pending' ? null : 600 });
    const e = await expectReject({ refundId: rid, instapayReference: 'X' }, 'NOT_PAYABLE');
    assert.equal(e.http, 409);
    const row = await getRefund(rid);
    assert.equal(row.status, st, `status stays ${st}`);
    if (st !== 'paid') assert.equal(row.paid_at, null, 'no paid_at');
  }
});

test('REFUND_NOT_FOUND → 404', async () => {
  const e = await expectReject({ refundId: 'no-such-' + SUFFIX, instapayReference: 'X' }, 'REFUND_NOT_FOUND');
  assert.equal(e.http, 404);
});

// ── atomicity ─────────────────────────────────────────────────────────────────
test('atomicity: a fault on the error_logs audit insert rolls back everything', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600, status: 'approved', approved: 600 });
  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql));
  await assert.rejects(
    () => setRefundPaid(proxy, { refundId: rid, instapayReference: 'X', actorId: ACTOR }),
    /injected fault/
  );
  real.release();

  const row = await getRefund(rid);
  assert.equal(row.status, 'approved', 'status rolled back to approved');
  assert.equal(row.paid_at, null, 'paid_at rolled back');
  assert.equal(row.instapay_reference, null, 'instapay_reference rolled back');
  assert.equal(await eventCount(ord), 0);
  assert.equal(await auditCount(rid), 0);
});
