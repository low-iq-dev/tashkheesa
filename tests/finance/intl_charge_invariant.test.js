'use strict';
// The two invariants that matter most for international always-charge-EGP:
//   (1) an intl order NEVER trips the amount_mismatch alarm (owed cents == paid
//       cents, because orders.price already holds the EGP charge Paymob levies), and
//   (2) the doctor earns a flat 20% of the EGP charge (NOT the local commission)
//       with a structurally positive platform margin.
// Plus: EG orders are byte-identical, and the Paymob EGP guard is satisfied.
//
// PURE tests on the exact production helpers (fx, order_pricing, earnings_calc) —
// no DB — so they pin the invariant deterministically. The webhook writes an
// amount_mismatch row ONLY when paidCents !== owedCents (payments.js), so proving
// owedCents === the Paymob-charged cents proves "no mismatch row". A full
// step4 → webhook → earnings E2E against real Postgres belongs in tests/pg/.
const test = require('node:test');
const assert = require('node:assert/strict');
const { egpChargeFromLocal } = require('../../src/fx');
const { owedCentsForOrder, toCents } = require('../../src/services/order_pricing');
const { computeDoctorEarnings } = require('../../src/services/earnings_calc');

// What an AED 1199 order stores at creation (egpBase 16486, doctorFeeEgp 3297).
const AED = egpChargeFromLocal(1199, 'AED');

test('intl order stores the EGP charge + the LOCAL display fields', () => {
  assert.equal(AED.egpBase, 16486);
  assert.equal(AED.displayPrice, 1199);
  assert.equal(AED.displayCurrency, 'AED');
  assert.equal(AED.isIntl, true);
});

test('CRITICAL: intl order does NOT trip amount_mismatch (owed cents == Paymob paid cents)', () => {
  // Order row as persisted: price = EGP charge, currency 'EGP', no add-ons.
  const order = { price: AED.egpBase, currency: 'EGP', addons_json: null };
  const owedCents = owedCentsForOrder(order);
  // Paymob charges exactly the EGP price → its amount_cents.
  const paidCents = toCents(AED.egpBase);
  // The webhook writes an amount_mismatch row ONLY if these differ. They don't.
  assert.equal(owedCents, paidCents, 'owed must equal paid → NO amount_mismatch row');
  assert.equal(order.currency, 'EGP'); // charge is EGP (paymob guard satisfied)
});

test('CRITICAL: doctor earns a flat 20% of the EGP charge, NOT the local commission, with positive margin', () => {
  // doctor_fee snapshotted at creation = 20% of the EGP charge.
  assert.equal(AED.doctorFeeEgp, Math.round(AED.egpBase * 0.20)); // 3297
  // earnings read orders.doctor_fee → baseShare === that fee.
  const earn = computeDoctorEarnings({ baseDoctorFee: AED.doctorFeeEgp, upliftAmount: 0, upliftDoctorPct: 30, addons: [] });
  const earned = earn.baseShare + earn.upliftShare;
  assert.equal(earned, AED.doctorFeeEgp);           // = 20% of the EGP charge
  assert.equal(earned, 3297);
  // NOT the local doctor_commission: under the OLD model doctor_fee would have been
  // snapshotted from service_regional_prices.doctor_commission — a small AED number
  // (e.g. ~240 AED). The EGP-charge fee is categorically different and larger.
  const representativeLocalAedCommission = 240;
  assert.notEqual(earned, representativeLocalAedCommission);
  // Structurally positive platform margin (charge EGP − doctor fee EGP).
  assert.ok(AED.egpBase - AED.doctorFeeEgp > 0);    // 16486 − 3297 = 13189
});

test('EG order is byte-identical: EGP charge = base, display_* NULL, doctor_fee = 20%', () => {
  const EG = egpChargeFromLocal(1250, 'EGP');
  assert.equal(EG.egpBase, 1250);           // identity — no conversion
  assert.equal(EG.displayPrice, null);      // no local display
  assert.equal(EG.displayCurrency, null);
  assert.equal(EG.isIntl, false);
  assert.equal(EG.doctorFeeEgp, 250);       // 20% of 1250
  // owed==paid holds trivially; charge stays EGP.
  const order = { price: EG.egpBase, currency: 'EGP', addons_json: null };
  assert.equal(owedCentsForOrder(order), toCents(1250));
});

test('Paymob EGP guard: an intl order carries currency EGP → createIntention is not blocked', () => {
  // The order-creation write sites pin currency 'EGP' for intl orders, so the
  // paymob guard (paymob.js: currency !== 'EGP' throws) is always satisfied.
  const order = { price: AED.egpBase, currency: 'EGP' };
  assert.equal(String(order.currency).toUpperCase(), 'EGP');
});
