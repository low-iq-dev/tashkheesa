// tests/services/earnings_writer.test.js
//
// Integration tests for src/services/earnings_writer.js — the wiring
// of computeDoctorEarnings into the doctor_earnings table at the
// three P0-FIN-1 sites.
//
// Scenarios (BATCH B 2026-09-21: completion SETTLES at 'pending'; only the
// month-end payout run — markMonthEndPaid — writes status='paid'/paid_at):
//   1. writePendingForCase inserts a pending row with the right
//      base+uplift split using policy worked-example B (VIP, no addons).
//   2. writePendingForCase is idempotent (second call returns
//      already_exists, no duplicate row).
//   3. settleCaseEarningsOnCompletion settles the amount and the row STAYS
//      'pending' with paid_at null.
//   4. settleCaseEarningsOnCompletion on a legacy order (no pending row)
//      inserts directly with status='pending'.
//   5. recomputeOnBreach drops earned_amount to base-only when uplift
//      is zeroed — policy worked-example D (VIP breached): 870 → 600.
//   6. recomputeOnBreach is a no-op + skip signal when no row exists.
//   7-8. Urgent-tier variants of 1 and 5.
//   9. markMonthEndPaid stamps the completed Cairo month's pending rows
//      'paid' (paid_at set), skips in-flight rows (no completed_at), and is
//      idempotent.
//  10. settleCaseEarningsOnCompletion never demotes or recomputes a row the
//      payout already stamped 'paid'.
//  11. recomputeOnRefund reason='sla_breach' clamps to base-only (the uplift
//      reversal) — it does NOT zero the base (decisions table 2026-09-15).
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

module.exports = (async function run() {
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

    // ── 3. settleCaseEarningsOnCompletion — the row STAYS pending
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      await earningsWriter.writePendingForCase(orderId);

      const r = await earningsWriter.settleCaseEarningsOnCompletion(orderId, doctorId);
      assert.ok(r && r.updated, 'should report updated=true; got: ' + JSON.stringify(r));
      assert.strictEqual(r.settledStatus, 'pending', 'settles at pending, not paid');

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(row.status, 'pending', 'status stays pending — paid means the payout ran');
      assert.strictEqual(row.paid_at, null, 'paid_at NOT set at completion');
      assert.strictEqual(Number(row.earned_amount), 870, 'earned_amount settled at 870');
      t.pass('settleCaseEarningsOnCompletion: amount settled, row stays pending, no paid_at');
    } catch (e) { t.fail('settleCaseEarningsOnCompletion happy path', e); }

    // ── 4. settleCaseEarningsOnCompletion on a legacy order (no pre-existing row)
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 0 });
      // No writePendingForCase call — simulate legacy completion.

      const r = await earningsWriter.settleCaseEarningsOnCompletion(orderId, doctorId);
      assert.ok(r && r.inserted_legacy, 'should report inserted_legacy=true; got: ' + JSON.stringify(r));

      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(row.status, 'pending', 'legacy row inserted with status=pending');
      assert.strictEqual(row.paid_at, null, 'no paid_at on the legacy insert either');
      assert.strictEqual(Number(row.earned_amount), 600, 'standard tier earned_amount = 600');
      t.pass('settleCaseEarningsOnCompletion: legacy order → INSERT directly with status=pending');
    } catch (e) { t.fail('settleCaseEarningsOnCompletion legacy path', e); }

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

    // ── 9. markMonthEndPaid — the only writer of 'paid', completed rows only
    try {
      const monthRow = await queryOne(
        `SELECT to_char(date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM') AS m`
      );
      const cairoMonth = monthRow.m;

      // A completed case this Cairo month…
      const doneOrder = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 0 });
      await earningsWriter.writePendingForCase(doneOrder);
      await earningsWriter.settleCaseEarningsOnCompletion(doneOrder, doctorId);
      await execute(`UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`, [doneOrder]);
      // …and an in-flight case (accepted, not delivered).
      const openOrder = await insertPaidOrder({ doctorId, doctorFee: 400, upliftAmount: 0 });
      await earningsWriter.writePendingForCase(openOrder);

      const r = await earningsWriter.markMonthEndPaid({ month: cairoMonth, doctorId, actor: 'test' });
      assert.ok(r && r.marked, 'marked=true: ' + JSON.stringify(r));
      assert.ok(r.caseRows >= 1, 'at least the completed row stamped');

      const doneRow = await getMainEarningsRow(doneOrder, doctorId);
      assert.strictEqual(doneRow.status, 'paid', 'completed-case row stamped paid');
      assert.ok(doneRow.paid_at, 'paid_at set by the payout run');
      const openRow = await getMainEarningsRow(openOrder, doctorId);
      assert.strictEqual(openRow.status, 'pending', 'in-flight row NEVER stamped (no completed_at)');
      assert.strictEqual(openRow.paid_at, null, 'in-flight row has no paid_at');

      // Idempotent: re-running the month stamps nothing new for this doctor's
      // completed row (the open one still has no completed_at).
      const r2 = await earningsWriter.markMonthEndPaid({ month: cairoMonth, doctorId, actor: 'test' });
      assert.strictEqual(r2.caseRows, 0, 're-run stamps 0 rows: ' + JSON.stringify(r2));

      // Guard rails.
      const bad = await earningsWriter.markMonthEndPaid({ month: '2026-13' });
      assert.strictEqual(bad.skipped, 'invalid_month', 'invalid month refused');
      const fut = await earningsWriter.markMonthEndPaid({ month: '2099-01' });
      assert.strictEqual(fut.skipped, 'month_in_future', 'future month refused');
      t.pass('markMonthEndPaid: stamps completed Cairo-month rows only, idempotent, validated');
    } catch (e) { t.fail('markMonthEndPaid', e); }

    // ── 10. Completion never touches a row the payout already stamped
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 500, upliftAmount: 0 });
      await earningsWriter.writePendingForCase(orderId);
      await earningsWriter.settleCaseEarningsOnCompletion(orderId, doctorId);
      await execute(`UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = $1`, [orderId]);
      const monthRow = await queryOne(
        `SELECT to_char(date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM') AS m`
      );
      await earningsWriter.markMonthEndPaid({ month: monthRow.m, doctorId, actor: 'test' });

      const r = await earningsWriter.settleCaseEarningsOnCompletion(orderId, doctorId);
      assert.strictEqual(r.skipped, 'already_paid_out', 'settle after payout skips: ' + JSON.stringify(r));
      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(row.status, 'paid', 'row stays paid');
      assert.strictEqual(Number(row.earned_amount), 500, 'settled cash never recomputed');
      t.pass('settleCaseEarningsOnCompletion: a paid-out row is settled cash — never demoted or recomputed');
    } catch (e) { t.fail('settle-after-payout guard', e); }

    // ── 11. recomputeOnRefund sla_breach = uplift reversal, base stands
    try {
      const orderId = await insertPaidOrder({ doctorId, doctorFee: 600, upliftAmount: 900 });
      await earningsWriter.writePendingForCase(orderId);
      // The breach refund zeroes the uplift on the order (sla_breach.js does
      // this in production), then the refund's mark-paid fires this hook.
      await execute(`UPDATE orders SET urgency_uplift_amount = 0 WHERE id = $1`, [orderId]);

      const r = await earningsWriter.recomputeOnRefund(orderId, { reason: 'sla_breach' });
      assert.ok(r && r.recomputed, 'recomputed=true: ' + JSON.stringify(r));
      assert.strictEqual(r.newEarnedAmount, 600,
        'sla_breach settlement leaves the BASE fee (600), not zero — the uplift only is reversed');
      assert.strictEqual(r.policyApplied, earningsWriter.BREACH_UPLIFT_CLAWBACK,
        'stamped with the uplift-reversal marker, not the retired full-clawback policy');
      const row = await getMainEarningsRow(orderId, doctorId);
      assert.strictEqual(Number(row.earned_amount), 600, 'DB row keeps the base fee');
      t.pass('recomputeOnRefund sla_breach: base fee stands — decisions table 2026-09-15');
    } catch (e) { t.fail('recomputeOnRefund sla_breach uplift-only', e); }

  } finally {
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
