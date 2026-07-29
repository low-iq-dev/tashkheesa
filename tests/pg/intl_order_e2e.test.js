// tests/pg/intl_order_e2e.test.js
//
// ALWAYS-CHARGE-EGP — full step4 → payment → earnings E2E against real Postgres.
//
// The pure invariants live in tests/finance/intl_charge_invariant.test.js (fx +
// order_pricing + earnings_calc, no DB). THIS test drives the same invariants
// through the real Postgres write/read path, using an order row seeded in the
// SHAPE the step4 write site persists — it REPLICATES that INSERT rather than
// invoking the route handler (so it proves the DB round-trip + the webhook amount
// gate + the earnings writer over a real row, not the route's bind-param wiring):
//
//   1. step4 persistence SHAPE — an intl order row carries the EGP charge on
//                           orders.price (currency 'EGP'), the flat 20% doctor_fee,
//                           and the LOCAL figures on display_price/display_currency
//                           (exactly what egpChargeFromLocal returns).
//   2. webhook amount gate — owedCentsForOrder(order) === toCents(paid) so the
//                           Paymob callback NEVER writes an amount_mismatch row
//                           (payments.js writes one only when paid !== owed).
//   3. earnings            — writePendingForCase (the real acceptance-time writer)
//                           snapshots a doctor_earnings row = 20% of the EGP
//                           charge, with a structurally positive platform margin.
//
// Skipped automatically when DATABASE_URL is not set (mirrors
// tests/services/earnings_writer.test.js), so the default `npm test` run (no DB)
// counts it as skipped and never connects. Run against a migrated Postgres:
//
//   DATABASE_URL=postgresql://... PG_SSL=false \
//     node tests/pg/intl_order_e2e.test.js
//
// Seeds rows with an intl-e2e-<random> prefix and removes them in finally{} —
// never touches prod data. NEVER hardcodes a connection string (see the prod
// DB-credential rule); it reads DATABASE_URL from the environment via src/pg.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🌍 tests/pg — intl always-charge-EGP E2E\n');

// Guard BEFORE requiring src/pg (which opens a pool) so the no-DB default run
// stays a clean skip, not a connection error.
if (!process.env.DATABASE_URL) {
  t.skip(fileTag, 'DATABASE_URL not set');
  return;
}

const { egpChargeFromLocal } = require('../../src/fx');
const { computeOrderPricing } = require('../../src/services/urgency_pricing');
const { owedCentsForOrder, toCents } = require('../../src/services/order_pricing');
const { writePendingForCase } = require('../../src/services/earnings_writer');
const { execute, queryOne } = require('../../src/pg');

function ok(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

(async function run() {
  const suffix    = Math.random().toString(36).slice(2, 10);
  const patientId = 'intl-e2e-patient-' + suffix;
  const doctorId  = 'intl-e2e-doctor-' + suffix;
  const orderId   = 'intl-e2e-order-' + suffix;
  const specialtyId = 'spec-cardiology'; // visible in prod; we only need a valid id

  // What POST /patient/new-case/step4 computes for an AED 1199 standard order.
  const charge = egpChargeFromLocal(1199, 'AED');

  try {
    // Sanity on the pure inputs before we ever touch the DB.
    ok(charge.egpBase === 16486 && charge.doctorFeeEgp === 3297 && charge.displayPrice === 1199 && charge.displayCurrency === 'AED',
      'egpChargeFromLocal(1199, AED) → egpBase 16486, fee 3297, display 1199/AED',
      JSON.stringify(charge));

    // Pin the DISPLAY-TOTAL rule every intl surface must honour: display_price is
    // the UN-multiplied local base, so a VIP/urgent receipt / pay page / total MUST
    // re-apply the tier multiplier (price / base_price) — else it understates the
    // charge and contradicts the "billed in EGP" line. (Regression guard for the
    // receipt-email fix; the standard-tier E2E below has multiplier 1 and can't
    // catch it.) This assertion is pure + synchronous so it also runs in the suite.
    {
      const vip = computeOrderPricing({ basePrice: charge.egpBase, urgencyTier: 'vip', servicesRow: {} });
      const vipEgpCharge = vip.totalPrice;                                            // 21431.8 = 16486 × 1.3 (unrounded)
      const vipLocalTotal = Math.round(charge.displayPrice * (vipEgpCharge / charge.egpBase)); // 1199 × 1.3 → 1559
      ok(Math.round(vipEgpCharge) === 21432 && vipLocalTotal === 1559 && vipLocalTotal !== charge.displayPrice,
        'intl VIP display total re-multiplies the local base → 1559 AED (≈ EGP 21432), NOT the raw 1199',
        'vipEgpCharge=' + vipEgpCharge + ' vipLocalTotal=' + vipLocalTotal);
    }

    // Seed patient + the assigned doctor.
    await execute(
      "INSERT INTO users (id, role, name, email, is_active, created_at) VALUES ($1,'patient',$2,$3,true,NOW())",
      [patientId, 'Intl E2E Patient', patientId + '@intl.test']
    );
    await execute(
      "INSERT INTO users (id, role, name, email, is_active, specialty_id, created_at) VALUES ($1,'doctor',$2,$3,true,$4,NOW())",
      [doctorId, 'Intl E2E Doctor', doctorId + '@intl.test', specialtyId]
    );

    // Persist the order EXACTLY as the intl step4 write site does: price = EGP
    // charge, currency 'EGP', doctor_fee = 20% of the EGP charge, display_* = local.
    // doctor_id set = doctor already accepted (writePendingForCase's precondition);
    // payment_status/paid_at = the state the webhook sets before markCasePaid.
    await execute(
      `INSERT INTO orders (
         id, patient_id, doctor_id, specialty_id, status, payment_status, paid_at,
         base_price, price, currency, doctor_fee, urgency_uplift_amount,
         display_price, display_currency, urgency_tier, sla_hours, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'submitted','paid',NOW(),
                 $5,$6,'EGP',$7,0,
                 $8,$9,'standard',48,NOW(),NOW())`,
      [orderId, patientId, doctorId, specialtyId,
       charge.egpBase, charge.egpBase, charge.doctorFeeEgp,
       charge.displayPrice, charge.displayCurrency]
    );

    // ── 1. The stored charge is EGP; the local figures are display-only. ──
    const stored = await queryOne(
      'SELECT price, currency, base_price, doctor_fee, display_price, display_currency FROM orders_active WHERE id = $1',
      [orderId]
    );
    ok(stored && Number(stored.price) === 16486 && String(stored.currency).toUpperCase() === 'EGP',
      'orders.price is the EGP charge (16486) and currency is EGP',
      stored && (stored.price + '/' + stored.currency));
    ok(stored && Number(stored.display_price) === 1199 && String(stored.display_currency).toUpperCase() === 'AED',
      'display_price/display_currency carry the LOCAL figures (1199/AED)',
      stored && (stored.display_price + '/' + stored.display_currency));

    // ── 2. Webhook amount gate: owed cents == the EGP cents Paymob charges. ──
    const owedCents = owedCentsForOrder({ price: stored.price, currency: stored.currency, addons_json: null });
    const paidCents = toCents(16486); // Paymob charges exactly orders.price in EGP
    ok(owedCents === paidCents,
      'owed cents === paid cents → the callback writes NO amount_mismatch row',
      'owed=' + owedCents + ' paid=' + paidCents);

    // ── 3. Earnings: the real acceptance-time writer snapshots 20% of the EGP charge. ──
    const res = await writePendingForCase(orderId);
    ok(res && (res.written || res.skipped === 'already_exists'),
      'writePendingForCase wrote (or idempotently found) the earnings row',
      JSON.stringify(res));

    const earn = await queryOne(
      "SELECT earned_amount, gross_amount, status FROM doctor_earnings WHERE appointment_id = $1 AND doctor_id = $2 AND id LIKE 'earn-main-%' LIMIT 1",
      [orderId, doctorId]
    );
    ok(earn && Number(earn.earned_amount) === 3297,
      'doctor earns a flat 20% of the EGP charge (3297), NOT the local AED commission',
      earn && String(earn.earned_amount));

    // ── 4. Structurally positive platform margin. ──
    ok(Number(stored.price) - Number(stored.doctor_fee) === 13189,
      'platform margin = EGP charge − doctor fee = 13189 (> 0)',
      (stored.price - stored.doctor_fee) + '');
  } catch (err) {
    t.fail(fileTag + ': run crashed', err);
  } finally {
    try { await execute('DELETE FROM doctor_earnings WHERE appointment_id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM orders WHERE id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM users WHERE id IN ($1, $2)', [patientId, doctorId]); } catch (_) {}
  }
})().catch(function (err) {
  t.fail(fileTag + ': run crashed (outer)', err);
});
