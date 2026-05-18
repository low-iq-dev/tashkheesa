// src/notify/whatsapp.js
const fetch = require('node-fetch');
const { maskPhone, maskToken } = require('../utils/mask');
const { apiVersion: waApiVersion } = require('../config/whatsapp');
const { sendViaOpenClaw } = require('../lib/openclaw_client');
const { getOpenClawBody } = require('./openclawTemplates');

// Theme 9 Sub-issue B (OQ-7): the v22.0 default for WHATSAPP_API_VERSION
// now lives in src/config/whatsapp.js — imported via waApiVersion() below.
// Other envs still read at call time inside sendWhatsApp().
const {
  WHATSAPP_ENABLED,
  WHATSAPP_TEST_STUB,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN
} = process.env;

function isEnabled() {
  return String(WHATSAPP_ENABLED).toLowerCase() === 'true';
}

// Master kill-switch for the WhatsApp-via-OpenClaw migration. Read at
// call time so flipping the env on Render doesn't require a redeploy.
// Independent of WHATSAPP_ENABLED (which gates the Meta path only) so
// we can flip transports without touching the legacy flag.
function isNotificationsWhatsAppEnabled() {
  return String(process.env.NOTIFICATIONS_WHATSAPP_ENABLED || '').toLowerCase() === 'true';
}

// 'meta' (default) | 'openclaw'. Decides which transport sendWhatsApp
// routes to when NOTIFICATIONS_WHATSAPP_ENABLED=true.
function whatsappTransport() {
  const t = String(process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT || 'meta').toLowerCase();
  return t === 'openclaw' ? 'openclaw' : 'meta';
}

function isStubMode() {
  // P1-NOTIF-1: WHATSAPP_TEST_STUB=true short-circuits sendWhatsApp
  // and returns { ok: true, stubbed: true } without calling Meta.
  // Used by integration tests to verify the dispatch path fires
  // without burning real template quota or requiring network.
  return String(process.env.WHATSAPP_TEST_STUB || WHATSAPP_TEST_STUB || '').toLowerCase() === 'true';
}

// P1-NOTIF-1: write WhatsApp send failures to error_logs so ops has
// a single place to monitor silent failures. Lazy-loaded to avoid a
// circular import (pg → db → ...). Soft-fail if pg is unavailable.
async function logWhatsAppError(meta) {
  try {
    const { execute } = require('../pg');
    const { randomUUID } = require('crypto');
    const message = String(meta.message || 'whatsapp_send_failed').slice(0, 500);
    const context = JSON.stringify({
      to: meta.to ? maskPhone(meta.to) : null,
      template: meta.template || null,
      lang: meta.lang || null,
      status: meta.status != null ? meta.status : null,
      error: meta.error || null
    }).slice(0, 4000);
    // Schema per migration 035: error_logs(id, error_id, level, message,
    // stack, context, request_id, user_id, url, method, created_at,
    // category). We populate id, category, message, context, user_id,
    // and level. The other columns are nullable.
    await execute(
      `INSERT INTO error_logs (id, category, level, message, context, user_id, created_at)
       VALUES ($1, 'whatsapp_send', 'error', $2, $3, $4, NOW())`,
      [randomUUID(), message, context, meta.userId || null]
    ).catch(() => { /* table may not exist in some test envs; swallow */ });
  } catch (_) { /* never throw from log writer */ }
}

async function sendWhatsApp({ to, template, lang = 'en_US', vars = {}, orderId = null, userId = null }) {
  // Stub mode: short-circuit before any env or network checks. Tests
  // can flip the env at runtime, so we re-read process.env each call.
  if (isStubMode()) {
    console.log('[WA] stub — short-circuit ok', { to: maskPhone(to), template, lang });
    return { ok: true, stubbed: true, to: String(to || '').replace(/[^0-9]/g, ''), template, lang };
  }

  // Master switch: independent of legacy WHATSAPP_ENABLED. When off,
  // both transports return { skipped }. Default off — code ships
  // dormant until ops flips the env var.
  if (!isNotificationsWhatsAppEnabled()) {
    console.log('[WA] notifications.whatsapp disabled — skipped', { to: maskPhone(to), template });
    return { skipped: true, reason: 'flag_off' };
  }

  if (!to || !template) {
    console.warn('[WA] missing to/template');
    return { skipped: true };
  }

  // ── OpenClaw transport branch ───────────────────────────────────────
  // Composes a free-form bilingual body (openclawTemplates.js) and
  // POSTs to the Mac mini gateway. Returns the same { ok, data } /
  // { ok: false, error } shape as the Meta branch so notification_worker
  // can treat both transports identically.
  if (whatsappTransport() === 'openclaw') {
    const ocLang = lang === 'ar' ? 'ar' : 'en';
    const body = getOpenClawBody(template, ocLang, vars, { orderId });

    if (!body) {
      console.warn('[WA→OC] no openclaw template for event', { template, lang: ocLang });
      // Treat as skipped (not failed) so the worker doesn't retry. A
      // missing event mapping is a deployment gap, not a transient
      // error — retrying won't help.
      return { skipped: true, reason: 'no_openclaw_template' };
    }

    const result = await sendViaOpenClaw({
      to,
      lang: ocLang,
      body,
      ref: orderId || (vars && (vars.order_id || vars.orderId)) || null,
      userId,
      template
    });
    return result;
  }

  // ── Meta Cloud API transport (legacy, currently blocked) ────────────
  // Retained for back-compat and OTP path (the OTP flow has its own
  // call site outside this function, so this branch is reachable only
  // for case-lifecycle templates when transport is explicitly 'meta').
  if (!isEnabled()) {
    console.log('[WA] meta disabled — skipped', { to: maskPhone(to), template });
    return { skipped: true };
  }

  const phoneNumberId = String(WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const apiVersion = waApiVersion();
  const token = String(WHATSAPP_ACCESS_TOKEN || '').trim();

  // Normalize phone numbers: WhatsApp Cloud API expects digits with country code, no leading +
  const normalizedTo = String(to).replace(/[^0-9]/g, '');

  if (!phoneNumberId || !apiVersion || !token) {
    console.error('[WA] misconfigured env', {
      hasPhoneNumberId: !!phoneNumberId,
      hasApiVersion: !!apiVersion,
      tokenLen: token.length,
      to: maskPhone(normalizedTo),
      template
    });
    logWhatsAppError({ message: 'wa_env_misconfigured', to: normalizedTo, template, lang, error: 'env_missing' });
    return { ok: false, error: 'wa_env_misconfigured' };
  }

  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    console.error('[WA] invalid api version', { apiVersion });
    logWhatsAppError({ message: 'wa_invalid_api_version', to: normalizedTo, template, lang, error: apiVersion });
    return { ok: false, error: 'wa_invalid_api_version' };
  }

  if (!/^\d+$/.test(phoneNumberId)) {
    console.error('[WA] invalid phone number id', { phoneNumberId });
    logWhatsAppError({ message: 'wa_invalid_phone_number_id', to: normalizedTo, template, lang, error: 'bad_phone_number_id' });
    return { ok: false, error: 'wa_invalid_phone_number_id' };
  }

  try {
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    const templateObj = {
      name: template,
      language: { code: lang }
    };

    const varValues = (vars && typeof vars === 'object') ? Object.values(vars) : [];
    if (varValues.length) {
      templateObj.components = [{
        type: 'body',
        parameters: varValues.map(v => ({ type: 'text', text: String(v) }))
      }];
    }

    const body = {
      messaging_product: 'whatsapp',
      to: normalizedTo,
      type: 'template',
      template: templateObj
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[WA] send failed', {
        status: res.status,
        statusText: res.statusText,
        url,
        response: data
      });
      logWhatsAppError({
        message: 'wa_meta_api_error',
        to: normalizedTo,
        template,
        lang,
        status: res.status,
        error: data && data.error ? data.error : data
      });
      return { ok: false, error: data, status: res.status };
    }

    console.log('[WA] sent', { to: maskPhone(normalizedTo), template });
    return { ok: true, data };
  } catch (err) {
    console.error('[WA] exception', err);
    logWhatsAppError({
      message: 'wa_send_exception',
      to: normalizedTo,
      template,
      lang,
      error: err && err.message ? err.message : String(err)
    });
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsApp };