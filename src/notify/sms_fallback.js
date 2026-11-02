'use strict';

// src/notify/sms_fallback.js — one delivered copy per channel, and SMS when
// WhatsApp cannot reach a patient (patient recovery, Parts E and B, 2 Nov 2026).
//
// ── PART E: why a patient got the same WhatsApp three times ─────────────────
//
// 14 Oct, case TSH-2026-000020, a phone-only patient. Production holds ONE
// notifications row per (case, level, channel) — the sweep's dedupe is per
// (order, level) and the sweep never re-armed anything (queuePaymentReminder
// checks the key whatever the row's status). But that one whatsapp row went to
// the Mac mini three times: 09:59:48, 10:00:47, 10:03:18 — the worker's retry
// ladder (30 s, 120 s) on an http_502 — and again at 15:29/15:30/15:33 for the
// 6h level. The gateway records each as a separate send (three message ids),
// and OpenClaw persists every outbound message in its own delivery queue
// before attempting it and replays pending ones when WhatsApp reconnects. A
// 502 from the mini is therefore "outcome unknown", not "not delivered", and
// every retry is one more copy waiting to go out.
//
// The rule now, for the templates on the SMS allowlist (notify/sms_templates)
// sent to a patient:
//   * a WhatsApp attempt that may have reached OpenClaw is the LAST WhatsApp
//     attempt for that row — the row is written 'failed' at once, never
//     retried, never re-armed by queueNotification, never re-queued by the
//     stuck-'sending' recovery;
//   * an attempt that provably reached nothing (lib/openclaw_client `outcome:
//     'not_sent'`: a refusal, Cloudflare 530, no connection, missing config)
//     keeps the ordinary retry ladder — retrying it cannot duplicate anything;
//   * a WhatsApp row that ends failed (or skipped for a reason other than the
//     patient's own opt-out or having no phone) falls back to ONE sms row, in
//     the worker, never in the callers.
// Every other template keeps today's behaviour; doctor messages are out of
// scope for this job.
//
// ── PART B: when exactly an SMS goes ────────────────────────────────────────
//
// For an allowlisted template to a patient, once the WhatsApp row for the same
// event has its final status:
//   WhatsApp sent                          → no SMS, ever.
//   WhatsApp failed / skipped (not opt-out,
//     not no-phone), AND the patient has no
//     email, or the email row ended skipped
//     or failed, or no email was queued     → one sms row.
//   either row still queued / retrying     → nothing yet; whichever finishes
//                                            last asks again.
// The worker learns the WhatsApp outcome from the gateway's synchronous answer
// to POST /send — it never polls the mini. A 202 ("accepted, sending async")
// is recorded as sent and gets no SMS: the gateway has no delivery callback to
// the portal, so a send that fails after the 202 is invisible here (15 Oct, the
// 24h reminder: 'sent' in notifications, 'failed' in the gateway log).
//
// The sms row's dedupe key is the WhatsApp row's key with the channel swapped
// (payment_reminder:30m:whatsapp:… → payment_reminder:30m:sms:…; a key with no
// channel in it, like draft_resume:<order>:<level>, is used as it is), or
// sms_fallback:<whatsapp row id> when the WhatsApp row had none. Either way one
// WhatsApp failure can produce one SMS row, however many times this is asked.

const { isSmsAllowlisted, renderSms } = require('./sms_templates');
const { isCairoQuietHours, nextCairoTime } = require('../utils/cairo_quiet_hours');

// QUIET HOURS (follow-up, 2 Nov 2026) — no patient SMS between 21:00 and 09:00
// Cairo (Egypt's operator curfew is 21:00–09:00; Twilio EG guidelines). A fallback that comes due at night is DEFERRED, never dropped: the
// worker leaves the row queued with retry_after at the next 09:00 Cairo and
// sends it then, after the caps are checked at that moment. WhatsApp and
// in-app are untouched; the draft nudges are already 08:00–22:00 only.
const SMS_QUIET = Object.freeze({ startHour: 21, endHour: 9 });

const FINAL_STATUSES = new Set(['sent', 'failed', 'skipped']);
// A WhatsApp skip for these reasons is the patient's own state, not a delivery
// problem: the opt-out store is the same one SMS honours, and no phone means
// nothing to text.
const NO_FALLBACK_SKIPS = new Set(['whatsapp_opted_out', 'no_phone_for_user']);

const DEFAULT_DAILY_CAP = 100;
const PER_PATIENT_CAP = 3;

function isPatient(user) { return String((user && user.role) || '').toLowerCase() === 'patient'; }

function _parse(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { const j = JSON.parse(v); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}

/** Did a failed WhatsApp send provably reach nothing? 'not_sent' | 'unknown'. */
function whatsappOutcome(result) {
  const r = result || {};
  if (r.outcome === 'not_sent' || r.outcome === 'unknown') return r.outcome;
  // The worker's own refusals (no template mapped) never left the portal.
  if (r.permanent) return 'not_sent';
  return 'unknown';
}

/**
 * Is this failed WhatsApp attempt the last one for its row? Pure.
 * True for an allowlisted template to a patient whose send may have reached
 * OpenClaw.
 */
function whatsappFailureIsFinal(template, user, result) {
  return isSmsAllowlisted(template) && isPatient(user) && whatsappOutcome(result) !== 'not_sent';
}

/** Templates whose whatsapp and sms rows must never be re-armed or re-queued. */
function isSingleShot(channel, template) {
  return (channel === 'whatsapp' || channel === 'sms') && isSmsAllowlisted(template);
}

/** The same event's key on another channel. Pure. */
function channelKey(dedupeKey, fromChannel, toChannel) {
  if (!dedupeKey) return null;
  const k = String(dedupeKey);
  const seg = ':' + fromChannel + ':';
  return k.indexOf(seg) !== -1 ? k.replace(seg, ':' + toChannel + ':') : k;
}

/**
 * The decision, given what is known about the event. Pure.
 * @param {object} s
 * @param {string} s.waStatus      final status of the whatsapp row, or null if none / not final
 * @param {string} [s.waSkip]      the whatsapp row's skip reason
 * @param {boolean} s.waExists
 * @param {boolean} s.hasEmail     the user has an email on file
 * @param {boolean} s.emailExists  an email row exists for this event
 * @param {string} [s.emailStatus] its status
 * @returns {'send'|'wait'|'none'}
 */
function fallbackDecision(s) {
  if (!s.waExists) return 'none';
  if (!FINAL_STATUSES.has(String(s.waStatus || ''))) return 'wait';
  if (s.waStatus === 'sent') return 'none';
  if (s.waStatus === 'skipped' && NO_FALLBACK_SKIPS.has(String(s.waSkip || ''))) return 'none';
  if (!s.hasEmail || !s.emailExists) return 'send';
  if (s.emailStatus === 'skipped' || s.emailStatus === 'failed') return 'send';
  if (s.emailStatus === 'sent') return 'none';
  return 'wait';
}

async function _sibling(queryOne, row, channel) {
  const key = channelKey(row.dedupe_key, row.channel, channel);
  if (key) {
    return queryOne(
      'SELECT id, status, response, dedupe_key, at FROM notifications WHERE dedupe_key = $1 AND channel = $2 AND to_user_id = $3 ORDER BY at DESC NULLS LAST LIMIT 1',
      [key, channel, row.to_user_id]);
  }
  // No key (report_ready_patient is queued without one): the same event is the
  // same template, recipient and case, queued within a few minutes.
  return queryOne(
    `SELECT id, status, response, dedupe_key, at FROM notifications
      WHERE channel = $1 AND to_user_id = $2 AND template = $3
        AND order_id IS NOT DISTINCT FROM $4
        AND at BETWEEN ($5::timestamp - INTERVAL '10 minutes') AND ($5::timestamp + INTERVAL '10 minutes')
      ORDER BY at DESC NULLS LAST LIMIT 1`,
    [channel, row.to_user_id, row.template, row.order_id || null, row.at]);
}

/**
 * Called by the worker right after it writes a FINAL status on a whatsapp or
 * email row. Queues the one sms row when fallbackDecision says so. Never throws.
 *
 * @param {object} row       the notifications row (id, channel, template, to_user_id, order_id, dedupe_key, at, response)
 * @param {object} user      { id, role, phone, email }
 * @param {string} status    the status just written
 * @param {object} [result]  what the channel returned (for the skip reason)
 * @param {object} [deps]    { queryOne, queueNotification } for tests
 */
async function maybeQueueSmsFallback(row, user, status, result, deps) {
  try {
    if (!row || (row.channel !== 'whatsapp' && row.channel !== 'email')) return { queued: false, reason: 'channel' };
    if (!isSmsAllowlisted(row.template)) return { queued: false, reason: 'not_allowlisted' };
    if (!isPatient(user) || !user.phone) return { queued: false, reason: 'not_reachable_by_sms' };
    const d = deps || {};
    const queryOne = d.queryOne || require('../pg').queryOne;

    let wa = null; let email = null;
    // processWhatsApp answers { skipped: '<reason>' }; notify/whatsapp.js
    // answers { skipped: true, reason: '<reason>' }.
    const selfSkip = result ? (typeof result.skipped === 'string' ? result.skipped : (result.reason || null)) : null;
    if (row.channel === 'whatsapp') {
      wa = { id: row.id, status, dedupe_key: row.dedupe_key, skip: selfSkip, response: row.response };
      email = await _sibling(queryOne, row, 'email');
    } else {
      email = { status };
      const s = await _sibling(queryOne, row, 'whatsapp');
      if (s) wa = { id: s.id, status: s.status, dedupe_key: s.dedupe_key, skip: _parse(s.response).skipped || _parse(s.response).reason || null, response: s.response };
    }

    const decision = fallbackDecision({
      waExists: !!wa,
      waStatus: wa && wa.status,
      waSkip: wa && wa.skip,
      hasEmail: !!(user.email && String(user.email).trim()),
      emailExists: !!email,
      emailStatus: email && email.status,
    });
    if (decision !== 'send') return { queued: false, reason: decision };

    const smsKey = channelKey(wa.dedupe_key, 'whatsapp', 'sms') || ('sms_fallback:' + wa.id);
    // The payload of the row being finalised, as it was queued (the worker
    // passes the claimed row). Never the sibling's stored response: once a
    // row is final its response column holds the channel's result instead.
    const base = _parse(row.response);
    const queue = d.queueNotification || require('../notify').queueNotification;
    const r = await queue({
      channel: 'sms',
      toUserId: user.id,
      orderId: row.order_id || null,
      template: row.template,
      dedupeKey: smsKey,
      dedupe_key: smsKey,
      response: Object.assign({}, base, { fallback_of: wa.id }),
    });
    return { queued: !!(r && r.ok !== false && !r.skipped), dedupeKey: smsKey };
  } catch (err) {
    console.error('[sms-fallback] could not decide/queue', err && err.message);
    return { queued: false, reason: 'error' };
  }
}

function dailyCap(env) {
  const n = parseInt(String((env || process.env).SMS_DAILY_CAP || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

function cairoDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
}

// notifications.at is timestamp WITHOUT time zone holding UTC digits.
const CAIRO_MIDNIGHT_UTC_SQL = "((date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC')";

/**
 * Process one claimed sms row for the worker. Returns the worker's result
 * shape: { ok: true, … } | { skipped: '<reason>' } | { ok: false, error,
 * permanent: true } | { deferUntil: '<ISO>' } (quiet hours — the worker
 * re-queues the row for then, payload and attempts untouched). An SMS is never
 * retried — a failure is final.
 */
async function processSms(n, user, order, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  if (!isSmsAllowlisted(n.template)) return { skipped: 'sms_not_allowlisted' };
  if (!isPatient(user)) return { skipped: 'sms_not_patient' };
  if (!user.phone) return { skipped: 'no_phone_for_user' };
  // The same consent store WhatsApp honours (users.notify_whatsapp, written by
  // routes/openclaw-api.js when a patient replies STOP to the gateway).
  if (user.notify_whatsapp === false || user.notify_whatsapp === 0) return { skipped: 'sms_opted_out' };

  const provider = d.provider || require('./sms_provider');
  if (!provider.isSmsConfigured(env)) return { skipped: 'sms_unconfigured' };

  const now = d.now || new Date();
  if (isCairoQuietHours(now, SMS_QUIET)) {
    return { deferUntil: nextCairoTime(now, SMS_QUIET.endHour).toISOString(), reason: 'sms_quiet_hours' };
  }

  const lang = String(user.lang || '').toLowerCase() === 'ar' ? 'ar' : 'en';
  const msg = renderSms(n.template, lang, _parse(n.response), n.order_id || (order && order.id) || null);
  if (!msg) return { skipped: 'sms_not_allowlisted' };

  const queryOne = d.queryOne || require('../pg').queryOne;
  const mine = await queryOne(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE channel = 'sms' AND to_user_id = $1 AND id <> $2
        AND (status = 'sent' OR status = 'sending')
        AND at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'`, [n.to_user_id, n.id]);
  if (((mine && mine.n) || 0) >= PER_PATIENT_CAP) return { skipped: 'sms_patient_cap' };

  const cap = dailyCap(env);
  const today = await queryOne(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE channel = 'sms' AND id <> $1 AND (status = 'sent' OR status = 'sending')
        AND at >= ${CAIRO_MIDNIGHT_UTC_SQL}`, [n.id]);
  if (((today && today.n) || 0) >= cap) {
    try {
      const push = d.pushOpsEvent || require('../services/ops_push').pushOpsEvent;
      await push({
        kind: 'sms_cap',
        dedupeKey: cairoDay(now),
        title: 'SMS daily cap reached',
        body: 'SMS fallback stopped for today at ' + cap + ' messages (SMS_DAILY_CAP). Later fallbacks are written skipped.',
        data: { screen: 'system' },
        defaultMode: 'quiet',
      });
    } catch (_) { /* the push is a courtesy; the skip is the record */ }
    return { skipped: 'sms_cap' };
  }

  if (String(env.NOTIFICATION_DRY_RUN || '').toLowerCase() === 'true') {
    return { ok: true, dryRun: true, length: msg.body.length };
  }

  const r = await provider.sendSms({ to: user.phone, body: msg.body, ref: n.order_id || null }, { env });
  if (r && r.skipped) return { skipped: r.reason || 'sms_skipped' };
  if (r && r.ok) {
    return { ok: true, provider: r.provider || null, sid: r.sid || null, status: r.status || null,
             price: r.price != null ? r.price : null, price_unit: r.priceUnit || null,
             segments: r.segments != null ? r.segments : null, length: msg.body.length, lang };
  }
  return { ok: false, permanent: true, error: (r && r.error) || 'sms_send_failed', outcome: (r && r.outcome) || 'unknown' };
}

module.exports = {
  whatsappOutcome, whatsappFailureIsFinal, isSingleShot, channelKey, fallbackDecision,
  maybeQueueSmsFallback, processSms, dailyCap, PER_PATIENT_CAP, DEFAULT_DAILY_CAP, NO_FALLBACK_SKIPS, SMS_QUIET,
};
