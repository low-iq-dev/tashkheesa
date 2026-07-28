'use strict';

// Payment-event review (Command amount-mismatch triage — Batch 1). Hermetic
// suite on a REAL local Postgres (real types, real COMMIT/ROLLBACK; not mocks),
// modeled on admin_refund_approve.test.js. The review is an UPSERT on the
// payment_event_reviews overlay (UNIQUE payment_event_id), so the core case is
// idempotency: re-reviewing the same event updates note + reviewed_at in place,
// never creating a second row.
//
// Run: node --test tests/admin/payment_event_review.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { reviewPaymentEvent } = require('../../src/services/payment_event_review');

const SUFFIX = 'per-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;
const ACTOR2 = 'superadmin2-' + SUFFIX;

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
    `INSERT INTO orders (id, payment_status, status, base_price, urgency_uplift_amount, created_at)
       VALUES ($1, 'unpaid', 'PENDING', 500, 0, NOW())`,
    [id]
  );
  return id;
}

// An amount_mismatch payment_events row (the queue's only type). payload_json
// carries owed/paid because the columns don't (owed/paid live in the payload).
async function mkMismatchEvent(orderId, { owed = 50000, paid = 45000 } = {}) {
  const id = uid('pe');
  await q(
    `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, hmac_verified, received_at)
       VALUES ($1, $2, $3, 'amount_mismatch', $4, true, NOW())`,
    [id, orderId, uid('intent'), JSON.stringify({ owed_cents: owed, paid_cents: paid, currency: 'EGP', paymob_transaction_id: 'txn-' + id })]
  );
  return id;
}

const getReview = async (peId) => (await q('SELECT * FROM payment_event_reviews WHERE payment_event_id = $1', [peId])).rows[0] || null;
const reviewCount = async (peId) =>
  Number((await q('SELECT COUNT(*) c FROM payment_event_reviews WHERE payment_event_id = $1', [peId])).rows[0].c);
const eventAuditCount = async (orderId) =>
  Number((await q(`SELECT COUNT(*) c FROM order_events WHERE order_id=$1 AND label='payment_event_reviewed'`, [orderId])).rows[0].c);
const adminAuditCount = async (peId) =>
  Number((await q(`SELECT COUNT(*) c FROM error_logs WHERE category='admin_audit' AND message=$1`, [`payment_event_reviewed: ${peId}`])).rows[0].c);

async function run(opts) {
  const client = await pool.connect();
  try { return await reviewPaymentEvent(client, { actorId: ACTOR, ...opts }); }
  finally { client.release(); }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  let err;
  try { await reviewPaymentEvent(client, { actorId: ACTOR, ...opts }); }
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
  await q('DELETE FROM error_logs WHERE user_id IN ($1, $2)', [ACTOR, ACTOR2]);
  await q('DELETE FROM payment_events WHERE id LIKE $1', ['%' + SUFFIX + '%']); // CASCADE clears reviews
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await pool.end();
});

// ── first review: creates the overlay row + both audits ──────────────────────
test('first review: creates row (reviewed_by, note), writes order_events + admin audit', async () => {
  const ord = await mkOrder();
  const pe = await mkMismatchEvent(ord);
  const out = await run({ paymentEventId: pe, note: 'called patient, will re-send link' });

  assert.equal(out.paymentEventId, pe);
  assert.equal(out.reviewedBy, ACTOR);
  assert.equal(out.note, 'called patient, will re-send link');
  assert.ok(out.reviewedAt, 'reviewedAt is an ISO string');

  const row = await getReview(pe);
  assert.equal(row.reviewed_by, ACTOR);
  assert.equal(row.note, 'called patient, will re-send link');
  assert.ok(row.reviewed_at);

  assert.equal(await reviewCount(pe), 1);
  assert.equal(await eventAuditCount(ord), 1, 'order_events payment_event_reviewed written');
  assert.equal(await adminAuditCount(pe), 1, 'admin audit written');
});

// ── UPSERT idempotency: re-review updates in place (never a 2nd row) ──────────
test('re-review is idempotent: single row, note + reviewer + reviewed_at updated in place', async () => {
  const ord = await mkOrder();
  const pe = await mkMismatchEvent(ord);

  const first = await run({ paymentEventId: pe, note: 'first pass' });
  const before = await getReview(pe);

  // Re-review by a DIFFERENT actor with a DIFFERENT note.
  const second = await (async () => {
    const client = await pool.connect();
    try { return await reviewPaymentEvent(client, { paymentEventId: pe, note: 'second pass — resolved', actorId: ACTOR2 }); }
    finally { client.release(); }
  })();

  assert.equal(await reviewCount(pe), 1, 'still exactly ONE review row (UNIQUE upsert)');
  const after = await getReview(pe);
  assert.equal(after.id, before.id, 'same overlay row id (updated, not replaced)');
  assert.equal(after.reviewed_by, ACTOR2, 'reviewer updated');
  assert.equal(after.note, 'second pass — resolved', 'note updated');
  assert.ok(new Date(after.reviewed_at).getTime() >= new Date(before.reviewed_at).getTime(), 'reviewed_at refreshed');
  assert.equal(second.note, 'second pass — resolved');
});

// ── note is optional (TEXT NULL) ─────────────────────────────────────────────
test('review with no note → note null', async () => {
  const ord = await mkOrder();
  const pe = await mkMismatchEvent(ord);
  const out = await run({ paymentEventId: pe });
  assert.equal(out.note, null);
  const row = await getReview(pe);
  assert.equal(row.note, null);
  // blank/whitespace note is normalized to null too
  const out2 = await run({ paymentEventId: pe, note: '   ' });
  assert.equal(out2.note, null);
});

// ── unknown event → 404 ──────────────────────────────────────────────────────
test('EVENT_NOT_FOUND → 404 for a non-existent payment event', async () => {
  const e = await expectReject({ paymentEventId: 'no-such-' + SUFFIX }, 'EVENT_NOT_FOUND');
  assert.equal(e.http, 404);
});

// ── atomicity: a fault on the admin-audit insert rolls the whole txn back ─────
test('atomicity: a fault on the error_logs audit insert rolls back the review + order_events', async () => {
  const ord = await mkOrder();
  const pe = await mkMismatchEvent(ord);
  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql));
  await assert.rejects(
    () => reviewPaymentEvent(proxy, { paymentEventId: pe, note: 'x', actorId: ACTOR }),
    /injected fault/
  );
  real.release();

  assert.equal(await reviewCount(pe), 0, 'review row rolled back');
  assert.equal(await eventAuditCount(ord), 0, 'order_events rolled back');
});
