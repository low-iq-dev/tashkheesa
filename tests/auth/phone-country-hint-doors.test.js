'use strict';
// tests/auth/phone-country-hint-doors.test.js
//
// AUDIT-PHONE-COUNTRY-HINT-2026-09-22
//
// The register and OTP doors were fixed on 20 Sep to normalise through
// phone_identity with the patient's country as a hint. Two doors were missed:
// the onboarding profile gate (the one requirePhone() funnels EVERY phoneless
// patient into) and the profile-save form. Both called validatePhoneE164 with
// no hint, so an Egyptian typing '1003225382' — their own number without the
// national trunk zero — hit the >=8-digit forgiveness rule and was stored as
// '+1003225382'. Valid E.164, not their number, and notification_worker sends
// to users.phone verbatim, so the patient silently stops receiving every
// WhatsApp message on a platform where WhatsApp is the payment channel.
//
// These pin the behaviour and pin the call sites, so the four doors cannot
// drift apart again.

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n📱 onboarding and profile-save normalise against the patient\'s country\n');

const { normalizePhone } = require('../../src/validators/phone_identity');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

// ── behaviour ──────────────────────────────────────────────────────────────
const EG = '+201003225382';

check('EG local without the trunk zero is read as Egyptian, not prefixed blindly', () => {
  const r = normalizePhone('1003225382', 'EG', 'en');
  if (!r.ok) return 'expected it to validate, got: ' + r.error;
  if (r.normalized !== EG) return 'expected ' + EG + ', got ' + r.normalized;
  return null;
});

check('EG local WITH the trunk zero still lands on the same number', () => {
  const r = normalizePhone('01003225382', 'EG', 'en');
  return (r.ok && r.normalized === EG) ? null : 'got ' + JSON.stringify(r);
});

check('the old no-hint path is what produced +1003225382', () => {
  const r = normalizePhone('1003225382', null, 'en');
  // Unchanged from today deliberately: no hint means no guessing either way.
  // This test exists to document WHY the hint matters, not to demand a fix here.
  if (r.ok && r.normalized === EG) return 'no-hint path now returns the EG number — update this test, the model changed';
  return null;
});

check('a Saudi patient is not forced into an Egyptian dial code', () => {
  const r = normalizePhone('501234567', 'SA', 'en');
  if (!r.ok) return 'expected valid, got: ' + r.error;
  if (!r.normalized.startsWith('+966')) return 'expected +966…, got ' + r.normalized;
  return null;
});

check('an already-international number is left alone', () => {
  const r = normalizePhone('+201003225382', 'EG', 'en');
  return (r.ok && r.normalized === EG) ? null : 'got ' + JSON.stringify(r);
});

// ── call sites ─────────────────────────────────────────────────────────────
check('onboarding gate passes the country hint', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/onboarding.js'), 'utf8');
  if (!/validators\/phone_identity/.test(src)) return 'onboarding.js no longer requires phone_identity';
  if (!/normalizePhone\(\s*req\.body\.phone\s*,\s*req\.user/.test(src)) {
    return 'the onboarding phone gate no longer normalises against req.user.country_code';
  }
  return null;
});

check('profile save passes the country hint', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/routes/patient.js'), 'utf8');
  if (!/normalizePhone\(\s*rawPhone\s*,\s*countryCode/.test(src)) {
    return 'profile save no longer normalises against the submitted/registered country';
  }
  return null;
});

check('all four patient-facing phone doors go through phone_identity', () => {
  const files = ['src/routes/auth.js', 'src/routes/onboarding.js', 'src/routes/patient.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');
    if (!/normalizePhone/.test(src)) return f + ' has no normalizePhone call left';
  }
  return null;
});
