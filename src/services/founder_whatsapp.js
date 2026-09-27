'use strict';

// services/founder_whatsapp.js — plain-text WhatsApp to the founder's own
// numbers (27 Sep 2026).
//
// Used for business signals he asked to get on WhatsApp rather than only in the
// Command app: the daily funnel count and new doctor applications. Goes through
// the OpenClaw gateway directly (same reasoning as critical-alert.js: the
// patient-notification kill switch must not silence ops messages).
//
// Recipients: FOUNDER_ALERT_PHONES (comma-separated, digits with country code)
// if set, else the two personal numbers below. NEVER the Tash business number —
// Tash would receive its own alert as an inbound chat.

const DEFAULT_PHONES = ['447383109933', '201277399043'];
const TASH_NUMBER = '201102009886';

function founderPhones() {
  const raw = String(process.env.FOUNDER_ALERT_PHONES || '').trim();
  const list = (raw ? raw.split(',') : DEFAULT_PHONES)
    .map(function (p) { return String(p || '').replace(/[^0-9]/g, ''); })
    .filter(function (p) { return p.length >= 8 && p !== TASH_NUMBER; });
  return Array.from(new Set(list));
}

/**
 * Send `text` to every founder number. Never throws.
 * @returns {Promise<{sent:number, failed:number}>}
 */
async function sendFounderWhatsApp(text, opts) {
  const o = opts || {};
  let sent = 0;
  let failed = 0;
  let send = o.send;
  // Production only (unless a sender is injected). A local run or the test
  // suite must never WhatsApp the founder's real phone.
  if (!send && (String(process.env.NODE_ENV || '').toLowerCase() !== 'production' || process.env.NODE_TEST_CONTEXT)) {
    return { sent: 0, failed: 0, skipped: 'not_production' };
  }
  if (!send) {
    try { send = require('../lib/openclaw_client').sendViaOpenClaw; } catch (_) { return { sent: 0, failed: 1 }; }
  }
  for (const to of founderPhones()) {
    try {
      const r = await send({ to, lang: 'en', body: String(text).slice(0, 3500), ref: o.ref || null, userId: null, template: o.template || 'founder_alert' });
      if (r && r.ok) sent++; else failed++;
    } catch (e) {
      failed++;
      console.error('[founder-whatsapp] send failed', e && e.message);
    }
  }
  return { sent, failed };
}

module.exports = { sendFounderWhatsApp, founderPhones };
