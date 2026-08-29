// src/notify/whatsappTemplateMap.js
// Maps internal notification events to Meta-approved WhatsApp HSM template names.
// Each entry defines the per-language Meta template names and a paramBuilder
// that extracts the ordered {{1}}, {{2}} parameters from notification data.
//
// ─── AUDIT (FIX 9): Meta could never send Arabic ────────────────────────────
//
// Every entry used to be `{ templateName: 'x_en', lang: 'en' }`. The worker
// resolved `lang: mapped.lang || fallbackLang`, so the hardcoded 'en' ALWAYS
// beat the recipient's `user.lang`. An Arabic-speaking patient — the primary
// market — could not receive an Arabic WhatsApp on the Meta transport under
// any configuration, and the `fallbackLang` the worker carefully computed was
// dead code for every mapped event.
//
// The shape is now `templateNames: { en, ar }`, and resolution happens in
// resolveWhatsAppTemplate() against the recipient's language with an `en`
// fallback. Every `ar` slot is currently `null` on purpose: approving `*_ar`
// HSM templates with Meta is an external, multi-day Business-verification
// process that has not started. Shipping the code path now means the day an
// Arabic template clears approval, the change is a one-word edit to a data
// literal — not a refactor of the send path under launch pressure.
//
// ┌─ TO ADD AN APPROVED ARABIC TEMPLATE ─────────────────────────────────────┐
// │ Replace the `ar: null` slot with the Meta-approved Arabic HSM name, e.g. │
// │   templateNames: { en: 'case_submitted_en', ar: 'case_submitted_ar' }    │
// │ Nothing else changes — resolveWhatsAppTemplate picks it up immediately   │
// │ for users whose `lang` is 'ar', and `en` users are unaffected.           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// NOTE: the live transport is OpenClaw (see notify/whatsapp.js
// DEFAULT_WHATSAPP_TRANSPORT), which has real per-language bodies in
// openclawTemplates.js. This map only matters if the transport is explicitly
// flipped back to 'meta'.

/**
 * @typedef {Object} WhatsAppTemplateEntry
 * @property {{en: string, ar: (string|null)}} templateNames - Meta-approved HSM
 *   template name per language. `ar: null` means no approved Arabic variant
 *   yet; resolution falls back to `en`.
 * @property {function(Object): Object} paramBuilder - Extracts params from notification data
 */

/** @type {Object.<string, WhatsAppTemplateEntry>} */
const whatsappTemplateMap = {
  // ── Patient Notifications ──────────────────────────────────────────

  order_created_patient: {
    templateNames: { en: 'case_submitted_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
    }),
  },

  public_order_created_patient: {
    templateNames: { en: 'case_submitted_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
    }),
  },

  report_ready_patient: {
    templateNames: { en: 'report_ready_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  payment_success_patient: {
    templateNames: { en: 'payment_confirmed_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.order_id || '',
      amount: data.amount || '',
    }),
  },

  payment_failed_patient: {
    templateNames: { en: 'payment_failed_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.order_id || '',
    }),
  },

  order_status_accepted_patient: {
    templateNames: { en: 'case_accepted_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  order_reassigned_patient: {
    templateNames: { en: 'case_reassigned_patient_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  welcome_patient: {
    templateNames: { en: 'welcome_patient_en', ar: null },
    paramBuilder: (data) => ({
      patient_name: data.patientName || '',
    }),
  },

  // ── Doctor Notifications ──────────────────────────────────────────

  order_assigned_doctor: {
    templateNames: { en: 'case_assigned_doctor_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
      sla_hours: String(data.slaHours || '48'),
    }),
  },

  order_auto_assigned_doctor: {
    templateNames: { en: 'case_assigned_doctor_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
      sla_hours: String(data.slaHours || '48'),
    }),
  },

  order_reassigned_doctor: {
    templateNames: { en: 'case_reassigned_doctor_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      sla_hours: String(data.slaHours || '48'),
    }),
  },

  order_reassigned_to_doctor: {
    templateNames: { en: 'case_reassigned_doctor_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      sla_hours: String(data.slaHours || '48'),
    }),
  },

  sla_warning_75: {
    templateNames: { en: 'sla_warning_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: data.hoursRemaining || '',
    }),
  },

  sla_warning_urgent: {
    templateNames: { en: 'sla_warning_urgent_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: data.hoursRemaining || '',
    }),
  },

  sla_breach: {
    templateNames: { en: 'sla_breached_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  // AUDIT-2026-08-22 (N6): the superadmin breach escalation was split out of
  // `sla_breach` into its own event so the OpenClaw body could stop telling
  // operators to "complete the review" in the doctor portal. On the Meta
  // transport there is no ops-worded HSM to point at — approving one is the
  // same multi-day Business-verification process as the `ar` slots — so this
  // deliberately reuses the approved doctor template rather than becoming an
  // unmapped event, which the worker now treats as a permanent failure. That
  // keeps the (currently blocked) Meta path exactly as good as it was before
  // the split, no better and no worse. Replace `sla_breach_superadmin_en` here
  // the day an ops-worded template clears approval.
  sla_breach_superadmin: {
    templateNames: { en: 'sla_breached_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  doctor_approved: {
    templateNames: { en: 'doctor_welcome_en', ar: null },
    paramBuilder: (data) => ({
      doctor_name: data.doctorName || '',
    }),
  },

  // No approved Meta template exists for this one yet, so both languages are
  // null and the Meta path will decline it rather than fail. It still needs an
  // entry: an unmapped template is an error, and OpenClaw (the free-text path)
  // reads openclawTemplates.js, not this file.
  doctor_confirm_services: {
    templateNames: { en: null, ar: null },
    paramBuilder: (data) => ({
      doctor_name: data.doctorName || '',
    }),
  },

  // ── Appointment Notifications ──────────────────────────────────────

  appointment_booked: {
    templateNames: { en: 'appointment_confirmed_en', ar: null },
    paramBuilder: (data) => ({
      date_time: data.appointmentDate || data.appointment_time || '',
      doctor_name: data.doctorName || data.doctor_name || '',
    }),
  },

  appointment_reminder: {
    templateNames: { en: 'appointment_reminder_en', ar: null },
    paramBuilder: (data) => ({
      date_time: data.appointmentDate || data.appointment_time || '',
      doctor_name: data.doctorName || data.doctor_name || '',
    }),
  },

  appointment_rescheduled: {
    templateNames: { en: 'appointment_rescheduled_en', ar: null },
    paramBuilder: (data) => ({
      old_time: data.old_time || '',
      new_time: data.new_time || '',
    }),
  },

  // ── New Event Notifications ──────────────────────────────────────

  additional_files_requested_patient: {
    templateNames: { en: 'additional_files_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      reason: data.reason || 'Additional files needed',
    }),
  },

  prescription_uploaded_patient: {
    templateNames: { en: 'prescription_ready_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  patient_uploaded_files_doctor: {
    templateNames: { en: 'patient_uploaded_files_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      patient_name: data.patientName || '',
    }),
  },

  appointment_cancelled: {
    templateNames: { en: 'appointment_cancelled_en', ar: null },
    paramBuilder: (data) => ({
      date_time: data.appointmentDate || '',
      doctor_name: data.doctorName || '',
    }),
  },

  // ── WhatsApp-via-OpenClaw rollout (2026-05) ───────────────────────
  // These events are primarily served by the OpenClaw transport (free-text
  // bodies in openclawTemplates.js). The Meta entries below are STUBS:
  // template names not yet approved in Meta Business Manager. They exist
  // so that if NOTIFICATIONS_WHATSAPP_TRANSPORT is ever flipped back to
  // 'meta', the map lookup returns *something* and the Meta send simply
  // fails with template_not_found rather than crashing the worker. Submit
  // these templates to Meta for approval if we ever revert.

  case_cancelled_patient: {
    templateNames: { en: 'case_cancelled_patient_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      reason: data.reason || '',
    }),
  },

  addon_purchased_video: {
    templateNames: { en: 'addon_video_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      appointment_time: data.appointmentTime || data.appointment_time || '',
      doctor_name: data.doctorName || '',
    }),
  },

  addon_purchased_urgency: {
    templateNames: { en: 'addon_urgency_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      sla_hours: String(data.slaHours || data.sla_hours || ''),
    }),
  },

  addon_purchased_prescription: {
    templateNames: { en: 'addon_prescription_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  // #66: payment-reminder series. Same Meta-stub caveat as the
  // WhatsApp-via-OpenClaw block above — template names below are not
  // yet approved in Meta Business Manager. The OpenClaw transport
  // (openclawTemplates.js) is the canonical send path; these entries
  // exist so a future flip back to 'meta' fails with a template-
  // not-found error instead of crashing the worker.
  payment_reminder_30m: {
    templateNames: { en: 'payment_reminder_30m_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      payment_url: data.paymentUrl || data.payment_url || '',
    }),
  },

  payment_reminder_6h: {
    templateNames: { en: 'payment_reminder_6h_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      payment_url: data.paymentUrl || data.payment_url || '',
    }),
  },

  payment_reminder_24h: {
    templateNames: { en: 'payment_reminder_24h_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      payment_url: data.paymentUrl || data.payment_url || '',
      hours_remaining: String(data.hoursRemaining || data.hours_remaining || '24'),
    }),
  },

  // Theme 14 Phase 5 — patient notification when superadmin approves a
  // manual-queue triage with a specialty different from the patient's
  // submission. Meta-stub caveat: template name is not yet approved in
  // Meta Business Manager; OpenClaw is the canonical send path. Stub
  // exists so a future flip back to 'meta' fails with a template-
  // not-found error instead of crashing the worker.
  case_routing_updated: {
    templateNames: { en: 'case_routing_updated_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  // ── SLA reminder tiers (FIX 4) ────────────────────────────────────
  // Queued by case_lifecycle.dispatchSlaReminders at 24h / 6h / 1h of
  // remaining SLA, to BOTH the assigned doctor and the patient, on the
  // 'whatsapp' and 'email' channels. Same Meta-stub caveat as the blocks
  // above: these names are not yet approved in Meta Business Manager, and
  // OpenClaw (openclawTemplates.js) is the canonical send path. The entries
  // exist so a flip back to 'meta' fails with template-not-found instead of
  // silently falling through to the raw internal event name.
  sla_reminder_24h: {
    templateNames: { en: 'sla_reminder_24h_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: String(data.hoursRemaining || data.hours_remaining || '24'),
    }),
  },

  sla_reminder_6h: {
    templateNames: { en: 'sla_reminder_6h_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: String(data.hoursRemaining || data.hours_remaining || '6'),
    }),
  },

  sla_reminder_1h: {
    templateNames: { en: 'sla_reminder_1h_en', ar: null },
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: String(data.hoursRemaining || data.hours_remaining || '1'),
    }),
  },
};

/**
 * Get the WhatsApp HSM template config for a notification event, resolved
 * against the recipient's language.
 *
 * Resolution order: the requested language's approved template name, then
 * the `en` name. `ar` slots are null until the corresponding Arabic HSM
 * template clears Meta approval (see the file header), so today every
 * recipient resolves to `en` — but via the recipient's language rather than
 * a hardcoded literal, so approving one Arabic template is a data-only change.
 *
 * The returned object keeps the historical `{ templateName, lang }` shape so
 * the worker's send path and existing callers are unchanged.
 *
 * @param {string} eventName - Internal notification template name
 * @param {string} [lang='en'] - Recipient language ('ar' | 'en')
 * @returns {{templateName: string, lang: string, paramBuilder: function, langFellBack: boolean}|null}
 */
function getWhatsAppTemplate(eventName, lang) {
  const entry = whatsappTemplateMap[eventName];
  if (!entry) return null;

  const names = entry.templateNames || {};
  const want = String(lang || 'en').toLowerCase() === 'ar' ? 'ar' : 'en';
  const resolvedName = names[want] || names.en || null;
  if (!resolvedName) return null;

  // If we wanted 'ar' but landed on the 'en' name, the LANGUAGE CODE sent to
  // Meta must also be 'en' — an approved English template submitted with
  // language code 'ar' is rejected by the Cloud API (132001
  // template_not_found), which is exactly the silent-failure mode this fix
  // exists to remove.
  const resolvedLang = (want === 'ar' && names.ar) ? 'ar' : 'en';

  return {
    templateName: resolvedName,
    lang: resolvedLang,
    paramBuilder: entry.paramBuilder,
    langFellBack: want === 'ar' && resolvedLang === 'en',
  };
}

module.exports = { whatsappTemplateMap, getWhatsAppTemplate };
