'use strict';
// tests/core/order-pricing-owed.test.js
//
// Unit tests for src/services/order_pricing.js — the single source of truth
// for the patient-charged amount (base price + persisted add-ons) in cents.
// Both the Paymob intention and the webhook amount-verification (audit B5)
// route through owedCentsForOrder(), so this math must be exact.

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n💰 order_pricing — owed cents (base + add-ons)\n');

const { toCents, parseSelectedAddons, owedCentsForOrder } = require('../../src/services/order_pricing');

function assertEq(actual, expected, label) {
  if (actual === expected) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error('expected ' + expected + ', got ' + actual));
}
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// toCents rounds to integer cents (no float drift).
assertEq(toCents(350), 35000, 'toCents(350) = 35000');
assertEq(toCents(349.5), 34950, 'toCents(349.5) = 34950');
assertEq(toCents('500'), 50000, "toCents('500') = 50000");
assertEq(toCents(null), 0, 'toCents(null) = 0');

// Base only — no add-ons persisted.
assertEq(owedCentsForOrder({ price: 500 }), 50000, 'base-only order owes price*100');
assertEq(owedCentsForOrder({ price: 500, addons_json: '{}' }), 50000, 'empty addons_json → base only');

// Base + prescription (persisted price from DB).
assertEq(
  owedCentsForOrder({ price: 500, addons_json: JSON.stringify({ prescription: true, prescription_price: 350 }) }),
  85000,
  'base 500 + prescription 350 = 85000 cents'
);

// Base + video (persisted via addons_json).
assertEq(
  owedCentsForOrder({ price: 600, addons_json: JSON.stringify({ video_consultation: true, video_consultation_price: 200 }) }),
  80000,
  'base 600 + video 200 = 80000 cents'
);

// Base + BOTH add-ons.
assertEq(
  owedCentsForOrder({ price: 500, addons_json: JSON.stringify({ video_consultation: true, video_consultation_price: 200, prescription: true, prescription_price: 350 }) }),
  105000,
  'base 500 + video 200 + prescription 350 = 105000 cents'
);

// Unselected add-ons with a price present must NOT be added.
assertEq(
  owedCentsForOrder({ price: 500, addons_json: JSON.stringify({ video_consultation: false, video_consultation_price: 200, prescription: false, prescription_price: 350 }) }),
  50000,
  'add-ons present-but-unselected are not charged'
);

// Legacy video columns (order created before addons_json) still counted.
assertEq(
  owedCentsForOrder({ price: 400, video_consultation_selected: true, video_consultation_price: 150 }),
  55000,
  'legacy video_consultation_selected column is honored'
);

// addons_json can arrive already-parsed (JSONB driver) — object, not string.
assertEq(
  owedCentsForOrder({ price: 500, addons_json: { prescription: true, prescription_price: 350 } }),
  85000,
  'pre-parsed addons_json object is handled'
);

// Malformed addons_json degrades to base only (never throws).
let threw = false;
try {
  assertEq(owedCentsForOrder({ price: 500, addons_json: 'not-json{' }), 50000, 'malformed addons_json → base only (no throw)');
} catch (_) { threw = true; }
assert(!threw, 'owedCentsForOrder never throws on malformed addons_json');

// parseSelectedAddons surfaces the booleans + locked prices.
const sel = parseSelectedAddons({ addons_json: JSON.stringify({ video_consultation: true, video_consultation_price: 200, prescription: false }) });
assert(sel.video_consultation === true && sel.prescription === false && sel.video_consultation_price === 200,
  'parseSelectedAddons returns booleans + locked prices',
  JSON.stringify(sel));
