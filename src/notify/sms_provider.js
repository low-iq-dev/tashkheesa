'use strict';

// src/notify/sms_provider.js — plain SMS for the notification worker
// (patient recovery, Part B, 2 Nov 2026).
//
// One interface, any number of providers. The worker (via notify/sms_fallback)
// calls sendSms() and never knows which provider answered, so an Egyptian SMS
// gateway can be added later as one more entry in PROVIDERS — no caller
// changes. A provider is { name, configured(env) → boolean,
// send({ to, body, ref }, env) → result } where result is one of
//   { ok: true, sid, status, price, priceUnit, segments }
//   { ok: false, error, outcome: 'not_sent' | 'unknown' }
// `outcome` says whether the message may have left: 'not_sent' when the
// provider refused it (validation, auth) or it never connected; 'unknown' for a
// timeout or a dropped connection after the request went out. The worker never
// retries an SMS either way (a retried 'unknown' is how a patient gets two),
// but the distinction is kept in the row for whoever reads it.
//
// OFF UNLESS CONFIGURED. Twilio needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
// (already set for Verify) AND a sender: TWILIO_MESSAGING_SERVICE_SID
// (preferred — it carries the registered alphanumeric sender for Egypt) or
// TWILIO_SMS_FROM. Without one, sendSms answers { skipped, reason:
// 'sms_unconfigured' } and nothing throws. SMS_PROVIDER picks the provider
// (default 'twilio').
//
// NON-PRODUCTION FENCE — the same rule notify/whatsapp.js applies (AUDIT-P1-4):
// outside MODE/NODE_ENV=production only numbers on SMS_TEST_RECIPIENTS
// (comma-separated, digits compared) can receive anything, and an unset list
// blocks every send. A staging instance holding a copy of production data must
// not text real patients.

const { maskPhone } = require('../utils/mask');

const SEND_TIMEOUT_MS = 15000;
// Connection-level failures that prove nothing reached the provider.
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function _env(env) { return env || process.env; }
function _str(v) { return String(v == null ? '' : v).trim(); }

const twilioProvider = {
  name: 'twilio',
  configured(env) {
    const e = _env(env);
    return !!(_str(e.TWILIO_ACCOUNT_SID) && _str(e.TWILIO_AUTH_TOKEN)
      && (_str(e.TWILIO_MESSAGING_SERVICE_SID) || _str(e.TWILIO_SMS_FROM)));
  },
  async send({ to, body }, env, deps) {
    const e = _env(env);
    const factory = (deps && deps.twilio) || require('twilio');
    const client = factory(_str(e.TWILIO_ACCOUNT_SID), _str(e.TWILIO_AUTH_TOKEN), { timeout: SEND_TIMEOUT_MS });
    const params = { to: String(to), body: String(body) };
    if (_str(e.TWILIO_MESSAGING_SERVICE_SID)) params.messagingServiceSid = _str(e.TWILIO_MESSAGING_SERVICE_SID);
    else params.from = _str(e.TWILIO_SMS_FROM);
    try {
      const m = await client.messages.create(params);
      return {
        ok: true,
        sid: m && m.sid || null,
        status: m && m.status || null,
        // Twilio usually prices a message after it is delivered; at creation
        // `price` is null. Recorded when present.
        price: m && m.price != null ? m.price : null,
        priceUnit: m && m.priceUnit || null,
        segments: m && m.numSegments != null ? Number(m.numSegments) : null,
      };
    } catch (err) {
      // A Twilio API error (RestException) carries an HTTP status: the request
      // was answered and refused, so nothing was sent.
      const answered = err && Number.isFinite(Number(err.status)) && Number(err.status) > 0;
      const preConnect = err && PRE_CONNECT_CODES.has(String(err.code || ''));
      return {
        ok: false,
        error: String((err && err.message) || 'sms_send_failed').slice(0, 300),
        code: err && err.code != null ? String(err.code) : null,
        outcome: (answered || preConnect) ? 'not_sent' : 'unknown',
      };
    }
  },
};

const PROVIDERS = Object.freeze({ twilio: twilioProvider });

function providerName(env) {
  return _str(_env(env).SMS_PROVIDER).toLowerCase() || 'twilio';
}

/** The configured provider, or null (SMS off). */
function getSmsProvider(env) {
  const p = PROVIDERS[providerName(env)];
  return p && p.configured(env) ? p : null;
}

function isSmsConfigured(env) { return !!getSmsProvider(env); }

function _isProduction(env) {
  const e = _env(env);
  return _str(e.MODE || e.NODE_ENV).toLowerCase() === 'production';
}

/**
 * Send one SMS. Never throws.
 * @param {{to: string, body: string, ref?: string}} msg
 * @param {object} [opts] { env, deps } — injectable for tests
 * @returns {Promise<object>} provider result, or { skipped: true, reason }
 */
async function sendSms(msg, opts) {
  const o = opts || {};
  const env = _env(o.env);
  const to = _str(msg && msg.to);
  const body = String((msg && msg.body) || '');
  if (!to || !body) return { skipped: true, reason: 'sms_missing_to_or_body' };

  const provider = getSmsProvider(env);
  if (!provider) return { skipped: true, reason: 'sms_unconfigured' };

  if (!_isProduction(env)) {
    const digits = to.replace(/[^0-9]/g, '');
    const allow = _str(env.SMS_TEST_RECIPIENTS).split(',').map((n) => n.replace(/[^0-9]/g, '')).filter(Boolean);
    if (allow.indexOf(digits) === -1) {
      console.warn('[SMS] non-production environment — recipient not on SMS_TEST_RECIPIENTS, blocked', { to: maskPhone(to) });
      return { skipped: true, reason: 'non_production_recipient_blocked' };
    }
  }

  try {
    const r = await provider.send({ to, body, ref: msg.ref || null }, env, o.deps);
    return Object.assign({ provider: provider.name }, r);
  } catch (err) {
    return { ok: false, provider: provider.name, error: String((err && err.message) || err), outcome: 'unknown' };
  }
}

module.exports = { sendSms, getSmsProvider, isSmsConfigured, PROVIDERS, SEND_TIMEOUT_MS };
