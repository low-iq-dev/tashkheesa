'use strict';

// Refund DENY (pending → denied, required reason) — slice 5. Hermetic suite on a
// REAL local Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_refund_approve.test.js + admin_doctor_reject.test.js. Covers: deny happy
// (amounts UNCHANGED), NOT_DENIABLE, REFUND_NOT_FOUND, and the atomicity proof.
// The notification is post-commit/off-txn and is mock-asserted in the route test.
//
// Run: node --test tests/admin/admin_refund_deny.test.js
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setRefundDenial } = require('../../src/services/admin_refund_deny');

const SUFFIX = 'rd-' + process.pid + '-' + Date.now();
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
  Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='superadmin_refund_denied'`, [orderId])).rows[0].c);
const auditRow = async (refundId) =>
  (await q(`SELECT message, context FROM error_logs WHERE category='admin_audit' AND message=$1 LIMIT 1`, [`denied_refund: ${refundId}`])).rows[0] || null;
const auditCount = async (refundId) =>
  Number((await q(`SELECT COUNT(*) c FROM error_logs WHERE category='admin_audit' AND message=$1`, [`denied_refund: ${refundId}`])).rows[0].c);
const ctxOf = (row) => (row ? (typeof row.context === 'string' ? JSON.parse(row.context) : row.context) : null);

async function run(opts) {
  const client = await pool.connect();
  try { return await setRefundDenial(client, { actorId: ACTOR, ...opts }); }
  finally { client.release(); }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  let err;
  try { await setRefundDenial(client, { actorId: ACTOR, ...opts }); }
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

// ── deny happy — amounts left untouched ───────────────────────────────────────
test('deny happy: pending → denied, reason + reviewer stamped, amounts UNCHANGED, audits', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const out = await run({ refundId: rid, denialReason: 'Outside refund window' });

  assert.equal(out.status, 'denied');
  assert.equal(out.denialReason, 'Outside refund window');
  assert.equal(out.orderId, ord);
  assert.ok(out.reviewedAt, 'reviewedAt is an ISO string');

  const row = await getRefund(rid);
  assert.equal(row.status, 'denied');
  assert.equal(row.denial_reason, 'Outside refund window');
  assert.equal(row.reviewed_by, ACTOR);
  assert.ok(row.reviewed_at);
  // amounts must be untouched by deny
  assert.equal(Number(row.amount_egp), 600, 'amount_egp unchanged');
  assert.equal(row.approved_amount, null, 'approved_amount unchanged (null)');

  assert.equal(await eventCount(ord), 1, 'order_events superadmin_refund_denied written');
  assert.equal(await auditCount(rid), 1, 'admin audit written');
  const ctx = ctxOf(await auditRow(rid));
  assert.equal(ctx.action, 'denied_refund');
  assert.equal(ctx.target, rid);
  assert.equal(ctx.denial_reason, 'Outside refund window');
});

// ── NOT_DENIABLE — each asserts the row is UNCHANGED ──────────────────────────
test('NOT_DENIABLE: already approved / denied / paid → 409, row unchanged', async () => {
  for (const st of ['approved', 'denied', 'paid']) {
    const ord = await mkOrder();
    const rid = await mkRefund(ord, { requested: 600, status: st, approved: st === 'approved' || st === 'paid' ? 400 : null });
    const e = await expectReject({ refundId: rid, denialReason: 'x' }, 'NOT_DENIABLE');
    assert.equal(e.http, 409);
    const row = await getRefund(rid);
    assert.equal(row.status, st, `status stays ${st}`);
  }
});

test('REFUND_NOT_FOUND → 404', async () => {
  const e = await expectReject({ refundId: 'no-such-' + SUFFIX, denialReason: 'x' }, 'REFUND_NOT_FOUND');
  assert.equal(e.http, 404);
});

// ── atomicity: fault on the audit insert rolls the whole txn back ─────────────
test('atomicity: a fault on the error_logs audit insert rolls back everything', async () => {
  const ord = await mkOrder();
  const rid = await mkRefund(ord, { requested: 600 });
  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql));
  await assert.rejects(
    () => setRefundDenial(proxy, { refundId: rid, denialReason: 'x', actorId: ACTOR }),
    /injected fault/
  );
  real.release();

  const row = await getRefund(rid);
  assert.equal(row.status, 'pending', 'status rolled back to pending');
  assert.equal(row.denial_reason, null, 'denial_reason rolled back');
  assert.equal(await eventCount(ord), 0, 'order_events rolled back');
  assert.equal(await auditCount(rid), 0, 'audit rolled back');
});
