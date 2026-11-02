'use strict';

// src/validators/otp_phone_guard.js
//
// 2 Nov 2026 (patient recovery, Part D) — validate a phone BEFORE any Twilio
// call, so an OTP send is never spent on a number that cannot receive it.
//
// What reached Twilio Verify and was refused ("Invalid parameter `To`"), from
// error_logs:
//
//   16 Oct 03:13, 03:14   +2010000000930129     16 digits after the '+'
//   11 Oct, 12 Oct, 28 Oct +201550000000930129  18 digits
//   11 Oct                 +201990000177         E.164-shaped, not a mobile
//   25, 26 Sep             +206504992804         E.164-shaped, not a mobile
//
// The first two came through the DOCTOR app's door (routes/api/doctor_auth.js),
// which glued countryCode onto phone with no normalisation at all; the doctor
// app's splitPhone() turns '010000000930129' into exactly '+2010000000930129'.
// normalizePhone would have refused both as too long. The last two pass
// normalizePhone — they are valid E.164 — and still cannot be an Egyptian
// mobile, which is the only thing an SMS code can reach on +20.
//
// The rule:
//   * normalizePhone first, unchanged — the trunk-zero repair ('0100…' with
//     +20 → '+20100…') and every other country's handling stay exactly as
//     they are;
//   * then, for +20 only, the Egyptian mobile shape: +20 1[0125] and eight
//     more digits — 12 digits after the '+';
//   * any other country: E.164 shape only (normalizePhone already enforced it).
//     Any-country signup is live; a stricter rule for them would be a guess.

const { normalizePhone } = require('./phone_identity');

const EG_DIAL = '+20';
const EG_MOBILE_RE = /^\+201[0125]\d{8}$/;

const MESSAGES = {
  en: {
    eg_mobile: 'Please enter an Egyptian mobile number: 11 digits starting with 010, 011, 012 or 015.',
  },
  ar: {
    eg_mobile: 'من فضلك اكتب رقم موبايل مصري: ١١ رقم بيبدأ بـ 010 أو 011 أو 012 أو 015.',
  },
};

function _lang(lang) { return lang === 'ar' ? 'ar' : 'en'; }

function digitsOnly(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

/**
 * The SHAPE of what was typed, for the log — never the number itself: how many
 * digits, the dial code it resolved to (when it did), and the first two digits
 * of the national part.
 */
function phoneShape(input, normalized) {
  const raw = String(input == null ? '' : input);
  const d = digitsOnly(raw);
  const out = { typed_digits: d.length, had_plus: raw.trim().charAt(0) === '+' };
  if (normalized && normalized.indexOf(EG_DIAL) === 0) {
    const national = normalized.slice(EG_DIAL.length);
    out.dial = EG_DIAL;
    out.national_digits = national.length;
    out.national_lead = national.slice(0, 2);
  }
  return out;
}

/**
 * Is this a number an OTP can be sent to?
 *
 * @param {string} input         what the person typed (or what is stored)
 * @param {string} [countryHint] ISO ('EG') or dial code ('+20'), as normalizePhone takes
 * @param {string} [lang]        'ar' | 'en', for the message
 * @returns {{ok: true, normalized: string}
 *         | {ok: false, error: string, reason: 'invalid'|'eg_mobile_shape', shape: object}}
 */
function checkOtpPhone(input, countryHint, lang) {
  const l = _lang(lang);
  const norm = normalizePhone(input, countryHint, l);
  if (!norm || !norm.ok) {
    return { ok: false, error: (norm && norm.error) || MESSAGES[l].eg_mobile, reason: 'invalid', shape: phoneShape(input, null) };
  }
  const n = norm.normalized;
  if (n.indexOf(EG_DIAL) === 0 && !EG_MOBILE_RE.test(n)) {
    return { ok: false, error: MESSAGES[l].eg_mobile, reason: 'eg_mobile_shape', shape: phoneShape(input, n) };
  }
  return { ok: true, normalized: n };
}

/**
 * Record a refused number in error_logs at warn: the door, the reason and the
 * shape only. Fire-and-forget; never throws.
 */
function logRejectedOtpPhone(door, result) {
  try {
    const { logErrorToDb } = require('../logger');
    logErrorToDb(new Error('otp phone refused before send: ' + ((result && result.reason) || 'invalid')), {
      context: 'otp_phone_guard.' + String(door || 'unknown'),
      category: 'otp_phone_rejected',
      level: 'warn',
      reason: result && result.reason,
      shape: result && result.shape,
    });
  } catch (_) { /* logging never blocks the answer */ }
}

/**
 * The API doors' form of the same refusal, as Express middleware for
 * POST /otp/request (patient app and doctor app). Mounted BEFORE the per-phone
 * limiters, so a typo does not spend the number's three sends.
 *
 * Additive for installed builds: the answer is the PHONE_INVALID 422 the
 * patient door already returns for an unparseable number; an empty field is
 * left to each route's own validator, so its VALIDATION_ERROR is unchanged.
 * On success the E.164 form is left on req.otpSendPhone for the handler.
 *
 * @param {string} door   'app_patient' | 'app_doctor' — for the log only
 * @param {function} [isExempt] (phone, countryCode) => boolean — the store
 *   review number, which never receives an SMS and must never be refused here
 */
function refuseUnsendableApiOtpPhone(door, isExempt) {
  return function refuseUnsendableApiOtpPhoneMiddleware(req, res, next) {
    const b = req.body || {};
    const phone = String(b.phone == null ? '' : b.phone).trim();
    const countryCode = String(b.countryCode == null ? '' : b.countryCode).trim();
    if (!phone || !countryCode) return next();
    try { if (typeof isExempt === 'function' && isExempt(phone, countryCode)) return next(); } catch (_) { /* not exempt */ }
    const al = String((req.get && req.get('accept-language')) || '').toLowerCase();
    const lang = String(b.lang || '').toLowerCase() === 'ar' || al.indexOf('ar') === 0 ? 'ar' : 'en';
    const chk = checkOtpPhone(phone, countryCode, lang);
    if (chk.ok) { req.otpSendPhone = chk.normalized; return next(); }
    logRejectedOtpPhone(door, chk);
    return res.fail(chk.error, 422, 'PHONE_INVALID');
  };
}

module.exports = { checkOtpPhone, logRejectedOtpPhone, refuseUnsendableApiOtpPhone, phoneShape, EG_MOBILE_RE, MESSAGES };
