// Lightweight notification queue helper
const { randomUUID } = require('crypto');
const { db } = require('./db');
const { sendDoctorEmail, sendDoctorWhatsApp } = require('./notify_doctor');

function queueNotification({ orderId, toUserId, channel = 'internal', template, status = 'queued', response = null }) {
  if (!orderId || !toUserId) return;
  try {
    db.prepare(
      `INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, response, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(randomUUID(), orderId, toUserId, channel, template || '', status, response);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('queueNotification error', err);
  }
}

function doctorNotify({ doctor, template, order }) {
  if (!doctor || !doctor.email) return;

  let subject = '';
  let message = '';

  switch (template) {
    case 'order_assigned_doctor':
      subject = 'New Case Assigned';
      message = `A new case has been assigned to you. Order ID: ${order.id}`;
      break;
    case 'order_accepted_doctor':
      subject = 'Case Accepted by You';
      message = `You accepted case ${order.id}.`;
      break;
    case 'order_in_review':
      subject = 'Case In Review';
      message = `Case ${order.id} is now marked as In Review.`;
      break;
    case 'order_completed':
      subject = 'Case Completed';
      message = `Your report for case ${order.id} has been submitted successfully.`;
      break;
    case 'sla_breached':
      subject = 'SLA Breached';
      message = `Case ${order.id} has passed its deadline. Immediate attention required.`;
      break;
    default:
      return;
  }

  sendDoctorEmail(doctor.email, subject, message);

  if (doctor.phone) {
    sendDoctorWhatsApp(doctor.phone, message);
  }
}

module.exports = { queueNotification, doctorNotify };
