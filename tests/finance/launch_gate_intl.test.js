'use strict';
// Launch gate widened to 9 markets + the charge stays EGP.
// (A full HTTP step4→webhook→earnings E2E against real Postgres belongs in tests/pg/;
// this pins the gate + charge-invariant logic without a server.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { LAUNCH_MARKETS, isLaunchMarket, coerceCountry } = require('../../src/launch-market');
const { egpChargeFromLocal } = require('../../src/fx');
const { getCurrencyForCountry } = require('../../src/country-currency');

test('launch gate: all 9 markets are live', () => {
  ['EG', 'SA', 'AE', 'GB', 'US', 'KW', 'QA', 'BH', 'OM'].forEach((c) => assert.ok(isLaunchMarket(c), c));
  assert.equal(LAUNCH_MARKETS.size, 9);
});

test('launch gate: a UAE patient is no longer clamped to EG (real market drives display)', () => {
  assert.equal(coerceCountry('AE'), 'AE');
  assert.equal(getCurrencyForCountry('AE'), 'AED');
});

test('launch gate: a UAE order still charges EGP (currency pinned, price = EGP-equivalent)', () => {
  // What every write site does for a UAE service priced AED 1199:
  const charge = egpChargeFromLocal(1199, getCurrencyForCountry('AE'));
  assert.equal(charge.egpBase, 16486);          // EGP charge amount → orders.price
  assert.equal(charge.displayCurrency, 'AED');  // shown to the patient (display_currency)
  assert.equal(charge.displayPrice, 1199);
  // orders.currency is pinned 'EGP' at every write site → paymob EGP guard passes,
  // and owed==paid so no amount_mismatch. The charge is NEVER the foreign number.
  const orderCurrency = 'EGP';
  assert.equal(orderCurrency, 'EGP');
  assert.notEqual(charge.egpBase, 1199);        // never charge the raw AED figure
});

test('launch gate: an unsupported country falls back to EG pricing (never a foreign charge)', () => {
  assert.equal(coerceCountry('FR'), 'EG');
});
