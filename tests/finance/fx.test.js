'use strict';
// FX module — international always-charge-EGP conversion (src/fx.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { toEgp, hasRate, DOCTOR_SPLIT_PCT } = require('../../src/fx');

test('toEgp: converts each of the 8 international currencies at the locked rate', () => {
  assert.equal(toEgp(100, 'USD'), Math.round(100 * 50.5));
  assert.equal(toEgp(100, 'GBP'), Math.round(100 * 68.7));
  assert.equal(toEgp(1199, 'AED'), Math.round(1199 * 13.75)); // 16486
  assert.equal(toEgp(100, 'SAR'), Math.round(100 * 13.47));
  assert.equal(toEgp(100, 'QAR'), Math.round(100 * 13.87));
  assert.equal(toEgp(100, 'KWD'), Math.round(100 * 165.8));
  assert.equal(toEgp(100, 'BHD'), Math.round(100 * 134.3));
  assert.equal(toEgp(100, 'OMR'), Math.round(100 * 131.3));
});

test('toEgp: EGP is identity and returned AS-IS (no rounding — EG byte-identical)', () => {
  assert.equal(toEgp(1250, 'EGP'), 1250);
  assert.equal(toEgp(1583.3, 'EGP'), 1583.3);   // fractional EGP preserved unchanged
  assert.equal(toEgp(1250, 'egp'), 1250);       // case-insensitive
});

test('toEgp: converted amounts are rounded to an integer EGP', () => {
  assert.equal(toEgp(1199, 'AED'), 16486);      // 1199 * 13.75 = 16486.25 → 16486
  assert.ok(Number.isInteger(toEgp(1199, 'AED')));
  assert.ok(Number.isInteger(toEgp(37.5, 'SAR')));
});

test('toEgp: unknown currency THROWS (never silently charge a foreign number as EGP)', () => {
  assert.throws(() => toEgp(100, 'XYZ'), /no EGP rate for currency/);
  assert.throws(() => toEgp(100, ''), /no EGP rate/);
  assert.throws(() => toEgp(100, 'EUR'), /no EGP rate/);
});

test('toEgp: non-finite amount throws', () => {
  assert.throws(() => toEgp('abc', 'AED'), /finite number/);
  assert.throws(() => toEgp(undefined, 'AED'), /finite number/);
  assert.throws(() => toEgp(NaN, 'AED'), /finite number/);
});

test('hasRate: true for EGP + the 8 markets, false otherwise', () => {
  ['EGP', 'USD', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR'].forEach((c) => assert.ok(hasRate(c), c));
  assert.equal(hasRate('XYZ'), false);
  assert.equal(hasRate('EUR'), false);
});

test('DOCTOR_SPLIT_PCT is a flat 20%', () => {
  assert.equal(DOCTOR_SPLIT_PCT, 0.20);
});
