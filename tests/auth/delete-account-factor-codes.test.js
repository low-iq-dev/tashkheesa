'use strict';
// tests/auth/delete-account-factor-codes.test.js
//
// AUDIT-APP-AUTH-1 (2026-09-22)
//
// DELETE /api/v1/profile/account requires re-authentication, and which factor
// it requires depends on the account: a password if the row has one, a Twilio
// Verify code if it does not. Nothing the app can see tells it which — GET
// /profile exposes no password flag, and an OTP-signup user can add an email
// later, so email presence proves nothing.
//
// Both 401s used to carry the same REAUTH_REQUIRED code, so the app could not
// render the right field and shipped a delete button that always failed. The
// codes are now distinct and the app branches on them. These pin that apart.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🗑️  delete-account says which re-auth factor it wants\n');

const src = fs.readFileSync(path.join(__dirname, '../../src/routes/api/profile.js'), 'utf8');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

check('the password branch answers REAUTH_REQUIRED_PASSWORD', () => (
  /'REAUTH_REQUIRED_PASSWORD'/.test(src) ? null : 'code not found in api/profile.js'
));

check('the OTP branch answers REAUTH_REQUIRED_OTP', () => (
  /'REAUTH_REQUIRED_OTP'/.test(src) ? null : 'code not found in api/profile.js'
));

check('neither branch answers the ambiguous REAUTH_REQUIRED any more', () => (
  /'REAUTH_REQUIRED'/.test(src)
    ? 'the ambiguous code is back — the app cannot tell the two factors apart'
    : null
));

check('a wrong secret is still answered distinctly from a missing one', () => {
  if (!/'WRONG_PASSWORD'/.test(src)) return 'WRONG_PASSWORD is gone';
  if (!/'WRONG_CODE'/.test(src)) return 'WRONG_CODE is gone';
  return null;
});

check('deletion still requires a factor at all', () => {
  if (!/bcrypt\.compare\(password, row\.password_hash\)/.test(src)) return 'password comparison is gone';
  if (!/verifyOtpCode/.test(src)) return 'OTP verification is gone';
  return null;
});
