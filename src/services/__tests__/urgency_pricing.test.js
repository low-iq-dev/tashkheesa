'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var { computeOrderPricing, URGENCY_TIERS } = require('../urgency_pricing');

test('standard tier — no uplift, total equals base', function() {
  var r = computeOrderPricing({ basePrice: 3000, urgencyTier: 'standard' });
  assert.equal(r.basePrice, 3000);
  assert.equal(r.multiplier, 1.00);
  assert.equal(r.upliftAmount, 0);
  assert.equal(r.totalPrice, 3000);
});

test('VIP tier — default 1.30× multiplier when servicesRow has no override', function() {
  var r = computeOrderPricing({ basePrice: 3000, urgencyTier: 'vip' });
  assert.equal(r.basePrice, 3000);
  assert.equal(r.multiplier, 1.30);
  assert.equal(r.upliftAmount, 900);
  assert.equal(r.totalPrice, 3900);
});

test('Urgent tier — default 1.60× multiplier', function() {
  var r = computeOrderPricing({ basePrice: 3000, urgencyTier: 'urgent' });
  assert.equal(r.multiplier, 1.60);
  assert.equal(r.upliftAmount, 1800);
  assert.equal(r.totalPrice, 4800);
});

test('per-service override — vip_multiplier read from servicesRow', function() {
  var r = computeOrderPricing({
    basePrice: 1000,
    urgencyTier: 'vip',
    servicesRow: { vip_multiplier: 1.50 }
  });
  assert.equal(r.multiplier, 1.50);
  assert.equal(r.upliftAmount, 500);
  assert.equal(r.totalPrice, 1500);
});

test('edge case — multiplier = 1.0 from override produces zero uplift', function() {
  var r = computeOrderPricing({
    basePrice: 2500,
    urgencyTier: 'vip',
    servicesRow: { vip_multiplier: 1.00 }
  });
  assert.equal(r.multiplier, 1.00);
  assert.equal(r.upliftAmount, 0);
  assert.equal(r.totalPrice, 2500);
});

test('NULL override falls back to default', function() {
  var r = computeOrderPricing({
    basePrice: 1000,
    urgencyTier: 'urgent',
    servicesRow: { urgent_multiplier: null }
  });
  assert.equal(r.multiplier, 1.60);
});

test('rounding — base × multiplier produces clean 2dp totals', function() {
  // 1234 × 1.30 = 1604.20
  var r = computeOrderPricing({ basePrice: 1234, urgencyTier: 'vip' });
  assert.equal(r.totalPrice, 1604.20);
  assert.equal(r.upliftAmount, 370.20);
});

test('URGENCY_TIERS constants exported', function() {
  assert.equal(URGENCY_TIERS.STANDARD, 'standard');
  assert.equal(URGENCY_TIERS.VIP, 'vip');
  assert.equal(URGENCY_TIERS.URGENT, 'urgent');
});
