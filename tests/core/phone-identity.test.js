// tests/core/phone-identity.test.js
//
// AUDIT 2026-08-25 — guards the fix for portal/app account splitting.
//
// Every value below was taken from the production users table on 2026-08-25.
// They are here because each one, at the time, either created a duplicate
// account or made OTP sign-in impossible.

'use strict';

const assert = require('assert');
const {
  normalizePhone,
  significantDigits,
  _stripTrunkAfterDialCode,
} = require('../../src/validators/phone_identity');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📱 Phone identity — portal/app account parity\n');

// The four production spellings that split accounts.
const REAL_CASES = [
  // [input, countryHint, expected, why it mattered]
  ['1277399043',     'EG', '+201277399043', "the founder's own number, previously read as +1 (US)"],
  ['01098729248',    'EG', '+201098729248', 'the ordinary Egyptian local form, previously REJECTED'],
  ['0 110 200 9886', 'EG', '+201102009886', 'spaces'],
  ['+2001149055838', null, '+201149055838', 'dial code glued onto a local number, trunk 0 kept'],
  ['01277399043',    'EG', '+201277399043', 'the same number written locally must reach the same account'],
  ['+201277399043',  null, '+201277399043', 'an already-correct number must be left alone'],
];

for (const [input, hint, expected, why] of REAL_CASES) {
  try {
    const r = normalizePhone(input, hint, 'en');
    assert.ok(r.ok, 'expected ' + JSON.stringify(input) + ' to normalise, got: ' + (r.error || ''));
    assert.strictEqual(r.normalized, expected);
    t.pass('normalise ' + JSON.stringify(input) + ' → ' + expected + '  (' + why + ')');
  } catch (e) { t.fail('normalise ' + JSON.stringify(input), e); }
}

// Other markets: a local number must resolve using its own dial code.
const MARKETS = [
  ['0501234567', 'SA', '+966501234567'],
  ['501234567',  'SA', '+966501234567'],
  ['07911123456','GB', '+447911123456'],
  ['50123456',   'KW', '+96550123456'],
];
for (const [input, hint, expected] of MARKETS) {
  try {
    const r = normalizePhone(input, hint, 'en');
    assert.ok(r.ok, hint + ' ' + input + ' should normalise: ' + (r.error || ''));
    assert.strictEqual(r.normalized, expected);
    t.pass('market ' + hint + ': ' + input + ' → ' + expected);
  } catch (e) { t.fail('market ' + hint + ' ' + input, e); }
}

// THE GUARD THAT MATTERS MOST: without a country, a bare national number must
// NOT be guessed at. Guessing is what turned an Egyptian mobile into a US one.
try {
  const r = normalizePhone('01098729248', null, 'en');
  assert.ok(!r.ok, 'a local number with no country hint must be refused, not guessed');
  t.pass('refuses to guess a country for a local number with no hint');
} catch (e) { t.fail('no-hint local number is refused', e); }

// The trunk-strip must not eat a legitimate number of the wrong length.
try {
  assert.strictEqual(_stripTrunkAfterDialCode('2001149055838'), '201149055838');
  assert.strictEqual(_stripTrunkAfterDialCode('201149055838'), '201149055838', 'already correct — unchanged');
  assert.strictEqual(_stripTrunkAfterDialCode('20011'), '20011', 'too short to be the trunk shape — unchanged');
  t.pass('trunk-prefix repair only fires on the exact <dial><0><subscriber> shape');
} catch (e) { t.fail('trunk-prefix repair is narrow', e); }

// The suffix key must be stable across every spelling of one number, because it
// is the recovery path that finds a legacy account at sign-in.
try {
  const forms = ['+201277399043', '1277399043', '01277399043', '0020 1277 399 043'];
  const keys = forms.map((f) => significantDigits(f, 9));
  assert.strictEqual(new Set(keys).size, 1, 'all spellings must share one suffix key, got: ' + keys.join(', '));
  assert.strictEqual(keys[0], '277399043');
  t.pass('suffix key is stable across all spellings of the same number (' + keys[0] + ')');
} catch (e) { t.fail('suffix key stability', e); }

// And it must be long enough that two different customers cannot collide.
try {
  assert.notStrictEqual(
    significantDigits('+201277399043', 9),
    significantDigits('+201277399044', 9),
    'two different numbers must not share a suffix key'
  );
  t.pass('suffix key distinguishes numbers differing in the last digit');
} catch (e) { t.fail('suffix key discrimination', e); }
