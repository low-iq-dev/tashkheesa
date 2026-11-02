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

/**
 * A link a message can carry: absolute. A same-site path ('/portal/patient/
 * pay/<id>' — what orders.payment_link holds, routes/patient.js) is prefixed
 * with the app's base; an absolute URL, or nothing, is returned as it is.
 * WhatsApp and email clients cannot follow a bare path: the 14 Oct payment
 * reminders went out with one.
 *
 * @param {string|null|undefined} url
 * @param {string} [appUrl] absolute base, default APP_URL / https://tashkheesa.com
 * @returns {string}
 */
function absoluteAppUrl(url, appUrl) {
  const u = String(url == null ? '' : url).trim();
  if (!u || u.charAt(0) !== '/' || u.charAt(1) === '/') return u;
  const base = String(appUrl || process.env.APP_URL || 'https://tashkheesa.com').replace(/\/+$/, '');
  return base + u;
}

module.exports = { caseUrlForRecipient, absoluteAppUrl };
