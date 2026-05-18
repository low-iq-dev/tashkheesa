// src/routes/openclaw-api.js
// Inbound endpoints called BY OpenClaw (Mac mini → portal).
//
// Auth scope: distinct from /api/tash/stats. The portal uses
// TASH_API_KEY for portal→OpenClaw outbound (stats reads, etc.);
// OpenClaw uses OPENCLAW_SEND_KEY for OpenClaw→portal inbound
// (opt-out, opt-in, future inbound events). Keeping the two keys
// separate means either side can rotate independently without
// breaking the other direction.
//
// Mount: /api/openclaw/* — chosen over /api/tash/* so the URL itself
// signals which auth scope applies. The /api/tash/ namespace stays
// pinned to TASH_API_KEY.
//
// Endpoints:
//   POST /api/openclaw/opt-out { phone } → { ok, updated }
//   POST /api/openclaw/opt-in  { phone } → { ok, updated }
//
// Called from OpenClaw's inbound STOP/START regex handler (spec in
// the design proposal). Phone arrives as the inbound sender's number
// in E.164; we normalize via the same validator the patient profile
// page uses to guarantee an exact match against users.phone.

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { execute, queryAll } = require('../pg');
const { validatePhoneE164 } = require('../validators/phone');
const { maskPhone } = require('../utils/mask');

const OPENCLAW_SEND_KEY = process.env.OPENCLAW_SEND_KEY;

if ((!OPENCLAW_SEND_KEY || !OPENCLAW_SEND_KEY.trim()) && process.env.NODE_ENV === 'production') {
  // Soft warning in prod — the routes themselves 401 every request
  // until the key is set, so unauthenticated access is impossible.
  // We don't throw to avoid a boot loop while ops finishes wiring.
  console.warn('[openclaw-api] OPENCLAW_SEND_KEY is unset — opt-in/opt-out endpoints will reject all requests until configured.');
}

function requireOpenClawKey(req, res, next) {
  const key = req.headers['x-openclaw-key'];
  if (!OPENCLAW_SEND_KEY || !key || key !== OPENCLAW_SEND_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

async function logOptOptIn({ action, phone, updated, userId }) {
  try {
    const context = JSON.stringify({
      action,
      phone: phone ? maskPhone(phone) : null,
      updated
    }).slice(0, 4000);
    await execute(
      `INSERT INTO error_logs (id, category, level, message, context, user_id, created_at)
       VALUES ($1, $2, 'info', $3, $4, $5, NOW())`,
      [
        randomUUID(),
        action === 'opt_out' ? 'whatsapp_optout' : 'whatsapp_optin',
        action === 'opt_out' ? 'whatsapp opt-out via reply-STOP' : 'whatsapp opt-in via reply-START',
        context,
        userId || null
      ]
    ).catch(() => { /* swallow — log writer never throws */ });
  } catch (_) { /* never throw */ }
}

async function applyPreference({ rawPhone, value }) {
  if (!rawPhone) return { error: 'missing_phone', status: 400 };
  const v = validatePhoneE164(rawPhone, 'en');
  if (!v.ok) {
    return { error: 'invalid_phone', status: 400 };
  }
  const normalized = v.normalized;

  // Match users by exact normalized phone. Rare edge case: shared
  // phone across multiple accounts (e.g. family member) — update all
  // matches and return the count.
  const matches = await queryAll(
    'SELECT id FROM users WHERE phone = $1',
    [normalized]
  );
  if (!matches.length) {
    return { ok: true, updated: 0, status: 404 };
  }

  await execute(
    'UPDATE users SET notify_whatsapp = $1 WHERE phone = $2',
    [value, normalized]
  );

  return { ok: true, updated: matches.length, status: 200, normalized, userId: matches[0].id };
}

router.post('/api/openclaw/opt-out', requireOpenClawKey, async (req, res) => {
  const phone = req.body && req.body.phone ? String(req.body.phone) : '';
  const r = await applyPreference({ rawPhone: phone, value: false });
  if (r.error) {
    return res.status(r.status).json({ ok: false, error: r.error });
  }
  if (r.updated === 0) {
    return res.status(404).json({ ok: false, error: 'user_not_found', updated: 0 });
  }
  await logOptOptIn({ action: 'opt_out', phone: r.normalized, updated: r.updated, userId: r.userId });
  return res.json({ ok: true, updated: r.updated });
});

router.post('/api/openclaw/opt-in', requireOpenClawKey, async (req, res) => {
  const phone = req.body && req.body.phone ? String(req.body.phone) : '';
  const r = await applyPreference({ rawPhone: phone, value: true });
  if (r.error) {
    return res.status(r.status).json({ ok: false, error: r.error });
  }
  if (r.updated === 0) {
    return res.status(404).json({ ok: false, error: 'user_not_found', updated: 0 });
  }
  await logOptOptIn({ action: 'opt_in', phone: r.normalized, updated: r.updated, userId: r.userId });
  return res.json({ ok: true, updated: r.updated });
});

module.exports = router;
