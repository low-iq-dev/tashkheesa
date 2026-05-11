// src/services/twilio_verify.js
// Twilio Verify OTP delivery — replaces WhatsApp OTP template approach.
//
// Twilio Verify is a dedicated OTP product: Twilio generates the code,
// sends it via SMS, and stores it server-side. The patient receives an SMS
// like "Your Tashkheesa verification code is 847291".
//
// This module exports two functions:
//   sendOtpViaTwilio(phone, message) — triggers Twilio Verify send (ignores message param)
//   verifyOtpCode(phone, code)       — checks the code against Twilio Verify
//
// Required env vars:
//   TWILIO_ACCOUNT_SID ............. Twilio account credentials
//   TWILIO_AUTH_TOKEN .............. Twilio account credentials
//   TWILIO_VERIFY_SERVICE_SID ..... Create at console.twilio.com → Verify → Services
//
// When any credential is missing, both functions stub gracefully and never crash.

const twilio = require('twilio');

function getClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function getServiceSid() {
  return (process.env.TWILIO_VERIFY_SERVICE_SID || '').trim() || null;
}

/**
 * Send OTP via Twilio Verify (SMS).
 *
 * Signature matches the legacy sendOtpViaTwilio(phone, message) contract.
 * The `message` param is ignored — Twilio Verify generates its own message
 * from the service's friendly name ("Your <service> verification code is: XXXXXX").
 *
 * @param {string} phone   - Full international format, e.g. "+201234567890"
 * @param {string} message - Ignored (kept for call-site compatibility)
 * @returns {Promise<Object>} { ok, status } on success; { stub } when not configured; { ok: false, error } on failure. NEVER throws.
 */
async function sendOtpViaTwilio(phone, message) {
  const client = getClient();
  const serviceSid = getServiceSid();

  if (!client || !serviceSid) {
    console.warn(
      '[TWILIO VERIFY STUB] Credentials not set. OTP not sent to:', phone,
      '| message:', message
    );
    return { stub: true };
  }

  try {
    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications
      .create({ to: phone, channel: 'sms' });

    console.log(`[TWILIO VERIFY] Sent OTP to ${phone}, status: ${verification.status}`);
    return { ok: true, status: verification.status };
  } catch (err) {
    // Theme 8 Phase 6 — surface Twilio Verify send failures to /ops/errors.
    // PII safety: phone is masked to last 4 digits; the OTP `code`
    // is NEVER touched in this scope (Twilio generates + stores it
    // server-side; we never receive the raw value here). No tokens.
    try {
      const { logErrorToDb } = require('../logger');
      logErrorToDb(err, {
        context: 'twilio_verify.send_otp',
        category: 'twilio_verify_otp',
        phoneMasked: '***' + String(phone || '').slice(-4)
      });
    } catch (_) { /* fire-and-forget */ }
    console.error('[TWILIO VERIFY] Failed to send OTP:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Verify an OTP code entered by the patient against Twilio Verify.
 *
 * @param {string} phone - Full international format, e.g. "+201234567890"
 * @param {string} code  - The 6-digit code the patient entered
 * @returns {Promise<Object>} { valid: true } if correct; { valid: false, error? } otherwise. NEVER throws.
 */
async function verifyOtpCode(phone, code) {
  const client = getClient();
  const serviceSid = getServiceSid();

  if (!client || !serviceSid) {
    console.warn('[TWILIO VERIFY] Cannot verify — credentials not set');
    return { valid: false, error: 'Verification service not configured' };
  }

  try {
    const check = await client.verify.v2
      .services(serviceSid)
      .verificationChecks
      .create({ to: phone, code: String(code) });

    console.log(`[TWILIO VERIFY] Check for ${phone}: ${check.status}`);
    return { valid: check.status === 'approved' };
  } catch (err) {
    // Twilio returns 404 if the verification expired or was never created.
    // Treat as invalid rather than an error worth surfacing to the patient.
    //
    // Theme 8 Phase 6 — still write to /ops/errors so spike-rate patterns
    // (e.g., Twilio outage causing every check to 5xx) become visible.
    // PII safety: the user-entered `code` is NEVER passed to logErrorToDb.
    try {
      const { logErrorToDb } = require('../logger');
      logErrorToDb(err, {
        context: 'twilio_verify.verify_check',
        category: 'twilio_verify_otp',
        phoneMasked: '***' + String(phone || '').slice(-4)
      });
    } catch (_) { /* fire-and-forget */ }
    console.error('[TWILIO VERIFY] Check failed:', err.message);
    return { valid: false, error: err.message };
  }
}

module.exports = { sendOtpViaTwilio, verifyOtpCode };
