// src/notify/whatsapp.js
const fetch = require('node-fetch');

const {
  WHATSAPP_ENABLED,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_API_VERSION = 'v22.0'
} = process.env;

function isEnabled() {
  return String(WHATSAPP_ENABLED).toLowerCase() === 'true';
}

async function sendWhatsApp({ to, template, lang = 'en_US', vars = {} }) {
  if (!isEnabled()) {
    console.log('[WA] disabled — skipped', { to, template });
    return { skipped: true };
  }

  if (!to || !template) {
    console.warn('[WA] missing to/template');
    return { skipped: true };
  }

  const phoneNumberId = String(WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const apiVersion = String(WHATSAPP_API_VERSION || '').trim();
  const token = String(WHATSAPP_ACCESS_TOKEN || '').trim();

  // Normalize phone numbers: WhatsApp Cloud API expects digits with country code, no leading +
  const normalizedTo = String(to).replace(/[^0-9]/g, '');

  if (!phoneNumberId || !apiVersion || !token) {
    console.error('[WA] misconfigured env', {
      hasPhoneNumberId: !!phoneNumberId,
      hasApiVersion: !!apiVersion,
      tokenLen: token.length,
      to: normalizedTo,
      template
    });
    return { ok: false, error: 'wa_env_misconfigured' };
  }

  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    console.error('[WA] invalid api version', { apiVersion });
    return { ok: false, error: 'wa_invalid_api_version' };
  }

  if (!/^\d+$/.test(phoneNumberId)) {
    console.error('[WA] invalid phone number id', { phoneNumberId });
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
      return { ok: false, error: data, status: res.status };
    }

    console.log('[WA] sent', { to: normalizedTo, template });
    return { ok: true, data };
  } catch (err) {
    console.error('[WA] exception', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsApp };