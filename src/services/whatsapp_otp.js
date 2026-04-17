// src/services/whatsapp_otp.js
// Sends mobile-app login OTPs via WhatsApp Cloud API, reusing the existing
// sendWhatsApp() infrastructure in src/notify/whatsapp.js.
//
// Why a new module instead of inline in the OTP route:
// - The OTP route in src/routes/api/auth.js receives sendOtpViaTwilio as a
//   pluggable dependency from src/server.js. Keeping the WhatsApp adapter
//   in its own module mirrors that existing seam (and keeps any future
//   swap to a different transport — Twilio Verify, etc. — to a one-line
//   change in server.js).
// - The wider codebase only ever sends WhatsApp via Meta-approved HSM
//   templates (see src/notify/whatsapp.js — `type: 'template'` is hardcoded).
//   This module hides the template-vs-free-form contract from the OTP route
//   so the route's call signature stays the simple `(phone, message)` shape
//   it already has.
//
// Configuration env vars:
// - WHATSAPP_ACCESS_TOKEN ...... if missing: stub (logs, returns {stub: true})
// - WHATSAPP_ENABLED ........... must be 'true' for sendWhatsApp to actually call Meta
// - WHATSAPP_PHONE_NUMBER_ID ... required by sendWhatsApp
// - WHATSAPP_API_VERSION ....... defaults to v22.0 in sendWhatsApp
// - WHATSAPP_OTP_TEMPLATE_NAME . Meta-approved authentication-category template
//                                name (default 'otp_verify_en'). MUST exist in
//                                WhatsApp Business Manager before delivery works.
//                                The template must accept ONE body parameter:
//                                the OTP code.
// - WHATSAPP_OTP_TEMPLATE_LANG . Template language code (default 'en' to match
//                                the convention used in whatsappTemplateMap.js).

const { sendWhatsApp } = require('../notify/whatsapp');

const TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE_NAME || 'otp_verify_en';
const TEMPLATE_LANG = process.env.WHATSAPP_OTP_TEMPLATE_LANG || 'en';

/**
 * Sends an OTP code via WhatsApp using the configured authentication template.
 *
 * Signature matches the legacy sendOtpViaTwilio(phone, message) contract that
 * src/routes/api/auth.js already calls — do not change it without updating
 * the OTP route's call site.
 *
 * @param {string} phoneNumber - Full phone with country code; sendWhatsApp
 *                               normalizes to digits-only internally.
 * @param {string} message     - The full OTP message text built by auth.js
 *                               ("Your Tashkheesa verification code is: 123456").
 *                               The 6-digit OTP is extracted from this string
 *                               and passed to the template as its single body
 *                               parameter; the surrounding prose is discarded
 *                               (the template body supplies its own copy).
 * @returns {Promise<Object>} { stub: true } when not configured;
 *                            { ok: true, ... } on Meta accepting the message;
 *                            { ok: false, error } on any other failure.
 *                            NEVER throws.
 */
async function sendOtpViaWhatsApp(phoneNumber, message) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    console.warn(
      '[OTP WHATSAPP STUB] Not configured. OTP for ' + phoneNumber + ': '
      + message + ' (not sent)'
    );
    return { stub: true };
  }

  // Extract the 6-digit code from the message. auth.js builds the message
  // as `Your Tashkheesa verification code is: ${otp}` where otp is exactly
  // 6 digits, so a word-boundary 6-digit match is reliable. If the format
  // ever changes upstream the warning below will surface during dev.
  const otpMatch = String(message || '').match(/\b(\d{6})\b/);
  const otpCode = otpMatch ? otpMatch[1] : '';
  if (!otpCode) {
    console.warn(
      '[OTP WA] could not extract 6-digit code from message — Meta will likely reject the template parameter'
    );
  }

  try {
    const result = await sendWhatsApp({
      to: phoneNumber,
      template: TEMPLATE_NAME,
      lang: TEMPLATE_LANG,
      vars: { otp_code: otpCode || message },
    });

    // Normalize: sendWhatsApp returns { skipped: true } when WHATSAPP_ENABLED
    // is not 'true' (it short-circuits before any HTTP call). Surface that
    // as { stub: true } so the OTP route's wasStub branch fires the same
    // "delivery not configured" response it would for a missing access token.
    if (result && result.skipped) {
      console.warn(
        '[OTP WHATSAPP STUB] WHATSAPP_ENABLED is not "true". OTP for '
        + phoneNumber + ' not sent.'
      );
      return { stub: true };
    }

    return result;
  } catch (err) {
    // Defensive only — sendWhatsApp catches its own errors and returns
    // { ok: false, error }. This handles anything truly unexpected so the
    // OTP route never receives an exception.
    console.error('[OTP WA] unexpected send failure:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}

module.exports = { sendOtpViaWhatsApp };
