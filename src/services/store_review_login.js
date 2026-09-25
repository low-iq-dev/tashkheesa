/**
 * Store-review sign-in for the Tashkheesa Doctor app.
 *
 * Google Play and Apple reviewers cannot receive our SMS codes, so ONE phone
 * number accepts ONE fixed code on the DOCTOR door only, and it always signs
 * in as ONE fixed account: the App Review sample consultant
 * ('demo-consultant-appreview', whose two cases carry source='demo_appreview'
 * and are already excluded from every ops sweep).
 *
 *   STORE_REVIEW_PHONE      the review number in E.164 (+201550000000)
 *   STORE_REVIEW_OTP        exactly 6 digits
 *   STORE_REVIEW_DOCTOR_ID  optional; defaults to demo-consultant-appreview
 *
 * Unset (or a code that is not 6 digits) → OFF, and the door behaves exactly
 * as before. The review account stays is_active = false on purpose: inactive
 * keeps it out of routing, the doctor counts, invites and campaigns, so the
 * review door alone waives the inactive answer for this one id. Pending and
 * rejected answers still apply. No SMS is ever sent to the review number, and
 * the per-phone verify cap (5 / 15 min) still guards the fixed code.
 */
const { timingSafeEqual } = require('crypto');

const DEFAULT_REVIEW_DOCTOR_ID = 'demo-consultant-appreview';

function digits(s) { return String(s || '').replace(/\D/g, ''); }

// Both sides through the same normaliser the doors use, so '01550000000',
// '1550000000' and '+201550000000' under +20 are one number.
function e164(phone, countryCode) {
  const { normalizePhone } = require('../validators/phone_identity');
  const r = normalizePhone(phone, countryCode, 'en');
  return r && r.ok ? digits(r.normalized) : '';
}

function reviewConfig() {
  const phone = e164(process.env.STORE_REVIEW_PHONE, '');
  const otp = String(process.env.STORE_REVIEW_OTP || '').trim();
  if (phone.length < 8 || !/^\d{6}$/.test(otp)) return null;
  const doctorId = String(process.env.STORE_REVIEW_DOCTOR_ID || '').trim() || DEFAULT_REVIEW_DOCTOR_ID;
  return { phone, otp, doctorId };
}

function isReviewPhone(phone, countryCode) {
  const cfg = reviewConfig();
  return !!cfg && e164(phone, countryCode) === cfg.phone;
}

function isReviewCode(phone, countryCode, otp) {
  if (!isReviewPhone(phone, countryCode)) return false;
  const a = Buffer.from(String(otp || '').trim());
  const b = Buffer.from(reviewConfig().otp);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isReviewDoctor(userId) {
  const cfg = reviewConfig();
  return !!cfg && String(userId || '') === cfg.doctorId;
}

module.exports = { reviewConfig, isReviewPhone, isReviewCode, isReviewDoctor, DEFAULT_REVIEW_DOCTOR_ID };
