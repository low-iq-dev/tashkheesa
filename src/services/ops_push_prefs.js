'use strict';

// services/ops_push_prefs.js
//
// 29 Sep 2026 — what each Command push is, and how loudly it should arrive.
//
// Before this, every business push went out identically: sound, high priority,
// lock-screen interrupt. The founder could not tell "a patient is waiting on
// you to verify a transfer" from "the classifier parked a file" without
// unlocking the phone — which is how a channel gets muted, and a muted channel
// is worse than a noisy one.
//
// Three modes:
//   loud   sound + high priority + iOS time-sensitive (breaks through Focus).
//          Only for things that need a human within minutes.
//   quiet  no sound, normal priority, iOS passive. Lands in the tray and on the
//          lock screen without waking anyone. Good news and FYIs.
//   off    not pushed. Still written to ops_push_log, so Activity stays complete.
//
// A missing preference row means the kind's default below. `lockOn` kinds
// cannot be turned off — a stored 'off' is read as the default — because
// each has exactly one human who can act on it and silence costs a patient.

const { queryAll, execute } = require('../pg');

const MODES = Object.freeze(['loud', 'quiet', 'off']);

// Ordered as the settings screen shows them.
const KIND_CATALOGUE = Object.freeze([
  // ── Money ────────────────────────────────────────────────────────────────
  { kind: 'payment_claim',          group: 'money',   def: 'loud',  lockOn: true,
    en: 'Transfer to verify',               ar: 'تحويل مستني تأكيد' },
  { kind: 'case_paid',              group: 'money',   def: 'quiet',
    en: 'Case paid',                        ar: 'حالة اتدفعت' },
  { kind: 'payment_capture_failed', group: 'money',   def: 'loud',  lockOn: true,
    en: 'Paid but not queued',              ar: 'اتدفعت ومدخلتش الطابور' },
  { kind: 'payment_mismatch',       group: 'money',   def: 'loud',
    en: 'Payment amount mismatch',          ar: 'مبلغ الدفع مش مطابق' },
  { kind: 'refund_requested',       group: 'money',   def: 'quiet',
    en: 'Refund requested',                 ar: 'طلب استرداد' },

  // ── Growth ───────────────────────────────────────────────────────────────
  { kind: 'patient_signup',         group: 'growth',  def: 'quiet',
    en: 'New patient signup',               ar: 'مريض جديد سجّل' },
  { kind: 'case_submitted',         group: 'growth',  def: 'quiet',
    en: 'Case submitted, not yet paid',     ar: 'حالة اتبعتت ولسه متدفعتش' },
  { kind: 'contact_enquiry',        group: 'growth',  def: 'quiet',
    en: 'Contact form enquiry',             ar: 'رسالة من صفحة التواصل' },

  // ── Cases ────────────────────────────────────────────────────────────────
  { kind: 'urgent_unaccepted',      group: 'cases',   def: 'loud',
    en: 'Urgent case not accepted',         ar: 'حالة عاجلة محدش قبلها' },
  { kind: 'assignment_failed',      group: 'cases',   def: 'loud',
    en: 'Case could not be assigned',       ar: 'حالة متعيّنتش لدكتور' },
  { kind: 'sla_breach_first',       group: 'cases',   def: 'loud',
    en: 'First SLA breach of the day',      ar: 'أول تأخير في اليوم' },
  { kind: 'sla_prebreach',          group: 'cases',   def: 'quiet',
    en: 'Case close to its deadline',       ar: 'حالة قربت على الميعاد' },
  { kind: 'sla_at_risk',            group: 'cases',   def: 'quiet',
    en: 'Case at risk',                     ar: 'حالة في خطر تأخير' },
  { kind: 'doctor_unaccepted',      group: 'cases',   def: 'quiet',
    en: 'Offer not accepted by a doctor',   ar: 'دكتور مقبلش العرض' },
  { kind: 'report_delivered',       group: 'cases',   def: 'quiet',
    en: 'Report delivered',                 ar: 'تقرير اتسلّم' },
  { kind: 'classifier_parked',      group: 'cases',   def: 'quiet',
    en: 'File needs a human to classify',   ar: 'ملف محتاج تصنيف يدوي' },

  // ── Doctors ──────────────────────────────────────────────────────────────
  { kind: 'doctor_application',     group: 'doctors', def: 'quiet',
    en: 'New doctor application',           ar: 'طلب انضمام دكتور' },
  { kind: 'doctor_auto_paused',     group: 'doctors', def: 'quiet',
    en: 'Doctor auto-paused',               ar: 'دكتور اتوقف تلقائيًا' },
  { kind: 'chat_reported',          group: 'doctors', def: 'loud',
    en: 'Chat reported',                    ar: 'محادثة اتبلغ عنها' },
  { kind: 'doctor_app_feedback',    group: 'doctors', def: 'quiet',
    en: 'Doctor app feedback',              ar: 'ملاحظات من تطبيق الدكاترة' },

  // ── System ───────────────────────────────────────────────────────────────
  { kind: 'worker_down',            group: 'system',  def: 'loud',  lockOn: true,
    en: 'Background worker down',           ar: 'خدمة خلفية وقفت' },
  { kind: 'worker_recovered',       group: 'system',  def: 'quiet',
    en: 'Background worker recovered',      ar: 'خدمة خلفية رجعت' },
]);

const BY_KIND = Object.freeze(KIND_CATALOGUE.reduce(function (acc, k) { acc[k.kind] = k; return acc; }, {}));

// A kind nobody catalogued (a producer added later) still pushes — loud, which
// is today's behaviour — rather than vanishing because this file was not updated.
const UNKNOWN_DEFAULT = 'loud';

function defaultModeFor(kind) {
  const k = BY_KIND[kind];
  return k ? k.def : UNKNOWN_DEFAULT;
}

/** Apply lockOn: an 'off' on a locked kind resolves to the default. */
function effectiveMode(kind, stored) {
  const k = BY_KIND[kind];
  const mode = MODES.includes(stored) ? stored : defaultModeFor(kind);
  if (mode === 'off' && k && k.lockOn) return k.def;
  return mode;
}

/**
 * The effective mode of one kind for each of several users, in one query.
 * Never throws — on any DB error every user gets the default, because a push
 * that should have been quiet arriving loud is recoverable and a push that
 * never arrives is not.
 *
 * @returns {Promise<Object<string,string>>} userId -> mode
 */
async function modesForUsers(kind, userIds) {
  const out = {};
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  ids.forEach(function (id) { out[id] = effectiveMode(kind, null); });
  if (!ids.length) return out;
  try {
    const rows = (await queryAll(
      'SELECT user_id, mode FROM admin_notification_prefs WHERE kind = $1 AND user_id = ANY($2::text[])',
      [kind, ids]
    )) || [];
    rows.forEach(function (r) { out[r.user_id] = effectiveMode(kind, r.mode); });
  } catch (_) { /* defaults already set */ }
  return out;
}

/** Everything the settings screen needs for one user. */
async function listPrefs(userId) {
  let stored = {};
  try {
    const rows = (await queryAll('SELECT kind, mode FROM admin_notification_prefs WHERE user_id = $1', [userId])) || [];
    rows.forEach(function (r) { stored[r.kind] = r.mode; });
  } catch (_) { stored = {}; }
  return KIND_CATALOGUE.map(function (k) {
    return {
      kind: k.kind,
      group: k.group,
      label_en: k.en,
      label_ar: k.ar,
      default: k.def,
      locked_on: !!k.lockOn,
      mode: effectiveMode(k.kind, stored[k.kind]),
    };
  });
}

/**
 * Store one preference. Returns { ok, mode } or { ok:false, code }.
 * Writing the default deletes the row, so the table only ever holds overrides.
 */
async function setPref(userId, kind, mode) {
  if (!BY_KIND[kind]) return { ok: false, code: 'UNKNOWN_KIND' };
  if (!MODES.includes(mode)) return { ok: false, code: 'BAD_MODE' };
  if (mode === 'off' && BY_KIND[kind].lockOn) return { ok: false, code: 'LOCKED_ON' };
  if (mode === BY_KIND[kind].def) {
    await execute('DELETE FROM admin_notification_prefs WHERE user_id = $1 AND kind = $2', [userId, kind]);
  } else {
    await execute(
      `INSERT INTO admin_notification_prefs (user_id, kind, mode, updated_at)
            VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, kind) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`,
      [userId, kind, mode]
    );
  }
  return { ok: true, mode: mode };
}

/**
 * How a mode is delivered, as Expo push fields.
 *   loud  -> today's behaviour, plus iOS time-sensitive.
 *   quiet -> no sound, normal priority, iOS passive, Android 'activity' channel
 *            (created LOW-importance by the Command app; an older build that
 *            lacks it falls back to FCM's default channel and still shows it).
 */
function deliveryFor(mode) {
  if (mode === 'quiet') {
    return { sound: null, priority: 'normal', channelId: 'activity', interruptionLevel: 'passive' };
  }
  return { sound: 'default', priority: 'high', channelId: 'default', interruptionLevel: 'time-sensitive' };
}

module.exports = {
  MODES,
  KIND_CATALOGUE,
  defaultModeFor,
  effectiveMode,
  modesForUsers,
  listPrefs,
  setPref,
  deliveryFor,
};
