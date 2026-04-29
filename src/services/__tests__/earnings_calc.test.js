'use strict';

/*
 * NOTE: These tests assume service.doctor_fee is set correctly to ~20%
 * of base_price per the canonical pricing spreadsheet
 * (docs/pricing/tashkheesa_pricing_v2.xlsx).  The earnings_calc module
 * reads doctor_fee as an absolute EGP value — it does NOT compute
 * baseShare = basePrice × 0.20 at runtime.  If the catalog data is
 * broken (NULL doctor_fee, or doctor_fee at 80% of base_price, etc.),
 * this code is correct but earnings will be wrong — that's a data
 * problem, not a code problem.  The fix is to re-sync the catalog
 * from the spreadsheet, not to change this module.
 *
 * The four §5 worked examples below assume base_price = 3,000 EGP and
 * doctor_fee = 600 EGP (= 20% of base).
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var { computeDoctorEarnings } = require('../earnings_calc');

test('Example A — Standard, no add-ons', function() {
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 0,
    upliftDoctorPct: 30,
    addons: []
  });
  assert.equal(r.baseShare, 600);
  assert.equal(r.upliftShare, 0);
  assert.deepEqual(r.addonShares, []);
  assert.equal(r.total, 600);
});

test('Example B — VIP, no add-ons', function() {
  // base 3000 × 1.3 = 3900; uplift = 900; doctor uplift share = 900 × 0.30 = 270
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 900,
    upliftDoctorPct: 30,
    addons: []
  });
  assert.equal(r.baseShare, 600);
  assert.equal(r.upliftShare, 270);
  assert.equal(r.total, 870);
});

test('Example C — Urgent + video consult add-on', function() {
  // base 3000 × 1.6 = 4800; uplift = 1800; doctor uplift = 1800 × 0.30 = 540
  // video addon 1000 @ 85% = 850
  // total = 600 + 540 + 850 = 1990
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 1800,
    upliftDoctorPct: 30,
    addons: [
      { id: 'video_consult', price_at_purchase_egp: 1000, doctor_commission_pct_at_purchase: 85 }
    ]
  });
  assert.equal(r.baseShare, 600);
  assert.equal(r.upliftShare, 540);
  assert.equal(r.addonShares.length, 1);
  assert.equal(r.addonShares[0].addon_id, 'video_consult');
  assert.equal(r.addonShares[0].share, 850);
  assert.equal(r.total, 1990);
});

test('Example D — VIP breached (post-refund earnings recalc)', function() {
  // After breach: uplift refunded → upliftAmount passed as 0;
  // doctor earns base only.
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 0,
    upliftDoctorPct: 30,
    addons: []
  });
  assert.equal(r.baseShare, 600);
  assert.equal(r.upliftShare, 0);
  assert.equal(r.total, 600);
});

test('multiple add-ons combine correctly', function() {
  // video 1000 @ 85% = 850 + prescription 500 @ 50% = 250 → addons total 1100
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 0,
    addons: [
      { id: 'video_consult', price_at_purchase_egp: 1000, doctor_commission_pct_at_purchase: 85 },
      { id: 'prescription', price_at_purchase_egp: 500, doctor_commission_pct_at_purchase: 50 }
    ]
  });
  assert.equal(r.addonShares.length, 2);
  assert.equal(r.addonShares[0].share, 850);
  assert.equal(r.addonShares[1].share, 250);
  assert.equal(r.total, 1700);
});

test('per-service uplift override — 50% upliftDoctorPct', function() {
  var r = computeDoctorEarnings({
    baseDoctorFee: 600,
    upliftAmount: 900,
    upliftDoctorPct: 50,
    addons: []
  });
  assert.equal(r.upliftShare, 450);
  assert.equal(r.total, 1050);
});

test('NULL / missing doctor_fee defaults to 0 (catches catalog bug)', function() {
  var r = computeDoctorEarnings({
    baseDoctorFee: null,
    upliftAmount: 900,
    upliftDoctorPct: 30
  });
  assert.equal(r.baseShare, 0);
  // uplift share still computes — base bug doesn't break uplift split
  assert.equal(r.upliftShare, 270);
  assert.equal(r.total, 270);
});
