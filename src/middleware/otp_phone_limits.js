'use strict';

// src/middleware/otp_phone_limits.js
//
// C2 (Batch C, 2026-09-22) — ONE per-phone OTP budget across every OTP door.
//
// The per-phone limiters (AUDIT-P0-8: 60s send cooldown, 3 sends / 15 min,
// 5 verifies / 15 min) used to live as module-privates in routes/api/auth.js.
// When the doctor door (routes/api/doctor_auth.js) was added it needed the
// same protections — but a duplicated set of limiter INSTANCES would give
// every phone number a second, independent budget: 6 SMS sends per 15 minutes
// against one victim instead of 3, doubling both the bombing nuisance and the
// Twilio cost cap the limiter exists to enforce. The budget belongs to the
// PHONE, not to the door, so the instances are shared: a send through either
// door draws down the same counter.
//
// Shapes are unchanged from the auth.js originals (validate:false because the
// trust-proxy req.ip shape varies at the Render edge).

const { rateLimit } = require('express-rate-limit');

// Normalises {countryCode, phone} into a stable limiter key. Runs BEFORE the
// limiters so they have something to key on; falls back to the IP so a
// malformed body can never bypass the cap by yielding a constant key.
function otpPhoneScope(req, _res, next) {
  const cc = String((req.body && req.body.countryCode) || '').replace(/[^0-9+]/g, '');
  const ph = String((req.body && req.body.phone) || '').replace(/[^0-9]/g, '');
  req.otpPhone = { key: (cc + ph) || ('ip:' + (req.ip || 'unknown')) };
  next();
}
const otpPhoneKey = (req) => (req.otpPhone && req.otpPhone.key) || 'unknown';
const otpRlMsg = { success: false, error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' };

// Per-phone: 60s cooldown between sends.
const otpSendCooldown = rateLimit({
  windowMs: 60 * 1000, max: 1, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey,
  message: { success: false, error: 'Please wait a minute before requesting another code.', code: 'OTP_COOLDOWN' },
});
// Per-phone: total sends per window (SMS-cost / bombing guard).
const otpSendCap = rateLimit({
  windowMs: 15 * 60 * 1000, max: 3, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});
// Per-phone: verify attempts per window.
const otpVerifyCap = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});

module.exports = { otpPhoneScope, otpSendCooldown, otpSendCap, otpVerifyCap };
