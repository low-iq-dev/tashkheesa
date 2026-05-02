// tests/services/earnings_writer.test.js
//
// Integration tests for src/services/earnings_writer.js — the wiring
// of computeDoctorEarnings into the doctor_earnings table at the
// three P0-FIN-1 sites.
//
// Scenarios:
//   1. writePendingForCase inserts a pending row with the right
//      base+uplift split using policy worked-example B (VIP, no addons).
//   2. writePendingForCase is idempotent (second call returns
//      already_exists, no duplicate row).
//   3. markCaseEarningsPaid flips pending → paid with paid_at set.
//   4. markCaseEarningsPaid on a legacy order (no pending row) inserts
//      directly with status='paid'.
//   5. recomputeOnBreach drops earned_amount to base-only when uplift
//      is zeroed — policy worked-example D (VIP breached): 870 → 600.
//   6. recomputeOnBreach is a no-op + skip signal when no row exists.
//
// Skipped automatically when DATABASE_URL is not set.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💰 services/earnings_writer\n');

if (!process.env.DATABASE_URL) {
  t.skip('earnings_writer integration', 'DATABASE_URL not set');
  return;
}

const TEST_PREFIX = 'test-earn-';

const { pool, execute, queryOne } = require('../../src/pg');
const earningsWriter = require('../../src/services/earnings_writer');

function uid(label) {
  return TEST_PREFIX + label + '-' + crypto.randomBytes(4).toString('hex');
}

// Insert a paid order with the requested doctor_fee + urgency_uplift_amount.
// Uses example values from docs/PAYOUT_AND_URGENCY_POLICY.md:
//   base 3000 (price), doctor_fee 600.
// VIP example B passes upliftAmount=900 (3000 × 1.3 = 3900 → uplift 900).
async function insertPaidOrder({ doctorId, doctorFee, upliftAmount }) {
  const id = uid('order');
  await execute(
    `INSERT INTO orders
       (id, status, payment_status, paid_at, doctor_id, doctor_fee,
        price, urgency_uplift_amount, sla_hours, accepted_at,
        created_at, updated_at)
     VALUES ($1, 'in_review', 'paid', NOW(), $2, $3,
             $4, $5, 72, NOW(), NOW(), NOW())`,
    [id, doctorId, doctorFee, doctorFee + upliftAmount, upliftAmount]
  );
  return id;
}

async function getMainEarningsRow(orderId, doctorId) {
  return queryOne(
    `SELECT id, status, gross_amount, earned_amount, paid_at
       FROM doctor_earnings
      WHERE appointment_id = $1 AND doctor_id = $2 AND id LIKE 'earn-main-%'`,
    [orderId, doctorId]
  );
}

async function cleanup() {
  await execute(
    `DELETE FROM doctor_earnings WHERE appointment_id IN
      (SELECT id FROM orders WHERE id LIKE $1)`,
    [TEST_PREFIX + '%']
  );
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [TEST_PREFIX + '%']);
}

(async function run() {
  try {
    await cleanup();

    const doctorId = 'test-earn-doc-' + crypto.randomBytes(4).toString('hex');

    // ── 1. writePendingForCase — VIP example B (3000 base, 600 fee, 900 uplift)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      const r = await earningsWriter.writePendingForCase(orderId);

      assert.ok(r && r.written, 'should report written=true; got: ' + JSON.stringify(r));
      // Per Example B: baseShare 600 + upliftShare 270 = 870
      assert.strictEqual(r.baseShare, 600, 'baseShare = 600');
      assert.strictEqual(r.upliftShare, 270, 'upliftShare = 900 × 30% = 270');
      assert.strictEqual(r.earnedAmount, 870, 'earnedAmount = 870');

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.ok(row, 'pending row should exist in DB');
      assert.strictEqual(row.status, 'pending', 'status = pending');
      assert.strictEqual(Number(row.earned_amount), 870, 'DB earned_amount = 870');
      assert.strictEqual(Number(row.gross_amount), 1500, 'DB gross_amount = 600 + 900 = 1500');
      assert.strictEqual(row.paid_at, null, 'paid_at is null on pending row');
      t.pass('writePendingForCase: VIP example B → pending row with baseShare=600, upliftShare=270');
    } catch (e) { t.fail('writePendingForCase happy path', e); }

    // ── 2. writePendingForCase idempotency
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 0 });
      await earningsWriter.writePendingForCase(orderId);
      const r2 = await earningsWriter.writePendingForCase(orderId);

      assert.strictEqual(r2.skipped, 'already_exists', 'second call should report already_exists');

      const rows = await queryOne(
        `SELECT COUNT(*) AS n FROM doctor_earnings
          WHERE appointment_id = $1 AND doctor_id = $2 AND id LIKE 'earn-main-%'`,
        [orderId, doctorId]
      );
      assert.strictEqual(Number(rows.n), 1, 'exactly one row exists');
      t.pass('writePendingForCase: idempotent (second call no-op, single row remains)');
    } catch (e) { t.fail('writePendingForCase idempotency', e); }

    // ── 3. markCaseEarningsPaid flips pending → paid
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      await earningsWriter.writePendingForCase(orderId);

      const r = await earningsWriter.markCaseEarningsPaid(orderId, doctorId);
      assert.ok(r && r.updated, 'should report updated=true; got: ' + JSON.stringify(r));

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(row.status, 'paid', 'status flipped to paid');
      assert.ok(row.paid_at, 'paid_at is set');
      assert.strictEqual(Number(row.earned_amount), 870, 'earned_amount stays at 870');
      t.pass('markCaseEarningsPaid: pending → paid with paid_at set');
    } catch (e) { t.fail('markCaseEarningsPaid happy path', e); }

    // ── 4. markCaseEarningsPaid on a legacy order (no pre-existing row)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 0 });
      // No writePendingForCase call — simulate legacy completion.

      const r = await earningsWriter.markCaseEarningsPaid(orderId, doctorId);
      assert.ok(r && r.inserted_legacy, 'should report inserted_legacy=true; got: ' + JSON.stringify(r));

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(row.status, 'paid', 'legacy row inserted with status=paid');
      assert.strictEqual(Number(row.earned_amount), 600, 'standard tier earned_amount = 600');
      t.pass('markCaseEarningsPaid: legacy order → INSERT directly with status=paid');
    } catch (e) { t.fail('markCaseEarningsPaid legacy path', e); }

    // ── 5. recomputeOnBreach — Example D (VIP breached: total 870 → 600)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      await earningsWriter.writePendingForCase(orderId);

      // Simulate the breach refund step that zeros the uplift on the order.
      await execute(
        `UPDATE orders SET urgency_uplift_amount = 0 WHERE id = $1`,
        [orderId]
      );

      const r = await earningsWriter.recomputeOnBreach(orderId);
      assert.ok(r && r.recomputed, 'should report recomputed=true; got: ' + JSON.stringify(r));
      assert.strictEqual(r.newEarnedAmount, 600, 'new earned_amount = 600 (base only)');

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(Number(row.earned_amount), 600, 'DB row reflects base-only earnings');
      assert.strictEqual(Number(row.gross_amount), 600, 'gross_amount also drops to 600');
      t.pass('recomputeOnBreach: §5 example D — VIP breach drops earned_amount 870 → 600');
    } catch (e) { t.fail('recomputeOnBreach happy path', e); }

    // ── 6. recomputeOnBreach with no row → skip signal
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      // Skip writePendingForCase — no row exists.

      const r = await earningsWriter.recomputeOnBreach(orderId);
      assert.strictEqual(r.skipped, 'no_earnings_row', 'should report skipped=no_earnings_row');
      t.pass('recomputeOnBreach: no-op + skip signal when no earnings row exists');
    } catch (e) { t.fail('recomputeOnBreach no-row path', e); }

    // ── 7. writePendingForCase — Urgent example C (3000 base, 600 fee, 1800 uplift)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 1800 });
      const r = await earningsWriter.writePendingForCase(orderId);

      assert.ok(r && r.written, 'should report written=true; got: ' + JSON.stringify(r));
      // Per Example C: baseShare 600 + upliftShare 540 (1800 × 30%) = 1140
      // (Example C also includes a video addon — addon shares live in
      // addon_earnings, not doctor_earnings. Main row earned_amount is
      // base + uplift only.)
      assert.strictEqual(r.baseShare, 600, 'baseShare = 600');
      assert.strictEqual(r.upliftShare, 540, 'upliftShare = 1800 × 30% = 540');
      assert.strictEqual(r.earnedAmount, 1140, 'earnedAmount = 1140');

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(Number(row.earned_amount), 1140, 'DB earned_amount = 1140');
      assert.strictEqual(Number(row.gross_amount), 2400, 'DB gross_amount = 600 + 1800 = 2400');
      t.pass('writePendingForCase: Urgent example C → pending row with baseShare=600, upliftShare=540');
    } catch (e) { t.fail('writePendingForCase Urgent path', e); }

    // ── 8. recomputeOnBreach — Urgent breach (1140 → 600)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 1800 });
      await earningsWriter.writePendingForCase(orderId);

      // Simulate breach: zero out the uplift on the orders row first
      // (sla_breach.js does this in production).
      await execute(
        'UPDATE orders SET urgency_uplift_amount = 0 WHERE id = $1',
        [orderId]
      );
      const r = await earningsWriter.recomputeOnBreach(orderId);

      assert.ok(r && r.recomputed, 'should report recomputed=true');
      assert.strictEqual(r.newEarnedAmount, 600, 'Urgent breach: 1140 → 600 (base only)');
      t.pass('recomputeOnBreach: Urgent breach drops earned_amount 1140 → 600');
    } catch (e) { t.fail('recomputeOnBreach Urgent breach path', e); }

  } finally {
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
