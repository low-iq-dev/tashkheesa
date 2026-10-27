// tests/services/recompute-on-refund.test.js
//
// Side issue #43 — Doctor earnings clawback policy.
//
// Covers recomputeOnRefund(orderId, { reason }) in src/services/earnings_writer.js.
// Hooks decoupled from recomputeOnBreach by design — see commit message.
//
// Policy — as documented above recomputeOnRefund (decided 2026-05-12, revised
// by the AUDIT 2026-08-17 scaling and the Batch B decisions table 2026-09-15;
// this file was updated to it on 2026-10-27):
//   - reason='sla_breach'           → base stands, the urgency uplift is
//                                     reversed ('sla_breach_uplift_zeroed'). A
//                                     write-down stage, not a finished clawback:
//                                     a later refund still claws back.
//   - reason='patient_request' OR
//     reason='operator_refund'      → full × (1 − 0.9 × refundRatio), where
//                                     refundRatio = refund / case fee (orders.price);
//                                     no refund amount → ratio 1, i.e. keep 10%
//                                     ('patient_or_operator_post_acceptance_scaled_90pct_clawback')
//   - any reason + NO earnings row  → skip (pre-acceptance, doctor never engaged)
//   - a finished clawback already stamped → skip (idempotent)
//
// Skips when DATABASE_URL is unset (mirrors other DB tests in tests/finance/
// and tests/services/).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💰 Side issue #43 — recomputeOnRefund doctor-earnings clawback\n');

if (!process.env.DATABASE_URL) {
  t.skip(path.basename(__filename, '.test.js'), 'DATABASE_URL not set');
  return;
}

const PREFIX = 'test-fin43-' + crypto.randomBytes(3).toString('hex') + '-';
const DOCTOR = PREFIX + 'doc';
const PATIENT = PREFIX + 'pat';
const ORDER_SLA = PREFIX + 'order-sla';
const ORDER_PATIENT_REQ = PREFIX + 'order-pat';
const ORDER_OPERATOR = PREFIX + 'order-op';
const ORDER_PRE_ACCEPT = PREFIX + 'order-pre';
const ORDER_IDEMPOTENT = PREFIX + 'order-idem';
const ORDER_UNKNOWN = PREFIX + 'order-unk';
const ORDER_PARTIAL = PREFIX + 'order-part';
const ORDER_BREACH_THEN_REFUND = PREFIX + 'order-btr';

const { execute, queryOne } = require('../../src/pg');
const { recomputeOnRefund, MAIN_EARNINGS_PREFIX, BREACH_UPLIFT_CLAWBACK } = require('../../src/services/earnings_writer');
const SCALED_REFUND_CLAWBACK = 'patient_or_operator_post_acceptance_scaled_90pct_clawback';

async function cleanup() {
  await execute(`DELETE FROM doctor_earnings WHERE appointment_id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']).catch(() => {});
}

async function seedDoctor(id) {
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
     VALUES ($1, $2, NULL, $3, 'doctor', 'en', true, NOW())`,
    [id, id + '@test.local', 'Dr ' + id]
  );
}

async function seedPatient(id) {
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
     VALUES ($1, $2, NULL, 'Test Patient', 'patient', 'en', true, NOW())`,
    [id, id + '@test.local']
  );
}

async function seedOrder(orderId, patientId, doctorId, doctorFee, upliftAmount) {
  await execute(
    `INSERT INTO orders (id, patient_id, doctor_id, doctor_fee, urgency_uplift_amount,
                         price, status, payment_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'in_review', 'paid', NOW(), NOW())`,
    [orderId, patientId, doctorId, doctorFee, upliftAmount || 0, doctorFee + 100]
  );
}

async function seedPendingEarnings(orderId, doctorId, earnedAmount) {
  const id = MAIN_EARNINGS_PREFIX + crypto.randomUUID();
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
     VALUES ($1, $2, $3, $4, 100, $4, 'pending', NOW())`,
    [id, doctorId, orderId, earnedAmount]
  );
  return id;
}

module.exports = (async function run() {
  try {
    await cleanup();
    await seedPatient(PATIENT);
    await seedDoctor(DOCTOR);

    // ── 1. SLA breach → the uplift is reversed, the base stands
    //     computeDoctorEarnings({baseDoctorFee:200, upliftAmount:50, upliftDoctorPct:30})
    //       full = 200 + 50*0.30 = 215; base-only = 200
    try {
      await seedOrder(ORDER_SLA, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 50);
      const earningsId = await seedPendingEarnings(ORDER_SLA, DOCTOR, 215);
      const r = await recomputeOnRefund(ORDER_SLA, { reason: 'sla_breach' });
      assert.ok(r.recomputed, 'recomputed=true: ' + JSON.stringify(r));
      assert.strictEqual(r.earningsId, earningsId, 'earningsId matches');
      assert.strictEqual(r.newEarnedAmount, 200, 'base 200 stands, uplift share 15 reversed: ' + r.newEarnedAmount);
      assert.strictEqual(r.policyApplied, BREACH_UPLIFT_CLAWBACK, 'policy stamped');
      const row = await queryOne('SELECT earned_amount, clawback_reason, clawback_applied_at FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(Number(row.earned_amount), 200, 'DB earned_amount=200');
      assert.strictEqual(row.clawback_reason, BREACH_UPLIFT_CLAWBACK, 'DB clawback_reason stamped');
      assert.ok(row.clawback_applied_at, 'DB clawback_applied_at set');
      t.pass('sla_breach: uplift reversed, base stands (215 → 200, audit columns set)');
    } catch (e) { t.fail('sla_breach path', e); }

    // ── 2. patient_request post-acceptance, no refund amount → keep 10%
    try {
      await seedOrder(ORDER_PATIENT_REQ, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 50);
      const earningsId = await seedPendingEarnings(ORDER_PATIENT_REQ, DOCTOR, 200);
      const r = await recomputeOnRefund(ORDER_PATIENT_REQ, { reason: 'patient_request' });
      assert.ok(r.recomputed, 'recomputed=true: ' + JSON.stringify(r));
      // No refundAmountEgp → refundRatio 1 (the deliberate fallback towards
      // the platform) → keep 10% of full = 10% of (200 + 50*0.30) = 21.5
      assert.strictEqual(r.refundRatio, 1, 'no refund amount → ratio 1');
      assert.strictEqual(r.newEarnedAmount, 21.5, '10% of (200 + 50*0.30) = 21.5, got: ' + r.newEarnedAmount);
      assert.strictEqual(r.policyApplied, SCALED_REFUND_CLAWBACK, 'policy stamped');
      const row = await queryOne('SELECT earned_amount, clawback_reason FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(Number(row.earned_amount), 21.5, 'DB earned_amount=21.5');
      assert.strictEqual(row.clawback_reason, SCALED_REFUND_CLAWBACK, 'DB clawback_reason stamped');
      t.pass('patient_request post-acceptance, full refund: keep 10% (earned_amount=21.5)');
    } catch (e) { t.fail('patient_request path', e); }

    // ── 2b. A partial refund claws back proportionally (AUDIT 2026-08-17)
    //     case fee = orders.price = 300; refund 150 → ratio 0.5
    //     215 × (1 − 0.9 × 0.5) = 118.25
    try {
      await seedOrder(ORDER_PARTIAL, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 50);
      await seedPendingEarnings(ORDER_PARTIAL, DOCTOR, 215);
      const r = await recomputeOnRefund(ORDER_PARTIAL, { reason: 'patient_request', refundAmountEgp: 150 });
      assert.ok(r.recomputed, 'recomputed=true: ' + JSON.stringify(r));
      assert.strictEqual(r.refundRatio, 0.5, 'ratio = 150 / 300');
      assert.strictEqual(r.newEarnedAmount, 118.25, '215 × 0.55 = 118.25, got: ' + r.newEarnedAmount);
      t.pass('partial refund: half the case fee back → doctor keeps 55% (118.25)');
    } catch (e) { t.fail('partial refund path', e); }

    // ── 3. operator_refund post-acceptance → same policy as patient_request
    try {
      await seedOrder(ORDER_OPERATOR, PATIENT, DOCTOR, /*fee*/ 300, /*uplift*/ 0);
      const earningsId = await seedPendingEarnings(ORDER_OPERATOR, DOCTOR, 300);
      const r = await recomputeOnRefund(ORDER_OPERATOR, { reason: 'operator_refund' });
      assert.ok(r.recomputed, 'recomputed=true: ' + JSON.stringify(r) + ' ' + earningsId);
      // base 300, uplift 0, no refund amount → keep 10% = 30
      assert.strictEqual(r.newEarnedAmount, 30, '10% of 300 = 30, got: ' + r.newEarnedAmount);
      assert.strictEqual(r.policyApplied, SCALED_REFUND_CLAWBACK, 'same policy as patient_request');
      t.pass('operator_refund post-acceptance: same policy as patient_request');
    } catch (e) { t.fail('operator_refund path', e); }

    // ── 4. Pre-acceptance (NO earnings row exists) → skip
    try {
      await seedOrder(ORDER_PRE_ACCEPT, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 0);
      // No seedPendingEarnings call — simulating pre-doctor-acceptance state.
      const r = await recomputeOnRefund(ORDER_PRE_ACCEPT, { reason: 'patient_request' });
      assert.ok(r.skipped, 'skipped=truthy: ' + JSON.stringify(r));
      assert.strictEqual(r.skipped, 'pre_acceptance_no_earnings_row', 'correct skip reason');
      t.pass('pre-acceptance: skipped cleanly without touching anything');
    } catch (e) { t.fail('pre-acceptance path', e); }

    // ── 5. Idempotency — a second refund on an already-clawed row is skipped
    try {
      await seedOrder(ORDER_IDEMPOTENT, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 0);
      const earningsId = await seedPendingEarnings(ORDER_IDEMPOTENT, DOCTOR, 200);
      // First call applies the clawback: keep 10% of 200.
      await recomputeOnRefund(ORDER_IDEMPOTENT, { reason: 'patient_request' });
      const after1 = await queryOne('SELECT earned_amount, clawback_applied_at FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(Number(after1.earned_amount), 20, '1st call: earned=20');
      const firstStamp = after1.clawback_applied_at;
      assert.ok(firstStamp, '1st call set clawback_applied_at');

      // Second call (a double-click on mark-paid): skipped.
      const r2 = await recomputeOnRefund(ORDER_IDEMPOTENT, { reason: 'patient_request' });
      assert.ok(r2.skipped, '2nd call skipped: ' + JSON.stringify(r2));
      assert.strictEqual(r2.skipped, 'clawback_already_applied', 'correct skip reason');
      assert.strictEqual(r2.earningsId, earningsId, 'returns the existing row id');
      const after2 = await queryOne('SELECT earned_amount, clawback_applied_at FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(Number(after2.earned_amount), 20, '2nd call: earned still 20 (not mutated)');
      assert.strictEqual(new Date(after2.clawback_applied_at).getTime(), new Date(firstStamp).getTime(),
        '2nd call: clawback_applied_at unchanged (no row mutation)');
      t.pass('idempotency: 2nd refund returns skipped, row unchanged');
    } catch (e) { t.fail('idempotency', e); }

    // ── 5b. A breach write-down is a stage, not a finished clawback: a refund
    //     afterwards still claws back (and never raises what the row holds).
    try {
      await seedOrder(ORDER_BREACH_THEN_REFUND, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 50);
      const earningsId = await seedPendingEarnings(ORDER_BREACH_THEN_REFUND, DOCTOR, 215);
      const r1 = await recomputeOnRefund(ORDER_BREACH_THEN_REFUND, { reason: 'sla_breach' });
      assert.strictEqual(r1.newEarnedAmount, 200, 'breach write-down: 200');
      const r2 = await recomputeOnRefund(ORDER_BREACH_THEN_REFUND, { reason: 'patient_request' });
      assert.ok(r2.recomputed, 'refund after a breach write-down is applied, not skipped: ' + JSON.stringify(r2));
      assert.strictEqual(r2.newEarnedAmount, 21.5, 'then the refund clawback: 10% of 215 = 21.5');
      const row = await queryOne('SELECT earned_amount, clawback_reason FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(row.clawback_reason, SCALED_REFUND_CLAWBACK, 'the finished clawback is what the row records');
      t.pass('breach then refund: the write-down does not block the refund clawback (215 → 200 → 21.5)');
    } catch (e) { t.fail('breach then refund', e); }

    // ── 6. Unknown reason → fail loud (skipped, with reason)
    try {
      await seedOrder(ORDER_UNKNOWN, PATIENT, DOCTOR, /*fee*/ 200, /*uplift*/ 0);
      const earningsId = await seedPendingEarnings(ORDER_UNKNOWN, DOCTOR, 200);
      const r = await recomputeOnRefund(ORDER_UNKNOWN, { reason: 'fraudulent_chargeback' });
      assert.ok(r.skipped, 'unknown reason → skipped: ' + JSON.stringify(r));
      assert.strictEqual(r.skipped, 'unrecognised_reason', 'correct skip code');
      const row = await queryOne('SELECT earned_amount, clawback_applied_at FROM doctor_earnings WHERE id = $1', [earningsId]);
      assert.strictEqual(Number(row.earned_amount), 200, 'unknown reason did NOT mutate earned_amount');
      assert.strictEqual(row.clawback_applied_at, null, 'unknown reason did NOT set clawback_applied_at');
      t.pass('unknown reason: skipped without mutating the row');
    } catch (e) { t.fail('unknown reason path', e); }

    // ── 7. Wiring lint — assert the mark-paid handler invokes recomputeOnRefund
    //     (lighter than booting a server + auth flow; catches the regression
    //     class of "someone removed the call from the handler accidentally")
    try {
      const fs = require('fs');
      const handlerSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js'),
        'utf8'
      );
      // Locate mark-paid handler region.
      const markPaidStart = handlerSrc.indexOf("router.post('/superadmin/refunds/:id/mark-paid'");
      assert.ok(markPaidStart > 0, 'mark-paid handler exists');
      const markPaidEnd = handlerSrc.indexOf("module.exports", markPaidStart);
      const handlerBody = handlerSrc.slice(markPaidStart, markPaidEnd);
      assert.ok(
        /require\(['"]\.\.\/services\/earnings_writer['"]\)/.test(handlerBody),
        'mark-paid handler require()s services/earnings_writer'
      );
      assert.ok(
        /recomputeOnRefund\s*\(\s*refund\.order_id\s*,/.test(handlerBody),
        'mark-paid handler invokes recomputeOnRefund(refund.order_id, ...)'
      );
      assert.ok(
        /reason:\s*refundRow\.reason/.test(handlerBody),
        'mark-paid handler passes refundRow.reason (not a hardcoded value)'
      );
      t.pass('wiring lint: mark-paid handler invokes recomputeOnRefund with the refund row reason');
    } catch (e) { t.fail('wiring lint', e); }
  } finally {
    await cleanup();
  }
})();
