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

module.exports = {
  validatePhoneE164: validatePhoneE164,
  E164_RE: E164_RE
};
