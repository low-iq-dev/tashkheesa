// src/jobs/appointment_reminders.js
// Appointment reminder scheduler (Phase 10)
// Sends email + WhatsApp reminders at 24h and 1h before scheduled appointments

const { db } = require('../db');
const { safeAll } = require('../sql-utils');
const { queueNotification } = require('../notify');
const { logErrorToDb } = require('../logger');

let sendEmailFn = null;
try {
  sendEmailFn = require('../services/emailService').sendEmail;
} catch (_) {}

function runAppointmentReminders() {
  try {
    var now = new Date();
    var nowIso = now.toISOString();

    // 24-hour reminders: appointments within next 24 hours that haven't been reminded
    var in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    var appts24h = safeAll(
      `SELECT a.*, p.name as patient_name, p.email as patient_email, p.phone as patient_phone,
              d.name as doctor_name
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
       WHERE a.status IN ('confirmed', 'pending', 'scheduled')
         AND a.scheduled_at <= ?
         AND a.scheduled_at > ?
         AND a.reminder_24h_sent = 0`,
      [in24h, nowIso], []
    );

    appts24h.forEach(function(appt) {
      sendReminder(appt, '24h');
      try {
        db.prepare('UPDATE appointments SET reminder_24h_sent = 1 WHERE id = ?').run(appt.id);
      } catch (_) {}
    });

    // 1-hour reminders: appointments within next 1 hour that haven't been reminded
    var in1h = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    var appts1h = safeAll(
      `SELECT a.*, p.name as patient_name, p.email as patient_email, p.phone as patient_phone,
              d.name as doctor_name
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
       WHERE a.status IN ('confirmed', 'pending', 'scheduled')
         AND a.scheduled_at <= ?
         AND a.scheduled_at > ?
         AND a.reminder_1h_sent = 0`,
      [in1h, nowIso], []
    );

    appts1h.forEach(function(appt) {
      sendReminder(appt, '1h');
      try {
        db.prepare('UPDATE appointments SET reminder_1h_sent = 1 WHERE id = ?').run(appt.id);
      } catch (_) {}
    });

    if (appts24h.length > 0 || appts1h.length > 0) {
      console.log('[reminders] Sent ' + appts24h.length + ' 24h reminders, ' + appts1h.length + ' 1h reminders');
    }
  } catch (err) {
    logErrorToDb(err, { context: 'appointment_reminders', type: 'cron_job' });
  }
}

function sendReminder(appt, timing) {
  var scheduledDate = new Date(appt.scheduled_at);
  var dateStr = scheduledDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var timeStr = scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  var APP_URL = process.env.APP_URL || 'https://tashkheesa.com';
  var joinUrl = APP_URL + '/portal/patient/appointments';

  // Send email reminder to patient
  if (sendEmailFn && appt.patient_email) {
    try {
      sendEmailFn({
        to: appt.patient_email,
        subject: timing === '1h'
          ? 'Your appointment starts in 1 hour'
          : 'Appointment reminder - tomorrow',
        template: 'appointment-reminder',
        lang: 'en',
        data: {
          patientName: appt.patient_name || 'Patient',
          doctorName: appt.doctor_name || 'Doctor',
          appointmentDate: dateStr,
          appointmentTime: timeStr,
          joinUrl: joinUrl,
          timing: timing
        }
      }).catch(function() { /* fire and forget */ });
    } catch (_) {}
  }

  // Queue in-app notification to patient
  try {
    queueNotification({
      orderId: appt.order_id || null,
      toUserId: appt.patient_id,
      template: 'appointment_reminder_' + timing,
      response: JSON.stringify({
        doctor_name: appt.doctor_name,
        appointment_date: dateStr,
        appointment_time: timeStr
      }),
      dedupe_key: 'appt:reminder:' + timing + ':' + appt.id
    });
  } catch (_) {}

  // Queue in-app notification to doctor
  try {
    queueNotification({
      orderId: appt.order_id || null,
      toUserId: appt.doctor_id,
      template: 'appointment_reminder_doctor_' + timing,
      response: JSON.stringify({
        patient_name: appt.patient_name,
        appointment_date: dateStr,
        appointment_time: timeStr
      }),
      dedupe_key: 'appt:reminder:doctor:' + timing + ':' + appt.id
    });
  } catch (_) {}
}

module.exports = { runAppointmentReminders };
