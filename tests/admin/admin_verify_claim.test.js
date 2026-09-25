'use strict';

// Slice 1 B1/B4 — verifyPaymentClaim, hermetic suite on a REAL local Postgres
// (real types, real COMMIT/ROLLBACK; NOT mocks — mocks can't catch SQL/type
// bugs). Modeled on tests/admin/admin_refund.test.js. Money-path write, so:
// happy, defaults vs overrides, paid_at preservation, idempotent replay,
// every rejection (each asserting the order stays unpaid and the claim
// undisturbed), and the B4 atomicity proof by fault injection on EACH audit
// insert — the whole write rolls back, and the retry after the fault is clean.
//
// Run: DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//      PG_SSL=false node --test tests/admin/admin_verify_claim.test.js
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { verifyPaymentClaim } = require('../../src/services/admin_verify_claim');

const SUFFIX = 'vc-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// An unpaid, verifiable order unless overridden.
async function mkOrder(opts = {}) {
  const id = uid('ord');
  await q(
    `INSERT INTO orders (id, reference_id, status, payment_status, payment_method, payment_reference,
                         paid_at, price, deleted_at, is_practice, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [id,
      'TSH-' + SUFFIX + '-' + seq,
      opts.status || 'SUBMITTED',
      opts.payment === undefined ? 'unpaid' : opts.payment,
      opts.method || null,
      opts.reference || null,
      opts.paidAt || null,
      opts.price == null ? 1600 : opts.price,
      opts.deleted ? new Date().toISOString() : null,
      opts.practice === true]
  );
  return id;
}

async function mkClaim(orderId, opts = {}) {
  const id = uid('pc');
  await q(
    `INSERT INTO payment_claims (id, order_id, patient_id, method, reference, sender_name, status,
                                 rejection_reason, created_at, updated_at, resolved_at, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10)`,
    [id, orderId, opts.patientId || null,
      opts.method || 'instapay', opts.reference || ('TRX-' + SUFFIX + '-' + seq), opts.sender || 'Mona',
      opts.status || 'pending', opts.rejectionReason || null,
      opts.status && opts.status !== 'pending' ? new Date().toISOString() : null,
      opts.status && opts.status !== 'pending' ? 'someone-else' : null]
  );
  return id;
}

async function run(opts, client) {
  const own = !client;
  const c = client || await pool.connect();
  try {
    return await verifyPaymentClaim(c, { actorId: ACTOR, ...opts });
  } finally {
    if (own) c.release();
  }
}

async function expectReject(opts, code) {
  let err;
  try { await run(opts); } catch (e) { err = e; }
  assert.ok(err, 'expected a rejection, got success');
  assert.equal(err.code, code, `expected code ${code}, got ${err && err.code} (${err && err.message})`);
  return err;
}

const getOrder = async (id) => (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
const getClaim = async (id) => (await q('SELECT * FROM payment_claims WHERE id=$1', [id])).rows[0];
const eventCount = async (orderId) => Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='Payment marked as paid (superadmin)'`, [orderId])).rows[0].c);
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
  await q('DELETE FROM payment_claims WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await pool.end();
});

// ── happy: the claim's own method/reference become the payment facts ─────────
test('happy: order paid with the claim\'s method+reference; claim confirmed; both audits written', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord, { method: 'bank', reference: 'BT-001-' + SUFFIX, patientId: 'pat-x' });

  const r = await run({ claimId: pc });
  assert.equal(r.alreadyVerified, false);
  assert.equal(r.claim.status, 'confirmed');
  assert.equal(r.order.paymentStatus, 'paid');
  assert.equal(r.order.paymentMethod, 'bank');
  assert.equal(r.order.paymentReference, 'BT-001-' + SUFFIX);
  assert.ok(r.order.paidAt, 'paidAt stamped');
  assert.equal(r.patientId, 'pat-x');

  const o = await getOrder(ord);
  assert.equal(o.payment_status, 'paid');
  assert.equal(o.payment_method, 'bank');
  assert.equal(o.payment_reference, 'BT-001-' + SUFFIX);
  assert.ok(o.paid_at, 'orders.paid_at written');

  const c = await getClaim(pc);
  assert.equal(c.status, 'confirmed');
  assert.equal(c.resolved_by, ACTOR);
  assert.ok(c.resolved_at, 'resolved_at stamped');

  assert.equal(await eventCount(ord), 1);
  assert.equal(await auditCount(ord), 1);
  const ev = (await q(`SELECT meta FROM order_events WHERE order_id=$1 AND label='Payment marked as paid (superadmin)'`, [ord])).rows[0];
  const meta = typeof ev.meta === 'object' ? ev.meta : JSON.parse(ev.meta);
  assert.equal(meta.claim_id, pc, 'the timeline names the claim');
  assert.equal(meta.via, 'command_api_claim_verify');
});

// ── body overrides win over the claim's stored facts ─────────────────────────
test('overrides: an explicit method/reference is recorded instead of the claim\'s', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord, { method: 'instapay', reference: 'ORIGINAL' });
  const r = await run({ claimId: pc, method: 'bank_transfer', reference: 'STATEMENT-LINE-42' });
  assert.equal(r.order.paymentMethod, 'bank_transfer');
  assert.equal(r.order.paymentReference, 'STATEMENT-LINE-42');
  const o = await getOrder(ord);
  assert.equal(o.payment_method, 'bank_transfer');
  assert.equal(o.payment_reference, 'STATEMENT-LINE-42');
});

// ── paid_at is COALESCEd, exactly like the web UPDATE ─────────────────────────
test('paid_at: an existing stamp is preserved, not clobbered', async () => {
  const stamp = '2026-09-20T10:00:00.000Z';
  const ord = await mkOrder({ paidAt: stamp }); // paid_at set, payment_status still unpaid
  const pc = await mkClaim(ord);
  const r = await run({ claimId: pc });
  assert.equal(new Date(r.order.paidAt).toISOString(), stamp);
  const o = await getOrder(ord);
  assert.equal(new Date(o.paid_at).toISOString(), stamp);
});

// ── idempotent replay ─────────────────────────────────────────────────────────
test('replay: a second verify returns the same facts and writes NOTHING new', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord);
  const first = await run({ claimId: pc });
  const resolvedAt = (await getClaim(pc)).resolved_at;

  const again = await run({ claimId: pc });
  assert.equal(again.alreadyVerified, true);
  assert.equal(again.claim.status, 'confirmed');
  assert.equal(again.order.paymentStatus, 'paid');
  assert.equal(again.claim.id, first.claim.id);

  assert.equal(await eventCount(ord), 1, 'no second timeline row');
  assert.equal(await auditCount(ord), 1, 'no second admin-audit row');
  assert.equal(String((await getClaim(pc)).resolved_at), String(resolvedAt), 'resolution stamp untouched');
});

// ── every rejection: order stays unpaid, claim undisturbed ────────────────────
test('reject CLAIM_NOT_FOUND — unknown claim id', async () => {
  await expectReject({ claimId: uid('ghost') }, 'CLAIM_NOT_FOUND');
});

test('reject ORDER_NOT_FOUND — claim on a soft-deleted order; claim stays pending', async () => {
  const ord = await mkOrder({ deleted: true });
  const pc = await mkClaim(ord);
  await expectReject({ claimId: pc }, 'ORDER_NOT_FOUND');
  assert.equal((await getClaim(pc)).status, 'pending');
  assert.equal((await getOrder(ord)).payment_status, 'unpaid');
});

test('reject CLAIM_ALREADY_DECIDED — a rejected claim cannot be verified; order stays unpaid', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord, { status: 'rejected', rejectionReason: 'no match' });
  await expectReject({ claimId: pc }, 'CLAIM_ALREADY_DECIDED');
  assert.equal((await getOrder(ord)).payment_status, 'unpaid');
  const c = await getClaim(pc);
  assert.equal(c.status, 'rejected');
  assert.equal(c.rejection_reason, 'no match');
});

test('reject PRACTICE_CASE — training case; order unpaid, claim pending, no audit rows', async () => {
  const ord = await mkOrder({ practice: true });
  const pc = await mkClaim(ord);
  await expectReject({ claimId: pc }, 'PRACTICE_CASE');
  assert.equal((await getOrder(ord)).payment_status, 'unpaid');
  assert.equal((await getClaim(pc)).status, 'pending');
  assert.equal(await eventCount(ord), 0);
  assert.equal(await auditCount(ord), 0);
});

test('reject ORDER_ALREADY_PAID — card raced the transfer; the pending claim is left for a human', async () => {
  const ord = await mkOrder({ payment: 'paid', method: 'card', paidAt: new Date().toISOString() });
  const pc = await mkClaim(ord);
  await expectReject({ claimId: pc }, 'ORDER_ALREADY_PAID');
  const o = await getOrder(ord);
  assert.equal(o.payment_method, 'card', 'the card facts are not overwritten');
  assert.equal((await getClaim(pc)).status, 'pending');
});

// ── B4: atomicity by fault injection on EACH audit insert ─────────────────────
test('B4 atomicity: a throw on the error_logs audit insert rolls EVERYTHING back; the retry is clean', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord);

  const real = await pool.connect();
  let err;
  try {
    await verifyPaymentClaim(
      faultClient(real, (sql) => /INSERT INTO error_logs/i.test(String(sql))),
      { claimId: pc, actorId: ACTOR }
    );
  } catch (e) { err = e; } finally { real.release(); }
  assert.ok(err, 'the fault surfaced');
  assert.match(err.message, /injected fault/);

  // NOTHING landed: not the payment facts, not the claim flip, not the event.
  const o = await getOrder(ord);
  assert.equal(o.payment_status, 'unpaid', 'order stays unpaid');
  assert.equal(o.payment_method, null);
  assert.equal(o.paid_at, null);
  assert.equal((await getClaim(pc)).status, 'pending', 'claim stays pending');
  assert.equal(await eventCount(ord), 0, 'the order_events insert rolled back with it');
  assert.equal(await auditCount(ord), 0);

  // The retry after the fault is clean and complete.
  const r = await run({ claimId: pc });
  assert.equal(r.alreadyVerified, false);
  assert.equal((await getOrder(ord)).payment_status, 'paid');
  assert.equal((await getClaim(pc)).status, 'confirmed');
  assert.equal(await eventCount(ord), 1);
  assert.equal(await auditCount(ord), 1);
});

test('B4 atomicity: a throw on the order_events insert rolls back the same way', async () => {
  const ord = await mkOrder();
  const pc = await mkClaim(ord);

  const real = await pool.connect();
  let err;
  try {
    await verifyPaymentClaim(
      faultClient(real, (sql) => /INSERT INTO order_events/i.test(String(sql))),
      { claimId: pc, actorId: ACTOR }
    );
  } catch (e) { err = e; } finally { real.release(); }
  assert.ok(err, 'the fault surfaced');

  assert.equal((await getOrder(ord)).payment_status, 'unpaid');
  assert.equal((await getClaim(pc)).status, 'pending');
  assert.equal(await auditCount(ord), 0);

  const r = await run({ claimId: pc });
  assert.equal(r.order.paymentStatus, 'paid');
  assert.equal(await eventCount(ord), 1);
  assert.equal(await auditCount(ord), 1);
});

// ── B5 (service-level): the refund write refuses a practice case ──────────────
test('B5: issueRefund refuses a paid PRACTICE case with 409 PRACTICE_CASE and writes no refund row', async () => {
  const { issueRefund } = require('../../src/services/admin_refund');
  const ord = await mkOrder({ practice: true, payment: 'paid', paidAt: new Date().toISOString() });
  const client = await pool.connect();
  let err;
  try {
    await issueRefund(client, { orderId: ord, amount: 100, instapayHandle: '@x.handle', actorId: ACTOR });
  } catch (e) { err = e; } finally { client.release(); }
  assert.ok(err, 'expected a rejection');
  assert.equal(err.code, 'PRACTICE_CASE');
  assert.equal(Number((await q('SELECT COUNT(*) c FROM refunds WHERE order_id=$1', [ord])).rows[0].c), 0);
});
