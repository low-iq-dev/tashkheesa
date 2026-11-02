'use strict';

// src/services/draft_nudges.js — the draft-resume nudge (patient recovery,
// Part A, 2 Nov 2026).
//
// A patient who starts a case and stops gets two reminders that reopen THAT
// draft, and nothing else. Fixed copy, EN + AR, no AI (notify/openclawTemplates,
// notify/sms_templates, the draft-resume email). Runs every 15 minutes on
// pg-boss (job_queue.scheduleDraftNudges), heartbeating as 'draft_nudges'.
//
// ELIGIBLE — every clause must hold (ELIGIBLE_DRAFTS_SQL; JS for the email):
//   * status is draft, either casing. The web wizard and the app both INSERT
//     'DRAFT'; db.js lowercases every status at boot, so a draft reads 'DRAFT'
//     until the next deploy and 'draft' after it (TSH-2026-000026/27 vs
//     000021–23 on production).
//   * a real case: not is_practice, not a demo/practice source, not deleted;
//   * a patient: role 'patient', active, and the email — when there is one —
//     passes services/recipientGuard (test/demo addresses). recipientGuard is
//     EMAIL-ONLY: validateRecipient(null) throws missing_or_empty, so applied
//     to a phone-only patient it would block exactly the patients this exists
//     for (see the report, parked item F9). A patient with no email passes;
//     staff domains are excluded as the signup nudges exclude them;
//   * there is something to come back to: a clinical question of 10+
//     characters, or at least one file;
//   * idle: no activity for 60 minutes. Activity is the later of
//     orders.updated_at (every wizard step and upload writes it) and the last
//     time a resume link was opened (draft_resume_tokens.last_opened_at). This
//     sweep never writes orders.updated_at: it is also the draft's 30-day
//     expiry clock;
//   * at most 7 days old;
//   * the newest case the patient has: no case of any status created after it
//     (a newer draft, or a case they went on to submit);
//   * not opted out: users.notify_whatsapp is not false — the store the gateway
//     honours (routes/openclaw-api.js writes it when a patient replies STOP);
//   * no coverage lead for this draft (Part C — that patient is waiting for us).
//
// LADDER — draft_resume_1h at 60 minutes idle, draft_resume_24h at 24 hours
// idle; never a third. Dedupe key draft_resume:<order_id>:<level> on every
// channel. Once the 24h has gone, nothing more. When the sweep first sees a
// draft already 24 hours idle, only the 24h goes (the higher level, as the
// payment ladder does) — and the 1h can never follow it.
//
// QUIET HOURS — nothing between 22:00 and 08:00 Cairo; a due nudge goes with
// the first sweep after 08:00 (utils/cairo_quiet_hours).
//
// CHANNELS — internal (always), whatsapp (when there is a phone), email (when
// there is one and it passes the guard). SMS is not queued here: the worker
// adds it when the WhatsApp row fails and no email reached the patient
// (notify/sms_fallback.js). Part A asks for "WhatsApp, then SMS, then email";
// Part B's worker rule ("SMS only when the email is absent or failed") is
// applied instead, so a patient with a working email is not also texted.
//
// FUNNEL — funnel_daily_counts steps draft_resume_sent (one per nudge),
// draft_resumed (first open of a link, services/draft_resume) and
// draft_resume_converted (submitted within 72 hours of a nudge, counted here).

const { isCairoQuietHours } = require('../utils/cairo_quiet_hours');
const draftResume = require('./draft_resume');

const LEVELS = Object.freeze([
  Object.freeze({ level: '24h', idleMinutes: 24 * 60 }),
  Object.freeze({ level: '1h', idleMinutes: 60 }),
]);
const QUIET = Object.freeze({ startHour: 22, endHour: 8 });
const STAFF_EMAIL = /@(tashkheesa\.com|shifaegypt\.com)$/i;
const LIMIT = 200;

/** The SQL half of eligibility. $1 = limit. */
const ELIGIBLE_DRAFTS_SQL = `
  SELECT o.id, o.patient_id, o.reference_id, o.created_at, o.status,
         GREATEST(COALESCE(o.updated_at, o.created_at), COALESCE(t.last_opened_at, '-infinity'::timestamptz)) AS activity_at,
         u.email, u.phone, u.lang, u.country_code,
         ARRAY(SELECT DISTINCT split_part(n.dedupe_key, ':', 3) FROM notifications n
                WHERE n.dedupe_key LIKE 'draft\\_resume:' || o.id || ':%' AND n.channel = 'internal') AS levels_sent
    FROM orders o
    JOIN users u ON u.id = o.patient_id
    LEFT JOIN LATERAL (SELECT MAX(last_opened_at) AS last_opened_at FROM draft_resume_tokens WHERE order_id = o.id) t ON true
   WHERE UPPER(COALESCE(o.status, '')) = 'DRAFT'
     AND o.deleted_at IS NULL
     AND COALESCE(o.is_practice, false) = false
     AND COALESCE(o.source, '') NOT IN ('demo_appreview', 'practice_seed')
     AND u.role = 'patient'
     AND COALESCE(u.is_active, true) = true
     AND u.notify_whatsapp IS DISTINCT FROM false
     AND (LENGTH(TRIM(COALESCE(o.clinical_question, ''))) >= 10
          OR EXISTS (SELECT 1 FROM order_files f WHERE f.order_id = o.id))
     AND o.created_at >= NOW() - INTERVAL '7 days'
     AND GREATEST(COALESCE(o.updated_at, o.created_at), COALESCE(t.last_opened_at, '-infinity'::timestamptz)) <= NOW() - INTERVAL '60 minutes'
     AND NOT EXISTS (SELECT 1 FROM orders o2
                      WHERE o2.patient_id = o.patient_id AND o2.id <> o.id
                        AND o2.deleted_at IS NULL AND o2.created_at > o.created_at)
     AND NOT EXISTS (SELECT 1 FROM coverage_leads cl WHERE cl.order_id = o.id)
   ORDER BY o.created_at ASC
   LIMIT $1`;

/**
 * Which nudge is due, given how long the draft has been idle and which levels
 * have gone. Pure. null = nothing.
 */
function dueLevel(idleMinutes, levelsSent) {
  const sent = new Set(levelsSent || []);
  if (sent.has('24h')) return null;
  for (const l of LEVELS) {
    if (idleMinutes >= l.idleMinutes) return sent.has(l.level) ? null : l.level;
  }
  return null;
}

function langFor(u) {
  return (String(u.lang || '').toLowerCase() === 'ar' || (!u.lang && String(u.country_code || '').toUpperCase() === 'EG')) ? 'ar' : 'en';
}

/**
 * The email half of eligibility: { nudge: boolean, email: string|null }.
 * A test-looking or staff address excludes the patient from every channel; no
 * email at all is fine (recipientGuard has nothing to check).
 */
async function emailVerdict(email, deps) {
  const e = String(email || '').trim();
  if (!e) return { nudge: true, email: null };
  if (STAFF_EMAIL.test(e)) return { nudge: false, email: null };
  const guard = (deps && deps.recipientGuard) || require('./recipientGuard');
  try { await guard.validateRecipient(e); return { nudge: true, email: e }; }
  catch (_) { return { nudge: false, email: null }; }
}

/** Count drafts submitted within 72 h of a nudge. Returns the order ids counted. */
async function countConversions(deps) {
  const pg = (deps && deps.pg) || require('../pg');
  const rows = await pg.queryAll(
    `UPDATE draft_resume_tokens t
        SET converted_at = o.submitted_at
       FROM orders o
      WHERE t.order_id = o.id
        AND o.deleted_at IS NULL
        AND t.converted_at IS NULL
        AND t.level IN ('1h', '24h')
        AND o.submitted_at IS NOT NULL
        AND o.submitted_at >= t.created_at
        AND o.submitted_at <= t.created_at + INTERVAL '72 hours'
    RETURNING t.order_id, o.submitted_at`, []);
  const seen = new Map();
  (rows || []).forEach((r) => { if (!seen.has(r.order_id)) seen.set(r.order_id, r.submitted_at); });
  for (const [, at] of seen) await draftResume.bumpFunnelStep('draft_resume_converted', new Date(at), deps);
  return Array.from(seen.keys());
}

/**
 * One pass. Never throws; returns a summary.
 * @param {object} [opts] { now, ignoreQuietHours, notify, pg, recipientGuard }
 */
async function runDraftNudgeSweep(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const out = { ok: true, candidates: 0, nudged: 0, converted: 0 };
  try { out.converted = (await countConversions(o)).length; }
  catch (err) { console.error('[draft-nudges] conversion count failed', err && err.message); }
  // Part C — a coverage lead whose draft has since been sent is converted.
  try { out.leadsConverted = await require('./coverage_leads').markConverted(o); }
  catch (err) { console.error('[draft-nudges] coverage conversion failed', err && err.message); }

  if (!o.ignoreQuietHours && isCairoQuietHours(now, QUIET)) return Object.assign(out, { skipped: 'quiet_hours' });

  const pg = o.pg || require('../pg');
  let rows = [];
  try { rows = (await pg.queryAll(ELIGIBLE_DRAFTS_SQL, [LIMIT])) || []; }
  catch (err) {
    console.error('[draft-nudges] candidate query failed', err && err.message);
    return Object.assign(out, { ok: false, error: String(err && err.message || err) });
  }
  out.candidates = rows.length;

  const { queueNotification } = o.notify || require('../notify');
  for (const d of rows) {
    try {
      const idle = (now.getTime() - new Date(d.activity_at).getTime()) / 60000;
      const level = dueLevel(idle, d.levels_sent);
      if (!level) continue;
      const verdict = await emailVerdict(d.email, o);
      if (!verdict.nudge) continue;

      const lang = langFor(d);
      const tok = await draftResume.mintToken({ orderId: d.id, patientId: d.patient_id, level, now }, o);
      const template = 'draft_resume_' + level;
      const dedupeKey = 'draft_resume:' + d.id + ':' + level;
      const payload = { case_id: d.id, caseReference: d.reference_id || null, resume_token_id: tok.id, level, lang };
      const channels = ['internal'];
      if (d.phone) channels.push('whatsapp');
      if (verdict.email) channels.push('email');
      let queuedInternal = false;
      for (const channel of channels) {
        const r = await queueNotification({ channel, toUserId: d.patient_id, orderId: d.id, template, dedupeKey, dedupe_key: dedupeKey, response: payload, recipientLang: lang });
        if (channel === 'internal' && r && r.ok !== false && !r.skipped) queuedInternal = true;
      }
      if (queuedInternal) {
        out.nudged++;
        await draftResume.bumpFunnelStep('draft_resume_sent', now, o);
      }
    } catch (err) {
      console.error('[draft-nudges] draft ' + d.id + ' failed', err && err.message);
    }
  }
  return out;
}

module.exports = { runDraftNudgeSweep, dueLevel, emailVerdict, countConversions, langFor, ELIGIBLE_DRAFTS_SQL, QUIET, LEVELS };
