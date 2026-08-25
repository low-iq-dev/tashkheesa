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

// ── findUserByPhone: the SQL it actually builds ────────────────────────────
//
// AUDIT 2026-08-25 — this section exists because of a real defect that shipped.
//
// The OTP route was hardened (separately) to gate sign-in to
// ('patient','doctor'), so it passes an ARRAY of roles. findUserByPhone was
// written for a single role and bound whatever it got to `role = $2`. Passing an
// array to a scalar comparison makes Postgres reject the query; safeAll swallows
// it, the lookup returns nothing, and the caller creates a NEW account — the
// exact duplicate-account bug this module exists to prevent, in a new disguise.
//
// Every test above passed while that was broken, because they only exercise
// normalisation. These assert the query SHAPE, using a stub that records what
// was sent.

const { findUserByPhone } = require('../../src/validators/phone_identity');

function stubQuery(rowsByCall) {
  const calls = [];
  const fn = async function (sql, params) {
    calls.push({ sql: sql, params: params });
    return rowsByCall.shift() || [];
  };
  fn.calls = calls;
  return fn;
}

module.exports = (async function () {
  // A single role must still work.
  try {
    const q = stubQuery([[{ id: 'u1' }]]);
    const r = await findUserByPhone(q, '+201277399043', '01277399043', 'patient');
    assert.strictEqual(r.user.id, 'u1');
    assert.ok(/role = ANY\(\$2\)|role = \$2/.test(q.calls[0].sql),
      'expected a role filter, got: ' + q.calls[0].sql);
    t.pass('single role: filters by role and returns the match');
  } catch (e) { t.fail('single role lookup', e); }

  // AN ARRAY of roles — the OTP case — must produce SQL that can accept one.
  try {
    const q = stubQuery([[{ id: 'u2' }]]);
    const r = await findUserByPhone(q, '+201277399043', '01277399043', ['patient', 'doctor']);
    assert.strictEqual(r.user.id, 'u2');
    const sql = q.calls[0].sql;
    const params = q.calls[0].params;
    assert.ok(/= ANY\(\$2\)/.test(sql),
      'an array of roles MUST bind through `= ANY($2)`. Binding it to a scalar `role = $2` makes ' +
      'Postgres reject the query, the lookup return nothing, and the caller create a duplicate ' +
      'account. Got: ' + sql);
    assert.ok(Array.isArray(params[1]),
      'the role parameter must be passed as an array, got: ' + typeof params[1]);
    t.pass('array of roles: binds through = ANY($n), so the query is valid');
  } catch (e) { t.fail('array role lookup', e); }

  // The suffix fallback must carry the SAME role gate, or the recovery path is a
  // hole straight through the security fix it sits behind.
  try {
    const q = stubQuery([[], [], [{ id: 'u3', role: 'patient' }]]);
    const r = await findUserByPhone(q, '+201277399043', '01277399043', ['patient', 'doctor']);
    assert.strictEqual(r.matchedBy, 'suffix');
    const suffixSql = q.calls[q.calls.length - 1].sql;
    assert.ok(/RIGHT\(/.test(suffixSql), 'expected the suffix query, got: ' + suffixSql);
    assert.ok(/role = ANY\(\$3\)/.test(suffixSql),
      'the suffix fallback must apply the same role gate as the exact lookup, or it becomes a way ' +
      'around it. Got: ' + suffixSql);
    t.pass('suffix fallback carries the same role gate');
  } catch (e) { t.fail('suffix fallback role gate', e); }

  // Two accounts sharing a suffix must resolve to NOTHING, never to a guess.
  try {
    const q = stubQuery([[], [], [{ id: 'a' }, { id: 'b' }]]);
    const r = await findUserByPhone(q, '+201277399043', '01277399043', ['patient', 'doctor']);
    assert.strictEqual(r.user, null);
    assert.strictEqual(r.ambiguous, true);
    t.pass('an ambiguous suffix returns nothing rather than guessing a medical record');
  } catch (e) { t.fail('ambiguous suffix', e); }
})();
