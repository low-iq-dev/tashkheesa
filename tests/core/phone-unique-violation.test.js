// tests/core/phone-unique-violation.test.js
//
// AUDIT-PHONE-UNIQUE-2026-09-06 — a duplicate phone must not lock a patient out.
//
// users_phone_unique_idx is `UNIQUE (phone) WHERE phone IS NOT NULL`, global
// across roles. Three write paths checked EMAIL uniqueness and none checked
// phone, so the constraint reached the user as a generic failure:
//
//   routes/auth.js POST /register    → "Error creating account. Please try again."
//   routes/onboarding.js /profile    → 500 "Server error"
//   routes/patient.js POST /profile  → "Error saving changes"
//
// The onboarding one is a total lockout. requirePhone() is mounted globally, so
// a patient with no phone is redirected into onboarding on every path, and that
// UPDATE is the only way out of it — 14 of 25 production patients pass through
// that gate. Told "server error", they can retry forever and never learn that
// the number simply belongs to another account.
//
// The constraint is NOT weakened. What changes is that the error is recognised
// and named, in one place, so the three sites cannot disagree.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n📱 Duplicate phone — a specific, translated refusal\n');

const ROOT = path.join(__dirname, '..', '..');
const phone = require('../../src/validators/phone');

// ── 1. Detection: the phone index, and nothing else ───────────────────────
try {
  const { isPhoneTakenError } = phone;
  expect(typeof isPhoneTakenError === 'function',
    'validators/phone must export isPhoneTakenError');

  // The shapes node-pg actually produces. `constraint` is usually populated,
  // but a violation surfaced through some pooler/driver paths carries only
  // `detail`, so both must be recognised.
  expect(isPhoneTakenError({ code: '23505', constraint: 'users_phone_unique_idx' }) === true,
    'the named partial index must be recognised');
  expect(isPhoneTakenError({ code: '23505', detail: 'Key (phone)=(+201012345678) already exists.' }) === true,
    'a violation carrying only `detail` must be recognised');
  expect(isPhoneTakenError({ code: '23505', column: 'phone' }) === true,
    'a violation naming the column must be recognised');

  // The false positive that would be its own dead end: reporting a duplicate
  // EMAIL as a duplicate phone. Same SQLSTATE, different index.
  expect(isPhoneTakenError({ code: '23505', constraint: 'users_email_key' }) === false,
    'a duplicate EMAIL must not be reported as a duplicate phone — same SQLSTATE, ' +
    'so a bare 23505 test would send the patient to change the wrong field');
  expect(isPhoneTakenError({ code: '23505', detail: 'Key (email)=(a@b.c) already exists.' }) === false,
    'ditto via detail');
  expect(isPhoneTakenError({ code: '23503', constraint: 'users_phone_unique_idx' }) === false,
    'a non-unique-violation must not match');
  expect(isPhoneTakenError(null) === false && isPhoneTakenError(undefined) === false,
    'a missing error must not match');
  expect(isPhoneTakenError(new Error('boom')) === false,
    'an ordinary Error must not match');
  t.pass('detection matches the phone index only — never a duplicate email, never a bare 23505');
} catch (e) { t.fail('isPhoneTakenError', e); }

// ── 2. The message names the field, in both languages ─────────────────────
try {
  const en = phone.phoneTakenMessage('en');
  const ar = phone.phoneTakenMessage('ar');
  expect(en && /phone/i.test(en),
    'the English message must name the phone field — "try again" was the old message and it ' +
    'never worked, because nothing the patient typed could succeed');
  expect(ar && /هاتف/.test(ar), 'the Arabic message must exist and name the phone field');
  expect(en !== ar, 'the two languages must not be the same string');
  expect(phone.phoneTakenMessage(undefined) === en, 'an unknown language falls back to English');
  t.pass('the refusal names the phone field in English and Arabic');
} catch (e) { t.fail('phoneTakenMessage', e); }

// ── 3. All THREE write paths use it ───────────────────────────────────────
// One site fixed is one site fixed; the class is fixed only if all three are,
// which is why the detection lives in the shared validator.
try {
  const SITES = [
    ['src/routes/auth.js',       "POST /register"],
    ['src/routes/onboarding.js', "POST /portal/patient/onboarding/profile (the lockout)"],
    ['src/routes/patient.js',    "POST /patient/profile"]
  ];
  SITES.forEach(function (pair) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, pair[0]), 'utf8'));
    expect(/isPhoneTakenError\s*\(/.test(src),
      pair[0] + ' (' + pair[1] + ') must detect the duplicate-phone violation');
    expect(/phoneTakenMessage\s*\(/.test(src),
      pair[0] + ' must show the shared, translated message rather than inventing its own');
  });

  // The onboarding site specifically: the write must be individually wrapped, or
  // the violation falls through to the handler's outer catch and becomes the
  // 500 that traps the patient.
  const ONB = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'onboarding.js'), 'utf8'));
  const upd = ONB.indexOf('UPDATE users SET name = $1, phone = $2');
  expect(upd !== -1, 'the onboarding profile UPDATE must exist');
  const around = ONB.slice(Math.max(0, upd - 400), upd + 900);
  expect(/try\s*\{/.test(around) && /isPhoneTakenError/.test(around),
    'the onboarding UPDATE must be wrapped where it is written — falling through to the ' +
    "handler's outer catch is what produced the 500 that made this a lockout");
  expect(/status\(409\)/.test(around),
    'a taken phone is a conflict the patient can act on, not a server error');
  t.pass('all three write paths detect the violation and return the shared message');
} catch (e) { t.fail('call sites', e); }

// ── 4. The constraint is not weakened ─────────────────────────────────────
// The tempting "fix" for a unique-violation is to drop the uniqueness. One
// number, one account is a real product rule (WhatsApp dispatch keys on it).
try {
  const files = ['src/routes/auth.js', 'src/routes/onboarding.js', 'src/routes/patient.js'];
  files.forEach(function (f) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    expect(!/DROP\s+INDEX/i.test(src) && !/users_phone_unique_idx.{0,40}DROP/i.test(src),
      f + ' must not drop the uniqueness constraint');
    expect(!/ON CONFLICT\s*\(\s*phone\s*\)\s*DO\s+NOTHING/i.test(src),
      f + ' must not swallow the conflict — silently not saving the phone leaves the patient ' +
      'inside the requirePhone gate with no error at all');
  });
  t.pass('no write path weakens or silently swallows the phone-uniqueness constraint');
} catch (e) { t.fail('constraint intact', e); }
