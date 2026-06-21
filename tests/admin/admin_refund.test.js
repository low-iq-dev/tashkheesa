'use strict';

// Operator refund — hermetic suite on a REAL local Postgres (real types, real
// COMMIT/ROLLBACK; NOT mocks — mocks can't catch SQL/type bugs). Modeled on
// admin_bulk_assign.test.js. Money-path write, so: happy (full), partial, every
// rejection (each asserting NO refunds row written), and the atomicity proof.
//
// Run: DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//      PG_SSL=false node --test tests/admin/admin_refund.test.js
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { issueRefund } = require('../../src/services/admin_refund');

const SUFFIX = 'rf-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A paid, refundable order (base 500 + uplift 100 = max 600) unless overridden.
async function mkOrder(opts = {}) {
  const id = uid('ord');
  await q(
    `INSERT INTO orders (id, payment_status, status, base_price, urgency_uplift_amount, paid_at, deleted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [id,
      opts.payment === undefined ? 'paid' : opts.payment,
      opts.status || 'PAID',
      opts.base == null ? 500 : opts.base,
      opts.uplift == null ? 100 : opts.uplift,
      opts.paid === false ? null : new Date().toISOString(),
      opts.deleted ? new Date().toISOString() : null]
  );
  return id;
}

// Seed an existing refund (for the already-refunded gate).
async function mkRefund(orderId, status = 'pending') {
  const id = uid('rf');
  await q(
    `INSERT INTO refunds (id, order_id, amount_egp, reason, status, refunded_at)
       VALUES ($1, $2, $3, 'operator_refund', $4, NOW())`,
    [id, orderId, 300, status]
  );
  return id;
}

async function run(opts) {
  const client = await pool.connect();
  try {
    return await issueRefund(client, { actorId: ACTOR, ...opts });
  } finally {
    client.release();
  }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  let err;
  try { await issueRefund(client, { actorId: ACTOR, ...opts }); }
  catch (e) { err = e; }
  finally { client.release(); }
  assert.ok(err, 'expected a rejection, got success');
  assert.equal(err.code, code, `expected code ${code}, got ${err && err.code}`);
}

const refundCount = async (orderId) => Number((await q('SELECT COUNT(*) c FROM refunds WHERE order_id=$1', [orderId])).rows[0].c);
const getRefund = async (orderId) => (await q('SELECT * FROM refunds WHERE order_id=$1 ORDER BY refunded_at DESC LIMIT 1', [orderId])).rows[0];
const eventCount = async (orderId) => Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='operator_refund_created'`, [orderId])).rows[0].c);
// error_logs.context is TEXT (JSON stored as a string), so match the message,
// which embeds the order id ("operator refund <id> for order <orderId> …").
const auditCount = async (orderId) => Number((await q(`SELECT COUNT(*) c FROM error_logs WHERE category='admin_audit' AND message LIKE $1`, ['%' + orderId + '%'])).rows[0].c);

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
  await q('DELETE FROM error_logs WHERE message LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']); // ON DELETE CASCADE clears refunds
  await pool.end();
});

// ── happy: full refund writes the row + both audits ───────────────────────────
test('happy: full refund records a pending row + order_events + admin audit', async () => {
  const ord = await mkOrder({ base: 500, uplift: 100 }); // max 600
  const r = await run({ orderId: ord, amount: 600, instapayHandle: '@patient.handle', notes: 'Service quality issue' });

  assert.equal(r.status, 'pending');
  assert.equal(r.amountEgp, 600);
  assert.equal(r.reason, 'operator_refund');
  assert.ok(r.id);
  assert.ok(r.createdAt, 'createdAt is an ISO string');

  const row = await getRefund(ord);
  assert.equal(Number(row.amount_egp), 600);
  assert.equal(Number(row.requested_amount), 600);
  assert.equal(row.approved_amount, null);
  assert.equal(row.status, 'pending');
  assert.equal(row.reason, 'operator_refund');
  assert.equal(row.instapay_handle, '@patient.handle');
  assert.equal(row.requested_by, ACTOR);
  assert.equal(row.refunded_by, ACTOR);
  assert.match(row.notes, /Operator-initiated refund \(Command app\)/);
  assert.match(row.notes, /Service quality issue/);

  assert.equal(await eventCount(ord), 1);
  assert.equal(await auditCount(ord), 1);
});

// ── partial refund ────────────────────────────────────────────────────────────
test('partial: amount below the max records that amount', async () => {
  const ord = await mkOrder({ base: 500, uplift: 100 });
  const r = await run({ orderId: ord, amount: 250, instapayHandle: '@p.partial' });
  assert.equal(r.amountEgp, 250);
  assert.equal(Number((await getRefund(ord)).amount_egp), 250);
});

// ── every rejection — each asserts NO refunds row written ─────────────────────
test('reject ORDER_NOT_FOUND — no row', async () => {
  const ghost = uid('ghost');
  await expectReject({ orderId: ghost, amount: 100, instapayHandle: '@x.handle' }, 'ORDER_NOT_FOUND');
  assert.equal(await refundCount(ghost), 0);
});

test('reject ORDER_NOT_PAID — no row', async () => {
  const ord = await mkOrder({ payment: 'unpaid', paid: false });
  await expectReject({ orderId: ord, amount: 100, instapayHandle: '@x.handle' }, 'ORDER_NOT_PAID');
  assert.equal(await refundCount(ord), 0);
});

test('reject REFUND_ALREADY_EXISTS — original row untouched', async () => {
  const ord = await mkOrder();
  await mkRefund(ord, 'pending');
  await expectReject({ orderId: ord, amount: 100, instapayHandle: '@x.handle' }, 'REFUND_ALREADY_EXISTS');
  assert.equal(await refundCount(ord), 1); // only the seeded one
});

test('reject INVALID_AMOUNT (zero and negative) — no row', async () => {
  const ord = await mkOrder();
  await expectReject({ orderId: ord, amount: 0, instapayHandle: '@x.handle' }, 'INVALID_AMOUNT');
  await expectReject({ orderId: ord, amount: -50, instapayHandle: '@x.handle' }, 'INVALID_AMOUNT');
  assert.equal(await refundCount(ord), 0);
});

test('reject AMOUNT_EXCEEDS_MAX — no row', async () => {
  const ord = await mkOrder({ base: 500, uplift: 100 }); // max 600
  await expectReject({ orderId: ord, amount: 700, instapayHandle: '@x.handle' }, 'AMOUNT_EXCEEDS_MAX');
  assert.equal(await refundCount(ord), 0);
});

test('reject INSTAPAY_REQUIRED (empty + too short) — no row', async () => {
  const ord = await mkOrder();
  await expectReject({ orderId: ord, amount: 100, instapayHandle: '' }, 'INSTAPAY_REQUIRED');
  await expectReject({ orderId: ord, amount: 100, instapayHandle: 'ab' }, 'INSTAPAY_REQUIRED');
  assert.equal(await refundCount(ord), 0);
});

// ── atomicity: fault on the admin-audit insert rolls the WHOLE txn back ────────
test('atomicity: a fault on the error_logs audit insert rolls back everything', async () => {
  const ord = await mkOrder();
  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql));

  await assert.rejects(
    () => issueRefund(proxy, { orderId: ord, amount: 300, instapayHandle: '@atomic.h', actorId: ACTOR }),
    /injected fault/
  );
  real.release();

  // Nothing persisted: no refunds row, no order_events row.
  assert.equal(await refundCount(ord), 0);
  assert.equal(await eventCount(ord), 0);
});
