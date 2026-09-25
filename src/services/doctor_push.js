'use strict';

// services/doctor_push.js — push notifications to the doctor app.
//
// THE STATE THIS REPLACES. services/patient_push.js hooks queueNotification's
// 'internal' channel and pushes an allowlist of PATIENT templates. Not one
// doctor-facing template is in that list, so a doctor whose specialty just
// received an urgent case, whose acceptance window is closing, or whose SLA is
// an hour from breach learned about it by opening the app and looking — the
// exact failure the patient side fixed on 2026-08-25.
//
// Same design as patient_push.js, on purpose:
//
//   * one wiring point (the hook beside the patient one in notify.js), not
//     one per call site; bilingual for free because inAppTitle already is
//   * an explicit allowlist, grouped by the app's preference KEY rather than
//     by template — the doctor toggles "deadline reminders", not
//     "sla_reminder_doctor", and a new template joins a bucket in one line
//
// What is new here is the DECISION layer: preferences (a missing row means
// enabled), a locked key the doctor cannot silence, and quiet hours in Cairo
// wall-clock time that a locked key pushes through. That decision is
// shouldPush(), a pure function over already-read inputs, so it is unit
// testable without a database and cannot be wrong in a way a test cannot see.

// pool from ../pg, matching patient_push.js — going through ../db here would
// pull in the migration runner on a module every notification touches. Held
// as module objects and read at CALL time (pg.queryOne, push.sendPushNotification)
// so a hermetic test can stub either by assignment onto the real module.
const pg = require('../pg');
const push = require('../middleware/push');

const LOG = '[doctor-push]';

// The app's preference vocabulary. `locked` keys always push — 'offer' is the
// notification the platform's acceptance window and SLA both depend on, and a
// doctor who silenced it would be timing out cases without knowing they were
// offered. `channel` tells the app which channels the key governs today:
// deadline reminders also go out by email + WhatsApp (case_lifecycle
// dispatchSlaReminders), offers by email + WhatsApp (notify/broadcast.js);
// 'payout' has no emitter yet (no payout notification exists in the portal)
// and is enumerated so the app's settings switch is complete when one lands.
const DOCTOR_PREF_KEYS = Object.freeze([
  { key: 'offer',    locked: true,  channel: 'push_email' },
  { key: 'window',   locked: false, channel: 'push' },
  { key: 'deadline', locked: false, channel: 'push_email' },
  { key: 'message',  locked: false, channel: 'push_email' },
  { key: 'files',    locked: false, channel: 'push' },
  { key: 'payout',   locked: false, channel: 'push_email' },
  { key: 'news',     locked: false, channel: 'email' },
]);

const LOCKED_KEYS = Object.freeze(
  DOCTOR_PREF_KEYS.filter((k) => k.locked).map((k) => k.key)
);

// template -> preference key. Every doctor-facing template registered in
// notify/notification_titles.js or queued from notify.js, notify/broadcast.js,
// case_sla_worker.js, workers/acceptance_watcher.js, case_lifecycle.js and the
// routes. Templates a patient ALSO receives (new_message, sla_reminder_*,
// appointment_reminder) are safe here because pushForDoctorNotification
// checks the recipient's role before anything else.
const DOCTOR_PUSH_TEMPLATES = Object.freeze({
  // offer — a case this doctor can take, or was handed. LOCKED.
  new_case_available:            'offer',   // notify/broadcast.js (internal + email)
  tashkheesa_new_case_urgent:    'offer',   // broadcast, whatsapp channel
  tashkheesa_new_case_fasttrack: 'offer',
  tashkheesa_new_case_standard:  'offer',
  order_assigned_doctor:         'offer',   // services/assign_case.js, routes/api/admin.js
  order_auto_assigned_doctor:    'offer',   // auto_assign.js
  public_order_assigned_doctor:  'offer',
  new_case_assigned_doctor:      'offer',   // routes/superadmin.js
  tashkheesa_case_auto_assigned: 'offer',   // workers/acceptance_watcher.js (whatsapp channel)
  order_reassigned_to_doctor:    'offer',
  order_reassigned_doctor:       'offer',   // case_lifecycle.js reassignment, the receiving doctor

  // window — the acceptance window. No template announces a CLOSING window
  // today (acceptance_watcher acts on the timeout, it does not warn), so the
  // only event in this bucket is the consequence: the case left this doctor's
  // queue after the window ran out or an operator moved it.
  order_reassigned_from_doctor:  'window',  // case_lifecycle.js

  // deadline — the SLA clock on a case the doctor holds.
  sla_reminder_doctor:           'deadline', // case_sla_worker.js pre-breach (internal)
  sla_reminder_24h:              'deadline', // case_lifecycle.dispatchSlaReminders (whatsapp + email today)
  sla_reminder_6h:               'deadline',
  sla_reminder_1h:               'deadline',
  order_sla_pre_breach_doctor:   'deadline',
  order_sla_pre_breach:          'deadline',
  sla_warning_75:                'deadline', // notify.sendSlaReminder levels 75 / 90
  sla_warning_urgent:            'deadline',
  sla_breach:                    'deadline', // notify.sendSlaReminder level 'breach' (whatsapp today)
  sla_breached_doctor:           'deadline',
  order_breached_doctor:         'deadline',
  appointment_reminder:          'deadline', // jobs/appointment_reminders.js, queued to the doctor too

  // message — the patient did something on the thread or the consultation
  // that waits on the doctor.
  new_message:                       'message', // routes/api/conversations.js, routes/messaging.js, routes/patient.js
  patient_reply_info:                'message', // routes/patient.js
  video_slot_review_requested:       'message', // routes/video.js — a proposed time needs the doctor's answer
  video_slot_confirmed_doctor:       'message',
  video_appointment_cancelled_doctor:'message',
  video_no_show_doctor:              'message',

  // files — something new landed on the case.
  patient_uploaded_files_doctor: 'files',   // routes/patient.js
  prescription_unlocked_doctor:  'files',   // routes/admin.js — the prescription add-on is now writable

  // payout — money on the doctor's side. The portal has no payout-confirmed
  // notification yet; payment_success_doctor ("Payment received" for a case
  // they hold) is the one money event addressed to a doctor today.
  payment_success_doctor:        'payout',  // routes/payments.js

  // news — account and platform announcements.
  doctor_approved:               'news',    // services/admin_doctor_approve.js
  doctor_confirm_services:       'news',
});

// Deliberately NOT pushed:
//
//   order_sla_prebreach, sla_breach_superadmin, acceptance_timeout_auto_assigned_admin,
//   admin_* — addressed to operators (notifyAdmins), never to a doctor.
//   chat_conduct_warning — delivered in the thread where it belongs.
//   doctor_rejected / doctor_signup_pending — an applicant has no app session.
//   tashkheesa_case_assigned — the PATIENT's WhatsApp confirmation.

function doctorPushKey(template) {
  const t = String(template || '');
  return Object.prototype.hasOwnProperty.call(DOCTOR_PUSH_TEMPLATES, t) ? DOCTOR_PUSH_TEMPLATES[t] : null;
}

function isLockedKey(key) {
  return LOCKED_KEYS.includes(String(key || ''));
}

// 'HH:MM' | 'HH:MM:SS' | Date-ish -> minutes since midnight, or null.
function hhmmToMinutes(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

// Minutes since midnight on the Cairo wall clock for an instant (default
// now). Intl with the IANA zone, as services/urgency_window.js does, so the
// April/October DST changes are handled by the tz database, not by us.
function cairoMinutesNow(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (type) => { const p = parts.find((x) => x.type === type); return Number(p && p.value); };
  const h = get('hour') % 24; // some ICU builds emit "24" for midnight
  const m = get('minute');
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// Is `nowMinutes` inside [from, to)? A window whose `from` is later than its
// `to` crosses midnight (22:00 -> 07:00). from === to is treated as no window
// rather than a 24-hour one — a doctor who set both ends to the same minute
// did not mean "never notify me".
function inQuietWindow(nowMinutes, fromMinutes, toMinutes) {
  if (fromMinutes == null || toMinutes == null || nowMinutes == null) return false;
  if (fromMinutes === toMinutes) return false;
  if (fromMinutes < toMinutes) return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
  return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
}

/**
 * The decision. Pure: every input is already read.
 *
 * @param {object} args
 * @param {string} args.key              preference key (from doctorPushKey)
 * @param {object} [args.prefs]          { [key]: boolean } — a missing key is enabled
 * @param {object} [args.quiet]          { on, from, to } — from/to as 'HH:MM' or minutes
 * @param {number} [args.nowCairoMinutes] minutes since midnight, Cairo; defaults to now
 * @returns {{ push: boolean, reason: string }}
 */
function shouldPush({ key, prefs, quiet, nowCairoMinutes } = {}) {
  const k = String(key || '');
  if (!k) return { push: false, reason: 'no_key' };

  // A locked key is not a preference — it pushes through a disabled row and
  // through quiet hours alike.
  if (isLockedKey(k)) return { push: true, reason: 'locked' };

  const p = prefs && typeof prefs === 'object' ? prefs : {};
  if (Object.prototype.hasOwnProperty.call(p, k) && p[k] === false) {
    return { push: false, reason: 'pref_disabled' };
  }

  const q = quiet && typeof quiet === 'object' ? quiet : null;
  if (q && (q.on === true || q.on === 1)) {
    const from = typeof q.from === 'number' ? q.from : hhmmToMinutes(q.from);
    const to = typeof q.to === 'number' ? q.to : hhmmToMinutes(q.to);
    const now = typeof nowCairoMinutes === 'number' ? nowCairoMinutes : cairoMinutesNow();
    if (inQuietWindow(now, from, to)) return { push: false, reason: 'quiet_hours' };
  }

  return { push: true, reason: 'enabled' };
}

// ── Reads ──────────────────────────────────────────────────────────────────

// One SELECT: role (the hook in notify.js does not know it), and the quiet
// hours. A pre-121 database has no quiet columns; the fallback query keeps
// role resolution working so an old schema simply means "no quiet hours".
async function readDoctorRow(userId) {
  try {
    return await pg.queryOne(
      'SELECT role, quiet_hours_on, quiet_from, quiet_to FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
  } catch (_) {
    try {
      return await pg.queryOne('SELECT role FROM users WHERE id = $1 LIMIT 1', [userId]);
    } catch (e) {
      console.error(LOG + ' users lookup failed for ' + userId + ':', e && e.message);
      return null;
    }
  }
}

async function readPrefs(userId) {
  try {
    const rows = await pg.queryAll(
      'SELECT key, enabled FROM doctor_notification_prefs WHERE doctor_id = $1',
      [userId]
    );
    const out = {};
    for (const r of rows || []) {
      if (r && r.key) out[String(r.key)] = !(r.enabled === false || r.enabled === 0);
    }
    return out;
  } catch (_) {
    // Table absent (pre-121) or unreachable: every preference is enabled,
    // which is exactly what a missing row means.
    return {};
  }
}

// ── The push ───────────────────────────────────────────────────────────────

/**
 * Send the push that matches an internal notification row addressed to a
 * doctor. Same contract as patient_push.pushForNotification: called from
 * inside queueNotification, fire-and-forget, never throws.
 *
 * Order of checks is the cheap-to-expensive order: an unknown template costs
 * nothing; a non-doctor recipient costs one indexed SELECT (which also
 * fetches the quiet hours, so a doctor pays for that read once).
 *
 * @param {object} args
 * @param {string} args.userId    recipient (users.id)
 * @param {string} args.template  notification template name
 * @param {string} args.title     already localised by the caller
 * @param {string} args.body      already localised by the caller; may be null
 * @param {string} [args.orderId] for tap-through
 * @param {object} [args.payload] the parsed notification payload
 * @returns {Promise<{sent:boolean, reason:string}>} for logs/tests; callers ignore it
 */
async function pushForDoctorNotification({ userId, template, title, body, orderId, payload } = {}) {
  try {
    if (!userId) return { sent: false, reason: 'no_user' };
    const key = doctorPushKey(template);
    if (!key) return { sent: false, reason: 'not_doctor_template' };
    if (!title) return { sent: false, reason: 'no_title' };  // nothing readable for a lock screen

    const row = await readDoctorRow(userId);
    if (!row || String(row.role || '').toLowerCase() !== 'doctor') {
      return { sent: false, reason: 'not_doctor' };
    }

    // Locked keys skip the prefs read entirely — the answer cannot change.
    const prefs = isLockedKey(key) ? {} : await readPrefs(userId);
    const decision = shouldPush({
      key,
      prefs,
      quiet: { on: row.quiet_hours_on === true || row.quiet_hours_on === 1, from: row.quiet_from, to: row.quiet_to },
    });
    if (!decision.push) return { sent: false, reason: decision.reason };

    // Tap target. The doctor app's alert list derives its screen from the
    // template kind; push carries the same facts so both land the doctor on
    // the same case.
    const data = { screen: 'case-detail', template: String(template), kind: key };
    if (orderId) data.caseId = String(orderId);
    if (key === 'message') {
      const convoId = payload && (payload.conversation_id || payload.conversationId);
      if (convoId) { data.screen = 'chat'; data.conversationId = String(convoId); }
    }
    if (!orderId && key === 'news') data.screen = 'home';

    // sendPushNotification fans out to every live device token (user_sessions
    // rows UNION the users.push_token mirror — middleware/push._liveTokensForUser).
    await push.sendPushNotification(pg.pool, userId, {
      title: title,
      body: body || '',
      data
    });
    return { sent: true, reason: decision.reason };
  } catch (err) {
    // Swallowed on purpose — see the contract above.
    console.error(LOG + ' failed for template ' + template + ':', err && err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  pushForDoctorNotification,
  shouldPush,
  doctorPushKey,
  isLockedKey,
  hhmmToMinutes,
  cairoMinutesNow,
  inQuietWindow,
  DOCTOR_PUSH_TEMPLATES,
  DOCTOR_PREF_KEYS,
};
