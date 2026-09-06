// src/validators/phone.js
//
// E.164 phone validator + normalizer for patient/doctor signup,
// onboarding, profile edit, and OTP-verify auto-create paths.
//
// Format accepted (after normalization):
//   /^\+[1-9]\d{7,14}$/  — leading "+", country digit 1-9, total 8-15 digits
//
// The 8-digit minimum is slightly tighter than the E.164 wide spec (which
// allows from "+11" upwards) — this catches the truncation pathology we
// observed in production where rows got stored as "+2010" (4 digits).
// 15-digit max matches the spec.
//
// Normalization steps applied before regex check:
//   1. Cast to string, trim
//   2. Strip non-digit / non-plus characters (spaces, dashes, parens)
//   3. If no leading "+" but the digit sequence looks international
//      (>= 8 digits), prepend "+"
//   4. Collapse any duplicate "+" prefix
//
// Returns: { ok: true, normalized: '+201012345678' }
//        | { ok: false, error: '<localized message>' }

'use strict';

var E164_RE = /^\+[1-9]\d{7,14}$/;

var MESSAGES = {
  en: {
    required: 'Phone number is required.',
    invalid:  'Phone number must be in international format (e.g. +201012345678).',
    too_short: 'Phone number is too short — please include the country code.',
    too_long:  'Phone number is too long.'
  },
  ar: {
    required: 'رقم الهاتف مطلوب.',
    invalid:  'يجب أن يكون رقم الهاتف بالصيغة الدولية (مثال: +201012345678).',
    too_short: 'رقم الهاتف قصير جداً — تأكد من تضمين رمز الدولة.',
    too_long:  'رقم الهاتف طويل جداً.'
  }
};

function _msg(lang, key) {
  var bundle = (lang === 'ar') ? MESSAGES.ar : MESSAGES.en;
  return bundle[key] || MESSAGES.en[key];
}

function validatePhoneE164(input, lang) {
  if (input == null) {
    return { ok: false, error: _msg(lang, 'required') };
  }
  var raw = String(input).trim();
  if (!raw) {
    return { ok: false, error: _msg(lang, 'required') };
  }

  // Detect leading "+" before stripping (we'll re-add it).
  var hadPlus = raw.charCodeAt(0) === 43; // '+'

  // Strip everything that isn't an ASCII digit. (Arabic-Indic digits are
  // intentionally rejected — users must type the E.164 form in latin
  // digits so the value matches what Meta WhatsApp + SMS providers expect.)
  var digits = raw.replace(/[^0-9]/g, '');

  if (!digits) {
    return { ok: false, error: _msg(lang, 'invalid') };
  }

  // If the user didn't type a "+" but the digit run is long enough to be
  // international, accept it as if "+" were there. This matches the
  // forgiveness pattern of most consumer phone fields.
  var withPlus = (hadPlus || digits.length >= 8) ? ('+' + digits) : digits;

  if (withPlus.length < 9) { // "+" + 8 digits
    return { ok: false, error: _msg(lang, 'too_short') };
  }
  if (withPlus.length > 16) { // "+" + 15 digits
    return { ok: false, error: _msg(lang, 'too_long') };
  }
  if (!E164_RE.test(withPlus)) {
    return { ok: false, error: _msg(lang, 'invalid') };
  }
  return { ok: true, normalized: withPlus };
}

// ---------------------------------------------------------------------------
// AUDIT-PHONE-UNIQUE-2026-09-06 — the duplicate-phone lockout.
//
// `users_phone_unique_idx` is `UNIQUE (phone) WHERE phone IS NOT NULL`, GLOBAL
// across roles: one number, one account, patient or doctor. Three write paths
// checked email uniqueness before inserting and none of them checked phone, so
// the constraint surfaced as a bare unique_violation into a generic catch:
//
//   * routes/auth.js POST /register     → "Error creating account. Please try
//                                          again." Retrying never works.
//   * routes/onboarding.js /profile     → 500 "Server error". This one is a
//                                          TOTAL LOCKOUT: requirePhone() is
//                                          mounted globally, so a patient with
//                                          no phone is redirected to onboarding
//                                          on every path, and onboarding is the
//                                          only place that can save one. 14 of
//                                          25 production patients pass through
//                                          that gate.
//   * routes/patient.js POST /profile   → "Error saving changes".
//
// In all three the patient is told the system failed, when in fact the system
// worked and the number is simply already registered. Nothing they can type
// will ever succeed, and nothing tells them which field to change.
//
// The detection lives HERE, next to the validator every one of those sites
// already calls, so there is one definition of "this error means the phone is
// taken" rather than three near-misses. The constraint itself is NOT weakened.
//
// Matching is by SQLSTATE 23505 plus evidence that the offending index is the
// phone one: node-pg populates `constraint` on most builds, but a violation
// raised through some pooler/driver paths carries only `detail`
// ("Key (phone)=(+2010…) already exists."), so both are accepted. `column` is
// checked too because a future partial index may be renamed. Deliberately NOT
// a bare 23505 test: users_email_key is the same SQLSTATE, and reporting a
// duplicate email as a duplicate phone would be its own dead end.
const PHONE_UNIQUE_INDEX = 'users_phone_unique_idx';

function isPhoneTakenError(err) {
  if (!err || String(err.code) !== '23505') return false;
  const constraint = String(err.constraint || '').toLowerCase();
  if (constraint === PHONE_UNIQUE_INDEX) return true;
  if (constraint.includes('phone')) return true;
  if (String(err.column || '').toLowerCase() === 'phone') return true;
  return /\bkey\s*\(\s*phone\s*\)/i.test(String(err.detail || ''));
}

var TAKEN_MESSAGES = {
  en: 'This phone number is already registered to another account. Use a different number, or sign in to the account that has it.',
  ar: 'رقم الهاتف ده مسجل بالفعل على حساب تاني. استخدم رقم مختلف، أو سجّل دخول بالحساب اللي عليه الرقم.'
};

function phoneTakenMessage(lang) {
  return (lang === 'ar') ? TAKEN_MESSAGES.ar : TAKEN_MESSAGES.en;
}

module.exports = {
  validatePhoneE164: validatePhoneE164,
  E164_RE: E164_RE,
  PHONE_UNIQUE_INDEX: PHONE_UNIQUE_INDEX,
  isPhoneTakenError: isPhoneTakenError,
  phoneTakenMessage: phoneTakenMessage
};
