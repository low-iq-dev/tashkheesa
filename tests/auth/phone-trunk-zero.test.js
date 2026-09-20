// tests/auth/phone-trunk-zero.test.js
//
// AUDIT-PHONE-TRUNK-ZERO-2026-09-20
//
// The WEB OTP door built its number as `countryCode + phone` string
// concatenation. "+20" picked in the dropdown plus "01003225382" typed in the
// field produced "+2001003225382" — a valid-looking E.164 string for a
// DIFFERENT number. The lookup missed the caller's real row and the
// find-or-use-existing minted a stray PATIENT account on the bogus number.
// It cost Dr Nancy Ghoneim five days; two stray rows were deleted by hand.
//
// phone_identity.normalizePhone already solved this for the MOBILE door after
// the +1277399043 incident. These tests pin the web door to the same function,
// so the two doors cannot drift apart again.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📞 AUDIT-PHONE-TRUNK-ZERO — web OTP door + register\n');

const { normalizePhone } = require('../../src/validators/phone_identity');

// 1. Every way a real user writes an Egyptian mobile.
//    All of these are the SAME person and must resolve to ONE string.
const EG = '+201003225382';
[
  ['+20', '01003225382',    'trunk zero - how every Egyptian writes it'],
  ['+20', '1003225382',     'no trunk zero'],
  ['+20', '201003225382',   'country code typed into the field as well'],
  ['+20', '010 032 25382',  'trunk zero with spaces'],
  ['+20', '010-032-25382',  'trunk zero with dashes'],
  ['20',  '01003225382',    'dial code given without the +'],
  ['EG',  '01003225382',    'ISO country hint instead of a dial code'],
  ['+20', '+201003225382',  'full international typed into the field'],
  ['+20', '+2001003225382', 'the doubled form itself, pasted back in'],
].forEach(function (row) {
  var cc = row[0], nat = row[1], label = row[2];
  try {
    var r = normalizePhone(nat, cc, 'en');
    assert.strictEqual(r.ok, true, 'expected ok=true for ' + JSON.stringify([cc, nat]) + ' got ' + JSON.stringify(r));
    assert.strictEqual(r.normalized, EG, label + ': got ' + r.normalized);
    t.pass('EG ' + label + ' -> ' + EG);
  } catch (e) { t.fail('EG ' + label, e); }
});

// 2. The exact inputs that created the two stray accounts.
[
  ['+20', '01003225382', '+201003225382', 'Gharib - was stored as +2001003225382'],
  ['+20', '01007801095', '+201007801095', 'Ghoneim - was stored as +2001007801095'],
].forEach(function (row) {
  var cc = row[0], nat = row[1], expected = row[2], label = row[3];
  try {
    var r = normalizePhone(nat, cc, 'en');
    assert.strictEqual(r.ok, true, label + ': ' + JSON.stringify(r));
    assert.notStrictEqual(r.normalized, cc + nat, label + ': still producing the doubled form');
    assert.strictEqual(r.normalized, expected, label + ': got ' + r.normalized);
    t.pass(label);
  } catch (e) { t.fail(label, e); }
});

// 3. Other markets keep working.
[
  ['+44',  '07911123456', '+447911123456', 'UK trunk zero'],
  ['+44',  '7911123456',  '+447911123456', 'UK no trunk zero'],
  ['+971', '0501234567',  '+971501234567', 'AE trunk zero'],
  ['+966', '0501234567',  '+966501234567', 'SA trunk zero'],
].forEach(function (row) {
  var cc = row[0], nat = row[1], expected = row[2], label = row[3];
  try {
    var r = normalizePhone(nat, cc, 'en');
    assert.strictEqual(r.ok, true, label + ': ' + JSON.stringify(r));
    assert.strictEqual(r.normalized, expected, label + ': got ' + r.normalized);
    t.pass(label + ' -> ' + expected);
  } catch (e) { t.fail(label, e); }
});

// 4. Junk is refused, not quietly turned into a new account.
[
  ['+20', '',            'empty national'],
  ['+20', '   ',         'whitespace national'],
  ['+20', 'abc',         'letters only'],
  ['+20', null,          'null national'],
  ['',    '01003225382', 'no country hint and a leading trunk zero - must refuse, not guess'],
].forEach(function (row) {
  var cc = row[0], nat = row[1], label = row[2];
  try {
    var r = normalizePhone(nat, cc, 'en');
    assert.strictEqual(r.ok, false, label + ': expected rejection, got ' + JSON.stringify(r));
    assert.ok(typeof r.error === 'string' && r.error.length, label + ': missing error message');
    t.pass('refused: ' + label);
  } catch (e) { t.fail('refused: ' + label, e); }
});

// 5. Both doors use the SAME function - the drift that caused this.
try {
  var web = fs.readFileSync(path.join(__dirname, '../../src/routes/auth.js'), 'utf8');
  var mobile = fs.readFileSync(path.join(__dirname, '../../src/routes/api/auth.js'), 'utf8');

  assert.ok(/validators\/phone_identity/.test(web),
    'web auth.js no longer requires phone_identity');
  assert.ok(/normalizePhone\(\s*ph\s*,\s*cc\s*,/.test(web),
    'parseOtpPhone no longer calls normalizePhone(ph, cc, ...)');
  assert.ok(!/const full = \(cc \+ ph\)/.test(web),
    'parseOtpPhone has reverted to string-concatenating cc + ph');
  assert.ok(/normalizePhone\(\s*phone\s*,\s*country_code/.test(web),
    'POST /register no longer normalises against the submitted country code');
  assert.ok(/normalizePhone/.test(mobile),
    'mobile api/auth.js no longer uses normalizePhone');

  t.pass('web and mobile OTP doors both normalise through phone_identity');
} catch (e) { t.fail('web and mobile OTP doors both normalise through phone_identity', e); }

// 6. No third normaliser crept back into the web OTP door.
try {
  var src = fs.readFileSync(path.join(__dirname, '../../src/routes/auth.js'), 'utf8');
  var start = src.indexOf('function parseOtpPhone');
  var end = src.indexOf('const otpPhoneKey');
  assert.ok(start > -1 && end > start, 'could not locate parseOtpPhone');
  var parseFn = src.slice(start, end);
  assert.ok(!/validatePhoneE164\(/.test(parseFn),
    'parseOtpPhone is calling validatePhoneE164 directly again - it cannot see the country code');
  t.pass('parseOtpPhone does not bypass the country-aware normaliser');
} catch (e) { t.fail('parseOtpPhone does not bypass the country-aware normaliser', e); }
