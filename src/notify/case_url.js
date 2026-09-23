'use strict';

/**
 * The case link an email should carry, chosen by who is receiving it.
 *
 * notification_worker used to fall back to the DOCTOR case page for every
 * `{{caseUrl}}`, so patient emails that never pass caseUrl themselves
 * (patient-refund-*, the patient copy of sla-reminder)
 * linked a patient to /portal/doctor/case/:id — a page their role cannot open.
 * Patients get their own order page; everyone else keeps the doctor case page
 * (prescription-unlocked goes to the doctor, so it correctly stays there).
 *
 * @param {string|null|undefined} recipientRole  users.role of the recipient
 * @param {string|null|undefined} orderId
 * @param {string} appUrl  absolute base, e.g. https://tashkheesa.com
 * @returns {string} absolute URL, or '' when there is no order
 */
function caseUrlForRecipient(recipientRole, orderId, appUrl) {
  if (!orderId) return '';
  const base = String(appUrl || 'https://tashkheesa.com').replace(/\/+$/, '');
  const id = String(orderId);
  return String(recipientRole || '').toLowerCase() === 'patient'
    ? `${base}/portal/patient/orders/${id}`
    : `${base}/portal/doctor/case/${id}`;
}

module.exports = { caseUrlForRecipient };
