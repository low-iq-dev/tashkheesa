// src/notify/whatsapp.js
const fetch = require('node-fetch');

const {
  WHATSAPP_ENABLED,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_API_VERSION = 'v19.0'
} = process.env;

function isEnabled() {
  return String(WHATSAPP_ENABLED).toLowerCase() === 'true';
}

async function sendWhatsApp({ to, template, lang = 'en', vars = {} }) {
  if (!isEnabled()) {
    console.log('[WA] disabled — skipped', { to, template });
    return { skipped: true };
  }

  if (!to || !template) {
    console.warn('[WA] missing to/template');
    return { skipped: true };
  }

  try {
    const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: lang },
        components: Object.keys(vars).length
          ? [{
              type: 'body',
              parameters: Object.values(vars).map(v => ({ type: 'text', text: String(v) }))
            }]
          : []
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[WA] send failed', data);
      return { ok: false, error: data };
    }

    console.log('[WA] sent', { to, template });
    return { ok: true, data };
  } catch (err) {
    console.error('[WA] exception', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsApp };