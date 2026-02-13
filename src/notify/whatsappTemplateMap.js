// src/notify/whatsappTemplateMap.js
// Maps internal notification events to Meta-approved WhatsApp HSM template names.
// Each entry defines the Meta template name, language, and a paramBuilder
// that extracts the ordered {{1}}, {{2}} parameters from notification data.

/**
 * @typedef {Object} WhatsAppTemplateEntry
 * @property {string} templateName - Meta-approved HSM template name
 * @property {string} lang - Template language code (e.g., 'en', 'ar')
 * @property {function(Object): Object} paramBuilder - Extracts params from notification data
 */

/** @type {Object.<string, WhatsAppTemplateEntry>} */
const whatsappTemplateMap = {
  // ── Patient Notifications ──────────────────────────────────────────

  order_created_patient: {
    templateName: 'case_submitted_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
    }),
  },

  public_order_created_patient: {
    templateName: 'case_submitted_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
    }),
  },

  report_ready_patient: {
    templateName: 'report_ready_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  payment_success_patient: {
    templateName: 'payment_confirmed_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.order_id || '',
      amount: data.amount || '',
    }),
  },

  payment_failed_patient: {
    templateName: 'payment_failed_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.order_id || '',
    }),
  },

  order_status_accepted_patient: {
    templateName: 'case_accepted_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      doctor_name: data.doctorName || '',
    }),
  },

  order_reassigned_patient: {
    templateName: 'case_reassigned_patient_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  welcome_patient: {
    templateName: 'welcome_patient_en',
    lang: 'en',
    paramBuilder: (data) => ({
      patient_name: data.patientName || '',
    }),
  },

  // ── Doctor Notifications ──────────────────────────────────────────

  order_assigned_doctor: {
    templateName: 'case_assigned_doctor_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
      sla_hours: String(data.slaHours || '72'),
    }),
  },

  order_auto_assigned_doctor: {
    templateName: 'case_assigned_doctor_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      specialty: data.specialty || '',
      sla_hours: String(data.slaHours || '72'),
    }),
  },

  order_reassigned_doctor: {
    templateName: 'case_reassigned_doctor_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      sla_hours: String(data.slaHours || '72'),
    }),
  },

  order_reassigned_to_doctor: {
    templateName: 'case_reassigned_doctor_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      sla_hours: String(data.slaHours || '72'),
    }),
  },

  sla_warning_75: {
    templateName: 'sla_warning_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: data.hoursRemaining || '',
    }),
  },

  sla_warning_urgent: {
    templateName: 'sla_warning_urgent_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
      hours_remaining: data.hoursRemaining || '',
    }),
  },

  sla_breach: {
    templateName: 'sla_breached_en',
    lang: 'en',
    paramBuilder: (data) => ({
      case_ref: data.caseReference || data.case_id || '',
    }),
  },

  doctor_approved: {
    templateName: 'doctor_welcome_en',
    lang: 'en',
    paramBuilder: (data) => ({
      doctor_name: data.doctorName || '',
    }),
  },

  // ── Appointment Notifications ──────────────────────────────────────

  appointment_booked: {
    templateName: 'appointment_confirmed_en',
    lang: 'en',
    paramBuilder: (data) => ({
      date_time: data.appointmentDate || data.appointment_time || '',
      doctor_name: data.doctorName || data.doctor_name || '',
    }),
  },

  appointment_reminder: {
    templateName: 'appointment_reminder_en',
    lang: 'en',
    paramBuilder: (data) => ({
      date_time: data.appointmentDate || data.appointment_time || '',
      doctor_name: data.doctorName || data.doctor_name || '',
    }),
  },

  appointment_rescheduled: {
    templateName: 'appointment_rescheduled_en',
    lang: 'en',
    paramBuilder: (data) => ({
      old_time: data.old_time || '',
      new_time: data.new_time || '',
    }),
  },
};

/**
 * Get the WhatsApp HSM template config for a notification event.
 * @param {string} eventName - Internal notification template name
 * @returns {WhatsAppTemplateEntry|null}
 */
function getWhatsAppTemplate(eventName) {
  return whatsappTemplateMap[eventName] || null;
}

module.exports = { whatsappTemplateMap, getWhatsAppTemplate };
