// src/notification_worker.js
// Production notification worker: processes queued notifications via email and WhatsApp

const { queryAll, queryOne, execute } = require('./pg');
const { logErrorToDb } = require('./logger');
const { sendEmail, renderEmail, EMAIL_ENABLED } = require('./services/emailService');
// FIX 8 — `whatsappTransport()` is imported rather than re-deriving
// `process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT || '<default>'` inline. The
// default now lives in exactly one place (notify/whatsapp.js
// DEFAULT_WHATSAPP_TRANSPORT); previously this file and whatsapp.js each
// carried their own `|| 'meta'` literal and could disagree after a flip.
const { sendWhatsApp, whatsappTransport } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');
const { getWhatsAppTemplate } = require('./notify/whatsappTemplateMap');
// FIX 13 — bilingual countdown rendering (minutes under the hour, correct
// Arabic number agreement). Shared with notify/openclawTemplates.js.
const { formatTimeRemaining } = require('./notify/duration');
const { emitNotificationDropped } = require('./notify');
// Always-charge-EGP receipt figures (read-only over the stored EGP charge).
const { isIntlOrder, primaryPrice, egpCharge } = require('./utils/money_display');
const { formatMoney } = require('./utils/formatNumber');

// AUDIT-2026-08-22: parseInt('' | 'three' | 'null', 10) is NaN, and NaN poisons
// the whole retry state machine rather than failing loudly:
//   * `attempts >= NaN` is ALWAYS false, so no row ever reaches 'failed' — the
//     max-retries branch (and its NOTIFICATION_DROPPED emit and error_logs
//     write) becomes unreachable and a permanently-broken send retries forever.
//   * the escape hatch is then the backoff, `30000 * 4**(attempts-1)`, which
//     overflows to Infinity around attempt 537 — and `new Date(Infinity)` is an
//     Invalid Date whose .toISOString() THROWS RangeError, inside the very
//     catch block meant to contain per-candidate failures.
// Clamp to a sane finite integer instead. The upper bound is not paranoia: it
// is what guarantees backoffFor() below can never produce Infinity.
const MAX_RETRIES = (function resolveMaxRetries() {
  const parsed = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return Math.min(parsed, 20);
})();
const DRY_RUN = String(process.env.NOTIFICATION_DRY_RUN || 'false').toLowerCase() === 'true';

/**
 * Exponential backoff (30s, 120s, 480s, …) as an ISO timestamp.
 *
 * AUDIT-2026-08-22: factored out of the retry branch so the per-candidate
 * catch below can use the SAME schedule. The catch used to write
 * status='retry' with no retry_after at all, which left the 10-minute CLAIM
 * LEASE the fetch UPDATE had just stamped into that column sitting in place —
 * so a row that failed by exception waited ~10 minutes for its next attempt
 * instead of 30 seconds, on the same column the claim recovery pass reads.
 *
 * `attempts` is clamped so the multiplication cannot overflow to Infinity and
 * make new Date(...).toISOString() throw (see MAX_RETRIES above).
 */
function backoffFor(attempts) {
  const n = Math.min(Math.max(Number(attempts) || 1, 1), 12); // 30s·4^11 ≈ 48 days
  const ms = 30000 * Math.pow(4, n - 1);
  return new Date(Date.now() + ms).toISOString();
}

// B10 (launch audit): re-entrancy guard + claim-lease window. The 30s
// setInterval in server.js has no overlap protection; a slow email/WhatsApp
// provider makes ticks overlap and double-send. `running` mirrors
// src/workers/acceptance_watcher.js. A claimed ('sending') row whose lease
// (STUCK_SENDING_LEASE_MS) has expired is treated as orphaned by a crashed
// worker and re-queued.
let running = false;
const STUCK_SENDING_LEASE_MS = 10 * 60 * 1000; // 10 minutes

// P1-NOTIF-4: doctor names in the users table are stored already-prefixed
// (per src/create_test_doctor.js seed data — "Dr. Ahmed Hassan"). Email
// templates also prepend "Dr. " (e.g. doctor-welcome.hbs:7, sla-warning.hbs:7,
// case-accepted.hbs:36, report-ready.hbs:36). Without this strip, doctors see
// "Hi Dr. Dr. Ahmed Hassan,". Stripping centrally in the worker is more
// defensive than removing the prefix from 4 templates: if a future caller
// passes an unprefixed name, templates still render correctly.
function stripDrPrefix(name) {
  return String(name == null ? '' : name).replace(/^\s*Dr\.?\s+/i, '').trim();
}

/**
 * Map notification template names to email template file names.
 * notification template -> email .hbs file (without extension)
 */
const TEMPLATE_TO_EMAIL = {
  // AUDIT-P1-4: magic_login_link had no mapping and no .hbs file, so every
  // magic-login request queued a notification that failed three retries and
  // died — getMagicLink returned the URL to its caller while the user's
  // email never arrived.
  magic_login_link: 'magic-login-link',
  order_created_patient: 'case-submitted',
  public_order_created_patient: 'case-submitted',
  order_assigned_doctor: 'case-assigned',
  order_auto_assigned_doctor: 'case-assigned',
  public_order_assigned_doctor: 'case-assigned',
  report_ready_patient: 'report-ready',
  payment_success_patient: 'payment-success',
  payment_marked_paid_patient: 'payment-success',
  payment_failed_patient: 'payment-failed',
  order_status_accepted_patient: 'case-accepted',
  appointment_reminder: 'appointment-reminder',
  appointment_booked: 'appointment-scheduled',
  appointment_rescheduled: 'appointment-scheduled',
  sla_warning_75: 'sla-warning',
  sla_warning_urgent: 'sla-warning',
  order_sla_pre_breach: 'sla-warning',
  order_sla_pre_breach_doctor: 'sla-warning',
  // FIX 4 — the 24h/6h/1h SLA reminder sweep (case_lifecycle.dispatchSlaReminders
  // → queueSlaReminder, template `sla_reminder_${level}`) is being wired on for
  // launch. It queues on BOTH the 'email' and 'whatsapp' channels, to BOTH the
  // assigned doctor and the patient. With no mapping here, processEmail returned
  // `no_email_template_mapping_for_sla_reminder_24h` and every single reminder
  // burned three retries into 'failed'.
  //
  // All three levels share one .hbs file: the body branches on {{role}}
  // (doctor vs patient — the two audiences need different copy and different
  // CTAs) and on {{level}} for the urgency wording. Both fields are already in
  // the queued payload (case_lifecycle.js queueSlaReminder response). One file
  // rather than three keeps the copy from drifting across tiers.
  //
  // Deliberately NOT reusing 'sla-warning': that template is doctor-addressed
  // ("Hi Dr. {{doctorName}}", "Missing the SLA deadline affects service quality
  // metrics") and would be actively wrong sent to a patient.
  sla_reminder_24h: 'sla-reminder',
  sla_reminder_6h:  'sla-reminder',
  sla_reminder_1h:  'sla-reminder',
  order_reassigned_doctor: 'case-reassigned',
  order_reassigned_to_doctor: 'case-reassigned',
  // P1-FIN-2: explainer to the BOOTED doctor (the one removed from the case)
  // about partial pay. Different template than 'case-reassigned' which is
  // addressed to the NEW doctor.
  order_reassigned_from_doctor: 'case-reassigned-original',
  welcome_patient: 'welcome',
  doctor_approved: 'doctor-welcome',
  additional_files_requested_patient: 'additional-files-request',
  additional_files_request_approved_patient: 'additional-files-request',
  patient_uploaded_files_doctor: 'patient-uploaded-files',
  prescription_uploaded_patient: 'prescription-uploaded',
  new_message: 'new-message',
  // Theme 7b Phase 2 — patient confirmation email when a refund
  // request is submitted. Admin templates (admin_refund_request_received,
  // admin_refund_cancelled_by_patient) are intentionally NOT mapped:
  // admins use the in-app /superadmin queue, not email, for refund triage.
  patient_refund_requested: 'patient-refund-requested',
  // Theme 7b Phase 3 — superadmin actions on patient refund requests.
  // All three are patient-facing email + in-app.
  patient_refund_approved:  'patient-refund-approved',
  patient_refund_denied:    'patient-refund-denied',
  patient_refund_paid:      'patient-refund-paid',
  // Side issue #44 — operator-initiated refund: patient notification.
  patient_refund_opened_by_operator: 'patient-refund-opened-by-operator',
  appointment_cancelled: 'appointment-cancelled',
  // WhatsApp-via-OpenClaw rollout: queue-ified case cancellation
  // (previously sent inline from superadmin.js:2785). Adds WhatsApp
  // delivery alongside the existing email.
  case_cancelled_patient: 'case-cancelled',
  // Add-on purchase confirmations (email parity with the new WhatsApp
  // bodies in openclawTemplates.js).
  addon_purchased_video:        'addon-video-purchased',
  addon_purchased_urgency:      'addon-urgency-purchased',
  addon_purchased_prescription: 'addon-prescription-purchased',
  // AUDIT-2026-08-23 (C4) — doctor-requested prescription pipeline. Without a
  // mapping here processEmail answers no_email_template_mapping_for_<t> and
  // burns three retries straight into 'failed'.
  prescription_recommended_patient: 'prescription-recommended',
  prescription_unlocked_doctor:     'prescription-unlocked',
  // #66: payment-reminder series for unpaid cases. Queued by
  // case_lifecycle.dispatchUnpaidCaseReminders at 30m / 6h / 24h
  // elapsed from order creation. The 24h reminder is included for
  // registry completeness even though the case_lifecycle hard-stop
  // at 24h (status='expired_unpaid') currently expires the case
  // before the reminder loop reaches that threshold — keeps the
  // surface ready if the hold window is ever extended.
  payment_reminder_30m: 'payment-reminder-30m',
  payment_reminder_6h:  'payment-reminder-6h',
  payment_reminder_24h: 'payment-reminder-24h',
  // Theme 14 Phase 5 — patient notification when superadmin approves a
  // manual-queue triage and the chosen specialty differs from the patient's
  // submission. Sent only when specialty changes (not for service-only
  // changes within the same specialty).
  case_routing_updated: 'case-routing-updated',
};

/**
 * Templates whose emails should set Reply-To to SMTP_REPLY_TO_EMAIL
 * (default info@tashkheesa.com) so recipients can reply directly to a
 * monitored inbox rather than the noreply@ from-address. Warm-touch
 * onboarding only — keep transactional/system emails on noreply@.
 */
const TEMPLATES_WITH_REPLY_TO = new Set([
  'doctor-welcome',
]);

/**
 * Process a single email notification.
 * @param {Object} notification - The notification row
 * @param {Object} user - The user row (id, email, name, phone, lang)
 * @param {Object|null} order - The order row if applicable
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function processEmail(notification, user, order) {
  if (!user.email) {
    // #66: skip immediately rather than retrying 3x. A missing email
    // is a stable user-state fact — retrying with exponential backoff
    // burns 3 attempts + max_retries_exceeded NOTIFICATION_DROPPED for
    // no reason. The downstream skipped branch marks status='skipped'
    // and excludes the row from sent/failed pill counts.
    return { skipped: 'no_email_for_user' };
  }

  const emailTemplate = TEMPLATE_TO_EMAIL[notification.template];
  if (!emailTemplate) {
    // No email template mapping -- treat as unsupported
    return { ok: false, error: `no_email_template_mapping_for_${notification.template}` };
  }

  const lang = user.lang || 'en';

  // Parse response payload for template variables
  let data = {};
  try {
    if (notification.response) {
      data = typeof notification.response === 'string'
        ? JSON.parse(notification.response)
        : notification.response;
    }
  } catch (e) {
    data = {};
  }

  // Enrich template data with common variables.
  // P1-NOTIF-4: stripDrPrefix removes any leading "Dr." / "Dr " from
  // doctorName. Doctor records are typically stored already-prefixed
  // (e.g. "Dr. Ahmed Hassan"), and the email templates also prepend
  // "Dr. " — without this strip, recipients see "Hi Dr. Dr. Ahmed".
  // Idempotent: stripping a name that has no prefix returns it unchanged.
  // #66: camelCase enrichment for snake_case payload fields. Queued
  // payloads from notify.js / case_lifecycle.js use snake_case
  // (payment_url, case_id, hours_remaining); Handlebars templates use
  // camelCase ({{paymentUrl}}, {{caseId}}, {{hoursRemaining}}) per
  // the convention in payment-failed.hbs et al. Enriching here keeps
  // every email template consistent without each composer having to
  // remember both shapes. Existing camelCase keys win when present.
  const caseIdResolved = data.caseId || data.case_id || (order ? order.id : '');
  const paymentUrlResolved = data.paymentUrl || data.payment_url
    || (order ? (order.payment_link || order.payment_url) : '')
    || '';
  // ALWAYS-CHARGE-EGP receipt figures for the payment-success email. The receipt
  // shows the price the patient sees — LOCAL for an international order
  // (display_price/display_currency), EGP for a domestic one — plus an "billed in
  // EGP" line for intl. Derived from the order row here because hbs has no
  // res.locals; centralised so every send path (webhook / stub mark-paid /
  // superadmin) renders identical figures. Caller-provided values still win.
  let receiptAmount = data.amount;
  let receiptCurrency = data.currency;
  let receiptEgpCharge = data.egpCharge || null;
  if (emailTemplate === 'payment-success' && order) {
    if (isIntlOrder(order)) {
      // display_price is the UN-multiplied LOCAL BASE; the urgency-tier multiplier
      // lives in price/base_price (both EGP). The receipt must state the local
      // TOTAL the patient actually paid = base × (price / base_price), matching
      // wizard Step 5 + order_review. Using display_price raw would understate a
      // VIP/urgent order and contradict the "Billed in EGP" line below.
      const egpBase = Number(order.base_price) || 0;
      const mult = egpBase > 0 ? (Number(order.price) / egpBase) : 1;
      const localTotal = Math.round((Number(order.display_price) || 0) * mult);
      if (receiptAmount == null) receiptAmount = localTotal.toLocaleString('en-GB', { maximumFractionDigits: 0 });
      if (receiptCurrency == null) receiptCurrency = String(order.display_currency || 'EGP').toUpperCase();
      if (receiptEgpCharge == null) receiptEgpCharge = formatMoney(egpCharge(order), 'EGP'); // e.g. "EGP 21,432"
    } else {
      // Domestic — orders.price is already the EGP total; no EGP disclosure needed.
      const pp = primaryPrice(order);
      if (receiptAmount == null) receiptAmount = Number(pp.amount).toLocaleString('en-GB', { maximumFractionDigits: 0 });
      if (receiptCurrency == null) receiptCurrency = pp.currency;
    }
  }

  // FIX 4 — SLA-reminder enrichment. case_lifecycle.queueSlaReminder queues
  // { case_id, role, level, seconds_remaining } and nothing else, so the
  // shared sla-reminder.hbs would otherwise render an empty "time left" and
  // have no way to pick doctor vs patient copy. Derive both here rather than
  // in the template: Handlebars has no arithmetic, and the recipient-role
  // branch belongs in code where it can be read at a glance.
  // Floored to whole hours and clamped at 0 so a late sweep can never render
  // a negative countdown to a patient.
  const slaSecondsRemaining = Number(data.seconds_remaining);
  const slaHoursRemaining = Number.isFinite(slaSecondsRemaining)
    ? String(Math.max(0, Math.floor(slaSecondsRemaining / 3600)))
    : '';
  const slaRole = String(data.role || '').toLowerCase();

  // REGRESSION FIX (F13) — `slaHoursRemaining` is the string "0" for the whole
  // final hour, and "0" is TRUTHY, so `{{#if hoursRemaining}}` passed and the
  // 1h reminder rendered "Time Left: 0 hours". `timeRemaining` is a fully
  // localised phrase that drops to minutes under the hour, carries the correct
  // Arabic number agreement (6 → "ساعات", not "ساعة"), and is '' when there is
  // nothing meaningful to say — so the template row disappears instead of
  // printing a zero. sla-reminder.hbs renders this; `hoursRemaining` is left
  // untouched for the payment-reminder templates that still use it.
  const timeRemaining = formatTimeRemaining(
    Number.isFinite(slaSecondsRemaining) ? slaSecondsRemaining : NaN,
    lang
  );

  const templateData = {
    ...data,
    isDoctorRecipient: slaRole === 'doctor',
    isPatientRecipient: slaRole === 'patient',
    patientName: data.patientName || user.name || 'Patient',
    doctorName: stripDrPrefix(data.doctorName),
    caseId: caseIdResolved,
    caseReference: data.caseReference
      || (caseIdResolved ? String(caseIdResolved).slice(0, 12).toUpperCase() : ''),
    paymentUrl: paymentUrlResolved,
    hoursRemaining: data.hoursRemaining || data.hours_remaining || slaHoursRemaining || '',
    timeRemaining,
    specialty: data.specialty || '',
    slaHours: data.slaHours || (order ? order.sla_hours : ''),
    dashboardUrl: data.dashboardUrl || `${process.env.APP_URL || 'https://tashkheesa.com'}/dashboard`,
    caseUrl: data.caseUrl || (order ? `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/doctor/case/${order.id}` : ''),
    reportUrl: data.reportUrl || (order ? `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/case/${order.id}/report` : ''),
    appUrl: process.env.APP_URL || 'https://tashkheesa.com',
    // Always-charge-EGP receipt fields (payment-success only; undefined elsewhere
    // → {{#if amount}} stays false in other templates).
    amount: receiptAmount,
    currency: receiptCurrency,
    egpCharge: receiptEgpCharge,
  };

  // Subject derivation moved AFTER templateData so subjects can interpolate
  // any template variable (e.g. "Dr. {doctorName} has accepted your case").
  const titles = getNotificationTitles(notification.template, templateData);
  const subject = lang === 'ar' ? titles.title_ar : titles.title_en;

  if (DRY_RUN) {
    console.log('[notify-worker][DRY_RUN] Would send email', { to: user.email, template: emailTemplate, subject });
    return { ok: true, dryRun: true };
  }

  const result = await sendEmail({
    to: user.email,
    subject,
    template: emailTemplate,
    lang,
    data: templateData,
    // Doctor onboarding (and future warm-touch templates listed in
    // TEMPLATES_WITH_REPLY_TO) opt into Reply-To so the recipient can
    // respond to a monitored inbox instead of noreply@.
    replyTo: TEMPLATES_WITH_REPLY_TO.has(emailTemplate) ? true : null,
  });

  return result;
}

/**
 * Process a single WhatsApp notification.
 * @param {Object} notification - The notification row
 * @param {Object} user - The user row
 * @param {Object|null} order - The order row
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function processWhatsApp(notification, user, order) {
  if (!user.phone) {
    // #66: skip immediately rather than retrying 3x (see processEmail).
    return { skipped: 'no_phone_for_user' };
  }

  // ── AUDIT-2026-08-22 (N1): WhatsApp opt-out is enforced HERE. ───────────
  //
  // `users.notify_whatsapp` — the flag routes/openclaw-api.js writes when a
  // recipient replies STOP — was read in exactly ONE place repo-wide:
  // notify.queueMultiChannelNotification. The nineteen single-channel
  // `queueNotification({ channel:'whatsapp' })` call sites bypassed it
  // entirely, and neither this worker (which already SELECTed the column and
  // then ignored it), nor notify/whatsapp.js, nor lib/openclaw_client.js
  // checked. Replying STOP therefore did nothing on almost every message the
  // platform sends.
  //
  // That is not a preference bug at launch: migration 062 bulk-set the flag
  // true for every patient holding a phone number and flipped the column
  // DEFAULT to true, so opt-out is the ONLY consent control that exists.
  //
  // The check belongs in the worker rather than in each caller because the
  // worker is the single chokepoint every whatsapp row passes through — one
  // check covers all nineteen sites plus any added later, and it cannot be
  // forgotten at a new call site.
  //
  // EXEMPTION — superadmins. Two separate questions were considered:
  //   1. The genuinely operational pages (worker-down, Paymob HMAC failure,
  //      error-rate spike) do not travel this path at all: sendCriticalAlert
  //      goes straight to the transport with no notifications row, so it was
  //      never at risk and needs no exemption here.
  //   2. What DOES reach a superadmin over whatsapp is the SLA-breach
  //      escalation (notify.dispatchSlaBreach). Silencing a medical-deadline
  //      escalation to the on-call operator because someone once replied STOP
  //      to a different message is a worse failure than the consent question
  //      it answers, and a superadmin is staff on a work number rather than a
  //      marketing recipient.
  //
  // ── AUDIT-2026-08-22 (AUDIT-STAFF-OPTOUT-1): THE EXEMPTION WAS TOO NARROW ──
  //
  // The previous revision exempted `superadmin` ONLY, and reasoned that a
  // doctor's false flag is "an explicit administrative setting". On this
  // database it is nothing of the sort — it is the ORIGINAL DEFAULT:
  //
  //   * 001_initial_tables.sql declares users.notify_whatsapp DEFAULT false.
  //   * 062_notify_whatsapp_default_true.sql flipped the DEFAULT to true, but
  //     its backfill UPDATE is scoped `WHERE role = 'patient'` (062:41-44).
  //
  // So EVERY doctor and admin row created before migration 062 still holds
  // false, indistinguishable from a deliberate opt-out. Under the old check
  // those users silently stopped receiving case-assignment, acceptance-window
  // and SLA-breach WhatsApp: status='skipped', which /ops deliberately excludes
  // from the failure pill, and no NOTIFICATION_DROPPED event. Nothing anywhere
  // would have said so.
  //
  // THE RULE NOW: `notify_whatsapp` is CONSENT FOR PATIENTS, where reply-STOP
  // is the only opt-out that exists and the 062 backfill made the value
  // meaningful. For STAFF (doctor / admin / superadmin / anything non-patient)
  // it is not a consent signal at all on this data, so it is NOT treated as a
  // kill switch — a false value there is logged and the message is still sent.
  //
  // This deliberately means a staff member who replies STOP keeps receiving
  // operational WhatsApp. That is the correct trade for medical-deadline
  // traffic on a work number, and the honest way to opt a staff member out is
  // to clear their phone number (handled by the no_phone branch above) or to
  // give staff their own preference column with a trustworthy default. Until
  // one exists, the send is logged so it is at least visible.
  //
  // Modelled as `skipped` (not a failure): the row lands on status='skipped',
  // which /ops deliberately excludes from both the sent and failure pills.
  // Deliberately NOT emitting NOTIFICATION_DROPPED — an opted-out patient
  // generates one skip per notification per case, and flooding
  // /ops/silent-failures with a working consent control would bury the real
  // drops. This matches the existing no_phone_for_user skip directly above.
  // Strict false/0 only — the exact comparison queueMultiChannelNotification
  // uses, so the two enforcement points cannot disagree about the same user. A
  // NULL column (rows predating migration 062) is therefore NOT an opt-out,
  // which matches that migration flipping the DEFAULT to true.
  const optedOut = (user.notify_whatsapp === false || user.notify_whatsapp === 0);
  // AUDIT-2026-08-22 (AUDIT-STAFF-OPTOUT-1) — patient vs staff, not
  // superadmin vs everyone. An unknown/empty role is treated as STAFF (send
  // rather than silently drop): the failure mode of an extra message is
  // recoverable, the failure mode of an invisible skip is not.
  const isPatientRecipient = String(user.role || '').toLowerCase() === 'patient';
  if (optedOut && isPatientRecipient) {
    return { skipped: 'whatsapp_opted_out' };
  }
  if (optedOut && !isPatientRecipient) {
    // Visible on stdout AND in error_logs, so a staff member whose flag is
    // false is discoverable instead of silently unreachable. Not a
    // NOTIFICATION_DROPPED event: nothing is being dropped — we are sending.
    console.warn('[notify-worker] staff recipient has notify_whatsapp=false; SENDING ANYWAY ' +
      '(pre-062 default, not a real opt-out — see AUDIT-STAFF-OPTOUT-1)', {
        userId: user.id, role: user.role, template: notification.template
      });
    try {
      logErrorToDb(new Error('staff notify_whatsapp=false ignored for operational WhatsApp'), {
        context: 'notification_worker.staff_optout_ignored',
        category: 'notifications',
        level: 'warn',
        orderId: notification.order_id || null,
        userId: user.id
      });
    } catch (_) {}
  }

  // Parse response payload for template variables
  let rawVars = {};
  try {
    if (notification.response) {
      rawVars = typeof notification.response === 'string'
        ? JSON.parse(notification.response)
        : notification.response;
    }
  } catch (e) {
    rawVars = {};
  }

  // Enrich vars with the same canonical fields the email path computes
  // (notification_worker.processEmail at ~line 114). The OpenClaw body
  // composer reads doctorName/caseReference/link/etc; the Meta path's
  // paramBuilder also tolerates these fields as fallbacks.
  const appUrl = process.env.APP_URL || 'https://tashkheesa.com';
  // #66: mirror the email path's camelCase enrichment so OpenClaw
  // composers can read paymentUrl / caseId / hoursRemaining without
  // each one having to fall back to snake_case keys.
  const caseIdResolved = rawVars.caseId || rawVars.case_id || (order ? order.id : '');
  const paymentUrlResolved = rawVars.paymentUrl || rawVars.payment_url
    || (order ? (order.payment_link || order.payment_url) : '')
    || '';
  const vars = {
    ...rawVars,
    patientName:  rawVars.patientName  || user.name || 'Patient',
    doctorName:   stripDrPrefix(rawVars.doctorName),
    caseId:       caseIdResolved,
    caseReference: rawVars.caseReference
      || (caseIdResolved ? String(caseIdResolved).slice(0, 12).toUpperCase() : ''),
    paymentUrl:   paymentUrlResolved,
    hoursRemaining: rawVars.hoursRemaining || rawVars.hours_remaining || '',
    slaHours:     rawVars.slaHours || (order ? order.sla_hours : ''),
    appUrl,
    // Patient-facing portal URL for the OpenClaw body's call-to-action.
    // Email templates use a generic dashboardUrl; for WhatsApp we deep-link
    // to the patient's order page so taps land on the relevant case.
    // Payment-reminder events deep-link to the payment URL instead so the
    // CTA lands directly on the unpaid checkout.
    link:         rawVars.link
      || (String(notification.template || '').startsWith('payment_reminder_') && paymentUrlResolved
        ? paymentUrlResolved
        : (order ? `${appUrl}/portal/patient/orders/${order.id}` : appUrl))
  };

  if (DRY_RUN) {
    console.log('[notify-worker][DRY_RUN] Would send WhatsApp', { to: user.phone, template: notification.template });
    return { ok: true, dryRun: true };
  }

  // Transport-agnostic dispatch: sendWhatsApp branches on
  // NOTIFICATIONS_WHATSAPP_TRANSPORT internally. We pass the raw
  // internal event name + enriched vars + orderId/userId; the OpenClaw
  // branch composes a free-form body, the Meta branch looks up the
  // HSM template via whatsappTemplateMap.
  //
  // FIX 9 — the recipient's language is now an INPUT to template resolution
  // instead of being overridden by a hardcoded `lang:'en'` on every map entry.
  // getWhatsAppTemplate returns the approved name for `userLang` when one
  // exists and the `en` name (with language code 'en') otherwise, so an
  // English-only event never gets submitted to Meta under an 'ar' code.
  const userLang = user.lang === 'ar' ? 'ar' : 'en';
  const fallbackLang = userLang === 'ar' ? 'ar' : 'en_US';
  const orderIdForSend = notification.order_id || (order && order.id) || null;

  // ── REGRESSION FIX (F1) — the Meta paramBuilder must never touch the
  // OpenClaw payload. ────────────────────────────────────────────────────
  //
  // This block used to build `wa` from the Meta map unconditionally and then
  // patch `template` + `lang` back for OpenClaw — but NOT `vars`. A
  // paramBuilder returns only the ordered HSM parameters (e.g.
  // `{ case_ref, hours_remaining }`), so every field the OpenClaw composer
  // reads and the builder does not emit was silently dropped on the way to
  // getOpenClawBody:
  //
  //   sla_reminder_24h/_6h/_1h  lost `role`  → v.role === 'doctor' was false
  //                             for the DOCTOR too, so 100% of doctor SLA
  //                             reminders rendered the patient body ("Nothing
  //                             needed from you") with a patient-portal link,
  //                             at 24h/6h/1h before a medical deadline.
  //   appointment_reminder      lost `appointmentTime` (builder emits
  //   appointment_booked        `date_time`) → "your appointment is at ."
  //   appointment_rescheduled
  //   appointment_cancelled
  //   addon_purchased_video
  //   payment_reminder_*        lost `link`/`paymentUrl` → CTA fell back to
  //                             the generic order URL instead of checkout.
  //
  // The map is now consulted ONLY on the Meta branch. OpenClaw gets the full
  // enriched `vars` object it was always documented to receive, and there is
  // no patch-up step left to forget a field in.
  const useOpenClaw = whatsappTransport() === 'openclaw';

  let wa;
  if (useOpenClaw) {
    // OpenClaw keys on the internal event name (openclawTemplates.js), not the
    // Meta HSM name, and composes a free-form bilingual body from `vars`.
    wa = {
      to: user.phone,
      template: notification.template,
      lang: userLang,
      vars,
      orderId: orderIdForSend,
      userId: user.id
    };
  } else {
    const mapped = getWhatsAppTemplate(notification.template, userLang);
    // AUDIT-2026-08-22: an unmapped event used to fall through to Meta with
    // `template: notification.template` — the INTERNAL event name, which is
    // not an approved HSM name — and `Object.values(vars)` as an UNORDERED
    // positional parameter list (JS object key order is insertion order, which
    // has nothing to do with Meta's {{1}}/{{2}} slots). 25 whatsapp-channel
    // templates have no map entry. Meta rejects that submission today with
    // 132001, so the practical outcome is three wasted retries and a 'failed'
    // row — but the branch should refuse rather than post garbage to a
    // third-party API on the strength of Meta's validator, and if it ever DID
    // clear it would deliver scrambled parameters to a patient.
    //
    // Mirrors the OpenClaw branch's `no_openclaw_template` contract: a missing
    // mapping is a deployment gap, so it is permanent (no retry storm) and
    // NOT 'skipped' (the worker's permanent branch marks it failed and writes
    // to error_logs, so it shows on /ops as the undelivered message it is).
    if (!mapped) {
      // THEME8-LINT-EXEMPT-HELPER: no logErrorToDb here on purpose — the
      // `permanent: true` return below routes this through the worker's
      // permanent branch, which is what writes error_logs and surfaces it on
      // /ops. Logging here too would double-count every occurrence.
      console.error('[notify-worker] NO META TEMPLATE MAPPING for event — message NOT delivered', {
        template: notification.template, lang: userLang
      });
      return { ok: false, error: 'no_meta_whatsapp_template', permanent: true, template: notification.template };
    }
    wa = {
      to: user.phone,
      template: mapped.templateName,
      lang: mapped.lang || fallbackLang,
      // Meta's Cloud API takes ordered positional body parameters, so the
      // paramBuilder projection is required here (and only here).
      vars: typeof mapped.paramBuilder === 'function' ? mapped.paramBuilder(vars) : vars,
      orderId: orderIdForSend,
      userId: user.id
    };
  }

  const result = await sendWhatsApp(wa);

  return result;
}

/**
 * Run the notification worker: poll queued/retry notifications and process them.
 * @param {number} limit - Max notifications to process per run
 */
async function runNotificationWorker(limit = 50) {
  // B10 (launch audit): skip this tick if a prior tick is still running, so a
  // slow provider can't cause overlapping ticks to double-send. Mirrors
  // src/workers/acceptance_watcher.js. `running` is reset in the finally below.
  if (running) return;
  running = true;
  try {
  const nowIso = new Date().toISOString();
  const leaseExpiryIso = new Date(Date.now() + STUCK_SENDING_LEASE_MS).toISOString();
  let notifications = [];

  // B10 (launch audit): recover rows a crashed worker left stuck in 'sending'
  // past their claim lease, so they get re-dispatched instead of lost forever.
  //
  // AUDIT — the recovery UPDATE used to flip every expired-lease row straight
  // back to 'queued' WITHOUT touching `attempts`. A poison-pill payload that
  // kills the worker mid-send therefore looped forever: claim → crash →
  // lease expires → re-queue at attempts=N → claim → crash. It could never
  // reach MAX_RETRIES because only the normal failure paths below increment
  // the counter, and this row never reaches them.
  //
  // Now the recovery pass owns the increment: each lease expiry costs one
  // attempt, and a row already at the cap is retired to 'failed' instead of
  // being handed back to the worker. Two statements rather than one CASE
  // expression so the retire path can be counted and logged distinctly.
  try {
    const retired = await queryAll(
      `UPDATE notifications
          SET status = 'failed',
              attempts = COALESCE(attempts, 0) + 1,
              retry_after = NULL,
              response = $2
        WHERE status = 'sending'
          AND (retry_after IS NULL OR retry_after <= $1)
          AND COALESCE(attempts, 0) + 1 >= $3
        RETURNING id, order_id, template, channel, to_user_id, attempts`,
      [nowIso, JSON.stringify({ error: 'stuck_sending_max_retries_exceeded' }), MAX_RETRIES]
    );

    await execute(
      `UPDATE notifications
          SET status = 'queued',
              attempts = COALESCE(attempts, 0) + 1,
              retry_after = NULL
        WHERE status = 'sending'
          AND (retry_after IS NULL OR retry_after <= $1)`,
      [nowIso]
    );

    for (const r of (retired || [])) {
      // Same visibility contract as the max-retries branch in the dispatch
      // loop: /ops/silent-failures reads NOTIFICATION_DROPPED case_events and
      // /ops/errors reads error_logs. A row that died by repeated worker
      // crashes is exactly as undelivered as one that died by provider errors.
      emitNotificationDropped({
        orderId: r.order_id,
        reason: 'stuck_sending_max_retries_exceeded',
        channel: r.channel,
        template: r.template,
        toUserId: r.to_user_id
      });
      logErrorToDb(new Error('stuck_sending_max_retries_exceeded'), {
        context: 'notification_worker.recover_stuck_sending',
        category: 'notification_worker',
        candidateId: r.id,
        template: r.template,
        channel: r.channel,
        attempts: r.attempts,
        workerPhase: 'interval'
      });
      console.error('[notify-worker] retiring poison-pill row stuck in sending', {
        id: r.id, template: r.template, channel: r.channel, attempts: r.attempts
      });
    }
  } catch (err) {
    logErrorToDb(err, {
      context: 'notification_worker.recover_stuck_sending',
      category: 'notification_worker',
      workerPhase: 'interval'
    });
    console.error('[notify-worker] failed to recover stuck sending rows', err);
  }

  try {
    // B10 (launch audit): CLAIM rows atomically — flip queued/retry -> 'sending'
    // and RETURN them — so a concurrent tick or instance can never grab the same
    // row. The previous plain `SELECT ... FOR UPDATE SKIP LOCKED` ran in
    // autocommit and released the row lock immediately, protecting nothing
    // against duplicate dispatch. retry_after doubles as the claim-lease expiry
    // for 'sending' rows (recovered above) — disjoint from its queued/retry
    // backoff use since the statuses never overlap. ORDER BY at ASC keeps FIFO;
    // FOR UPDATE SKIP LOCKED must follow LIMIT (Postgres clause order).
    notifications = await queryAll(
      `UPDATE notifications
          SET status = 'sending', retry_after = $1
        WHERE id IN (
          SELECT id FROM notifications
           WHERE status IN ('queued', 'retry')
             AND (retry_after IS NULL OR retry_after <= $2)
           ORDER BY at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [leaseExpiryIso, nowIso, limit]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'notification_worker.fetch_queued',
      category: 'notification_worker',
      workerPhase: 'interval'
    });
    console.error('[notify-worker] failed to load notifications', err);
    return;
  }

  // Stamp a heartbeat on every successful tick, BEFORE the empty-queue early
  // return — otherwise the worker only "exists" to /ops when it had something
  // to send, so a quiet queue makes a perfectly healthy worker read as Down.
  pingOps('notification_worker', notifications.length
    ? ('Processing ' + notifications.length + ' notification(s)')
    : 'Ran — queue empty');

  if (!notifications.length) return;

  for (const n of notifications) {
    try {
      // AUDIT-2026-08-22 (N1): `role` added — processWhatsApp exempts
      // superadmins from the notify_whatsapp opt-out so an operator's STOP
      // cannot silence the SLA-breach escalation. See the note there.
      const user = await queryOne(
        'SELECT id, email, name, phone, lang, role, notify_whatsapp FROM users WHERE id = $1',
        [n.to_user_id]
      );

      const order = n.order_id
        ? await queryOne('SELECT * FROM orders_active WHERE id = $1', [n.order_id])
        : null;

      if (!user) {
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'failed',
          'error: user not found',
          n.id
        ]);
        continue;
      }

      const channel = n.channel || 'internal';
      let result = { ok: false, error: 'unknown_channel' };

      if (channel === 'email') {
        result = await processEmail(n, user, order);
      } else if (channel === 'whatsapp') {
        result = await processWhatsApp(n, user, order);
      } else if (channel === 'internal') {
        // Internal notifications are already visible in-app; mark as sent
        result = { ok: true };
      }

      if (result.ok) {
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'sent',
          JSON.stringify(result),
          n.id
        ]);
      } else if (result.skipped) {
        // Theme 8 Phase 4-C — split skipped from sent. Pre-fix the
        // ops-dashboard "Notifications: sent" pill counted user-preference
        // skips (opted out, no phone, no email) as successful delivery —
        // misleading every time someone read it. notifications.status is
        // plain TEXT (migrations/001_initial_tables.sql:line "status TEXT"
        // with no CHECK constraint), so adding 'skipped' is purely additive.
        // Downstream readers (superadmin.js, admin.js) only match against
        // 'sent' / 'failed' / 'pending' / 'queued' / 'retry' — none use
        // NOT IN, so 'skipped' rows are simply excluded from those counts.
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'skipped',
          JSON.stringify(result),
          n.id
        ]);
      } else if (result.permanent) {
        // AUDIT-P0-3 — a permanent, non-transient failure (e.g. no WhatsApp
        // template registered for this event). Retrying cannot help, but it
        // must NOT be filed as 'skipped' either: this is an undelivered
        // message and ops needs to see it in the failure pill.
        const attempts = (n.attempts || 0) + 1;
        await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3 WHERE id = $4', [
          'failed',
          JSON.stringify({ error: result.error || 'permanent_failure', permanent: true, attempts }),
          attempts,
          n.id
        ]);
        // AUDIT-M1 — the notifications row is marked 'failed', so this is not
        // invisible, but it never reached the errors dashboard. A permanent
        // failure means someone was never told something we decided was worth
        // telling them; that belongs on /ops/errors.
        logErrorToDb(new Error('permanent notification failure: ' + (result.error || 'unknown')), {
          context: 'notification_worker.permanent_failure',
          category: 'notifications',
          orderId: n.order_id || null,
          userId: n.to_user_id || null
        });
      } else {
        // Handle failure with retry
        const attempts = (n.attempts || 0) + 1;

        if (attempts >= MAX_RETRIES) {
          await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3 WHERE id = $4', [
            'failed',
            JSON.stringify({ error: result.error || 'max_retries_exceeded', attempts }),
            attempts,
            n.id
          ]);
          // Side issue #46 (Theme 8 Phase 3 follow-up) — emit a
          // NOTIFICATION_DROPPED case_event so /ops/silent-failures
          // surfaces max-retries-exhausted outcomes alongside the
          // enqueue-side drops (invalid_to_user_id, no_phone,
          // db_insert_failed, etc. — see notify.js:271,388,591,618).
          // Without this, the only signal lives in error_logs, which
          // /ops/silent-failures doesn't read. Fire-and-forget; helper
          // has its own try/catch isolation.
          emitNotificationDropped({
            orderId: n.order_id,
            reason: 'max_retries_exceeded',
            channel,
            template: n.template,
            toUserId: n.to_user_id
          });
          // Theme 8 Phase 4-B — surface max-retries to /ops/errors.
          // No Error was thrown at this point (the dispatcher returned
          // { ok:false, error:'<string>' }), so synthesize one. Without
          // this wrap, rate-limit / template-rejection patterns across
          // hundreds of notifications would be invisible — only the
          // per-row notifications.status='failed' would surface, and only
          // to operators who query that table directly.
          logErrorToDb(new Error(result.error || 'max_retries_exceeded'), {
            context: 'notification_worker.max_retries_reached',
            category: 'notification_worker',
            candidateId: n.id,
            template: n.template,
            channel,
            attempts,
            workerPhase: 'per_candidate'
          });
          console.error('[notify-worker] max retries reached', { id: n.id, template: n.template, channel, attempts });
        } else {
          // Exponential backoff: 30s, 120s, 480s
          const retryAfter = backoffFor(attempts);

          await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3, retry_after = $4 WHERE id = $5', [
            'retry',
            JSON.stringify({ error: result.error || 'send_failed', attempts }),
            attempts,
            retryAfter,
            n.id
          ]);
          // THEME8-LINT-EXEMPT-HELPER: retry-pending info log, not an error.
          // The notification will be re-dispatched on the next worker tick;
          // surfacing each retry attempt to /ops/errors would be noisy
          // (3 attempts × MAX_RETRIES × notification volume).
          console.warn('[notify-worker] will retry', { id: n.id, template: n.template, channel, attempts, retryAfter });
        }
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'notification_worker.dispatch',
        category: 'notification_worker',
        candidateId: n.id,
        template: n.template,
        workerPhase: 'per_candidate'
      });
      console.error('[notify-worker] failed to process notification', n.id, err);
      const attempts = (n.attempts || 0) + 1;
      const exhausted = attempts >= MAX_RETRIES;
      // AUDIT-2026-08-22: retry_after is now written on BOTH outcomes.
      //
      // This UPDATE used to leave the column alone. But the fetch UPDATE that
      // claimed this row stamped retry_after with the 10-MINUTE CLAIM LEASE
      // (STUCK_SENDING_LEASE_MS) — the column does double duty for 'sending'
      // leases and queued/retry backoff. Writing status='retry' on top of a
      // live lease value means the row is not eligible again until the lease
      // expires: ~10 minutes instead of the intended 30s / 120s / 480s. Every
      // failure that arrived as a THROWN exception (rather than an
      // { ok:false } return) retried on the wrong schedule, including on the
      // time-critical SLA path.
      //
      // On the exhausted branch the lease is cleared to NULL instead, so a
      // dead row does not carry a stale future timestamp that the stuck-
      // 'sending' recovery pass reads as a live claim.
      await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3, retry_after = $4 WHERE id = $5', [
        exhausted ? 'failed' : 'retry',
        `error: ${String(err).slice(0, 500)}`,
        attempts,
        exhausted ? null : backoffFor(attempts),
        n.id
      ]);
    }
  }
  } finally {
    // B10 (launch audit): always release the re-entrancy guard — even on the
    // early returns above or an unexpected throw — so a single bad tick can
    // never wedge the worker permanently.
    running = false;
  }
}

function pingOps(agentName, task) {
  try {
    var http = require('http');
    var body = JSON.stringify({ agent_name: agentName, status: 'running', current_task: task });
    var req = http.request({ hostname: 'localhost', port: Number(process.env.PORT || 3000), path: '/ops/agent/ping', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', function() {});
    req.write(body);
    req.end();
  } catch(e) {}
}

module.exports = { runNotificationWorker, TEMPLATE_TO_EMAIL };
