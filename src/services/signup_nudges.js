'use strict';

// Signed up, never started a case — two templated nudges (26 Sep 2026).
//
// Ziad's rule: no AI for this. These are fixed WhatsApp + in-app messages
// queued through the normal notification pipeline (same path as the payment
// reminders), so they cost nothing per send and read exactly as approved.
//
//   signup_no_case_1h   — ≥ 1h after signup, still no case
//   signup_no_case_24h  — ≥ 24h after signup, still no case
//
// Guards: at most these two, ever (dedupe key per user + level); nothing
// between 22:00 and 09:00 Cairo (the next sweep after 09:00 sends it); only
// accounts created after FEATURE_START so old test accounts are never
// messaged; staff/test domains skipped; stops the moment any case exists.

const { queryAll } = require('../pg');

const FEATURE_START = '2026-09-26T18:00:00Z';
const LEVELS = [
  { level: '24h', minAgeH: 24, maxAgeH: 72 },
  { level: '1h',  minAgeH: 1,  maxAgeH: 24 }
];
const SKIP_EMAIL = /@(tashkheesa\.com|shifaegypt\.com)$/i;

function cairoHour(now) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(now);
  return Number(h) % 24;
}
function inQuietHours(now) {
  const h = cairoHour(now || new Date());
  return h >= 22 || h < 9;
}

function levelFor(ageHours) {
  for (const l of LEVELS) if (ageHours >= l.minAgeH && ageHours < l.maxAgeH) return l.level;
  return null;
}

function firstName(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  return s.length > 20 ? '' : s;
}

async function runSignupNudgeSweep(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  if (!o.ignoreQuietHours && inQuietHours(now)) return { ok: true, skipped: 'quiet_hours', queued: 0 };

  const rows = await queryAll(
    `SELECT u.id, u.name, u.email, u.lang, u.country_code, u.created_at
       FROM users u
      WHERE u.role = 'patient'
        AND COALESCE(u.is_active, true) = true
        AND u.phone IS NOT NULL AND u.phone <> ''
        AND u.created_at >= $1
        AND u.created_at <= NOW() - INTERVAL '1 hour'
        AND u.created_at >= NOW() - INTERVAL '72 hours'
        -- include-deleted-ok: ANY case, even an auto-deleted unpaid one, means they already started — no nudge.
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.patient_id = u.id)
      ORDER BY u.created_at ASC
      LIMIT 200`,
    [FEATURE_START]
  );

  const { queueNotification } = o.notify || require('../notify');
  const base = process.env.APP_URL || 'https://tashkheesa.com';
  let queued = 0;
  for (const u of rows) {
    if (u.email && SKIP_EMAIL.test(String(u.email))) continue;
    const ageH = (now.getTime() - new Date(u.created_at).getTime()) / 3600000;
    const level = levelFor(ageH);
    if (!level) continue;
    const lang = (String(u.lang || '').toLowerCase() === 'ar' || String(u.country_code || '').toUpperCase() === 'EG') ? 'ar' : 'en';
    const payload = {
      patientName: firstName(u.name),
      link: base + '/patient/new-case' + (lang === 'ar' ? '?lang=ar' : ''),
      level: level,
      lang: lang
    };
    for (const channel of ['whatsapp', 'internal']) {
      const dedupeKey = `signup_no_case:${level}:${channel}:${u.id}`;
      try {
        const r = await queueNotification({
          channel, toUserId: u.id, template: `signup_no_case_${level}`,
          dedupeKey, dedupe_key: dedupeKey, response: payload, recipientLang: lang
        });
        if (r && r.ok !== false && !r.deduped && !r.skipped) queued++;
      } catch (e) {
        console.error('[signup-nudge] queue failed', u.id, level, channel, e && e.message);
      }
    }
  }
  return { ok: true, candidates: rows.length, queued };
}

module.exports = { runSignupNudgeSweep, inQuietHours, levelFor, FEATURE_START };
