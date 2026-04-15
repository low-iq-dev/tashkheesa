// src/notify/templates.js
// All WhatsApp template names used across the notification system.
// These must match approved Meta template names exactly.

const TEMPLATES = Object.freeze({
  // Patient templates
  CASE_SUBMITTED:            'tashkheesa_case_submitted',
  PAYMENT_LINK:              'tashkheesa_payment_link',
  PAYMENT_CONFIRMED:         'tashkheesa_payment_confirmed',
  CASE_ASSIGNED:             'tashkheesa_case_assigned',
  CASE_ASSIGNED_URGENT:      'tashkheesa_case_assigned_urgent',
  REPORT_READY:              'tashkheesa_report_ready',
  CASE_CANCELLED_REFUND:     'tashkheesa_cancelled_refund',
  CASE_CANCELLED_NO_REFUND:  'tashkheesa_cancelled_no_refund',
  DR_NEEDS_INFO:             'tashkheesa_dr_needs_info',

  // Doctor templates
  NEW_CASE_STANDARD:         'tashkheesa_new_case_standard',
  NEW_CASE_FASTTRACK:        'tashkheesa_new_case_fasttrack',
  NEW_CASE_URGENT:           'tashkheesa_new_case_urgent',
  CASE_AUTO_ASSIGNED:        'tashkheesa_case_auto_assigned',
  SLA_WARNING_75:            'sla_warning_75',
  SLA_WARNING_URGENT:        'sla_warning_urgent',
  SLA_BREACH:                'sla_breach',

  // Admin templates
  SLA_BREACH_ADMIN:          'sla_breach',
});

module.exports = { TEMPLATES };
