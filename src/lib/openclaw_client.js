// src/lib/openclaw_client.js
// Outbound HTTP client for the OpenClaw Mac mini WhatsApp gateway.
//
// Contract (per the WhatsApp-via-OpenClaw design, 2026-05):
//   POST <OPENCLAW_BASE_URL>/send
//   Header: x-openclaw-key: <OPENCLAW_SEND_KEY>
//   Body:   { to: "+201...", lang: "ar"|"en", body: "<text>", ref: "<order_id>" }
//   200:    { sent: true, message_id: "..." }
//   4xx/5xx { error: "..." }
//
// Behavior mirrors src/notify/whatsapp.js so the notification_worker
// can swap transports without changing its return-shape handling:
//   - { ok: true, data }          on 2xx
//   - { ok: false, error, status} on non-2xx / network error
//   - { ok: true, stubbed: true } when WHATSAPP_TEST_STUB=true
// Failure paths log to error_logs with category='whatsapp_send' so
// /ops dashboards see OpenClaw failures next to Meta failures.

const fetch = require('node-fetch');
const { maskPhone } = require('../utils/mask');

const SEND_TIMEOUT_MS = 10000;

function isStubMode() {
  return String(process.env.WHATSAPP_TEST_STUB || '').toLowerCase() === 'true';
}

async function logOpenClawError(meta) {
  try {
    const { execute } = require('../pg');
    const { randomUUID } = require('crypto');
    const message = String(meta.message || 'openclaw_send_failed').slice(0, 500);
    const context = JSON.stringify({
      transport: 'openclaw',
      to: meta.to ? maskPhone(meta.to) : null,
      template: meta.template || null,
      lang: meta.lang || null,
      ref: meta.ref || null,
      status: meta.status != null ? meta.status : null,
      error: meta.error || null
    }).slice(0, 4000);
    await execute(
      `INSERT INTO error_logs (id, category, level, message, context, user_id, created_at)
       VALUES ($1, 'whatsapp_send', 'error', $2, $3, $4, NOW())`,
      [randomUUID(), message, context, meta.userId || null]
    ).catch(() => { /* table may not exist in test envs; swallow */ });
  } catch (_) { /* never throw from log writer */ }
}

async function sendViaOpenClaw({ to, lang, body, ref, userId, template }) {
  if (isStubMode()) {
    console.log('[OC] stub — short-circuit ok', { to: maskPhone(to), lang, ref });
    return { ok: true, stubbed: true, to: String(to || ''), lang, ref };
  }

  if (!to || !body) {
    return { ok: false, error: 'oc_missing_to_or_body' };
  }

  const baseUrl = String(process.env.OPENCLAW_BASE_URL || '').replace(/\/+$/, '');
  const sendKey = String(process.env.OPENCLAW_SEND_KEY || '').trim();

  if (!baseUrl || !sendKey) {
    logOpenClawError({
      message: 'oc_env_misconfigured',
      to, template, lang, ref, userId,
      error: 'OPENCLAW_BASE_URL or OPENCLAW_SEND_KEY missing'
    });
    return { ok: false, error: 'oc_env_misconfigured' };
  }

  const url = `${baseUrl}/send`;
  const payload = {
    to: String(to),
    lang: lang === 'ar' ? 'ar' : 'en',
    body: String(body),
    ref: ref ? String(ref) : null
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-openclaw-key': sendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok) {
      logOpenClawError({
        message: 'oc_api_error',
        to, template, lang, ref, userId,
        status: res.status,
        error: data && data.error ? data.error : data
      });
      return { ok: false, error: (data && data.error) || `http_${res.status}`, status: res.status };
    }

    console.log('[OC] sent', { to: maskPhone(to), lang, ref, message_id: data && data.message_id });
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && err.name === 'AbortError';
    logOpenClawError({
      message: isAbort ? 'oc_timeout' : 'oc_send_exception',
      to, template, lang, ref, userId,
      error: err && err.message ? err.message : String(err)
    });
    return { ok: false, error: isAbort ? 'oc_timeout' : (err && err.message ? err.message : 'oc_send_exception') };
  }
}

module.exports = { sendViaOpenClaw };
