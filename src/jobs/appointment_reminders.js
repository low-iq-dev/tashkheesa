// src/jobs/appointment_reminders.js
// Appointment reminder scheduler (Phase 10)
// Sends email + WhatsApp reminders at 24h and 1h before scheduled appointments

const { execute } = require('../pg');
const { safeAll } = require('../sql-utils');
const { queueNotification, queueMultiChannelNotification } = require('../notify');
const { logErrorToDb } = require('../logger');
const { formatDate, formatDateTime } = require('../utils/formatNumber');

let sendEmailFn = null;
try {
  sendEmailFn = require('../services/emailService').sendEmail;
} catch (_) {}

async function runAppointmentReminders() {
  try {
    var now = new Date();
    var nowIso = now.toISOString();

    // 24-hour reminders: appointments within next 24 hours that haven't been reminded
    var in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    var appts24h = await safeAll(
      `SELECT a.*, p.name as patient_name, p.email as patient_email, p.phone as patient_phone,
              p.lang as patient_lang, d.name as doctor_name, d.lang as doctor_lang
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
       WHERE a.status IN ('confirmed', 'pending', 'scheduled')
         AND a.scheduled_at <= $1
         AND a.scheduled_at > $2
         AND a.reminder_24h_sent = false`,
      [in24h, nowIso], []
    );

    for (const appt of appts24h) {
      await sendReminder(appt, '24h');
      try {
        await execute('UPDATE appointments SET reminder_24h_sent = true WHERE id = $1', [appt.id]);
      } catch (_) {}
    }

    // 1-hour reminders: appointments within next 1 hour that haven't been reminded
    var in1h = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    var appts1h = await safeAll(
      `SELECT a.*, p.name as patient_name, p.email as patient_email, p.phone as patient_phone,
              p.lang as patient_lang, d.name as doctor_name, d.lang as doctor_lang
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
       WHERE a.status IN ('confirmed', 'pending', 'scheduled')
         AND a.scheduled_at <= $1
         AND a.scheduled_at > $2
         AND a.reminder_1h_sent = false`,
      [in1h, nowIso], []
    );

    for (const appt of appts1h) {
      await sendReminder(appt, '1h');
      try {
        await execute('UPDATE appointments SET reminder_1h_sent = true WHERE id = $1', [appt.id]);
      } catch (_) {}
    }

    if (appts24h.length > 0 || appts1h.length > 0) {
      console.log('[reminders] Sent ' + appts24h.length + ' 24h reminders, ' + appts1h.length + ' 1h reminders');
    }
  } catch (err) {
    logErrorToDb(err, { context: 'appointment_reminders', type: 'cron_job' });
  }
}

async function sendReminder(appt, timing) {
  var scheduledDate = new Date(appt.scheduled_at);
  // Theme 10b §C / OQ-3: format dates per-recipient using their lang_pref.
  // Pre-Theme 10b this hardcoded 'en-US' for both patient and doctor — AR
  // patients received notifications in English even though their UI was AR.
  var patientLang = (appt.patient_lang === 'ar') ? 'ar' : 'en';
  var doctorLang  = (appt.doctor_lang  === 'ar') ? 'ar' : 'en';
  var patientDateStr = formatDate(scheduledDate, patientLang,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var patientTimeStr = scheduledDate.toLocaleTimeString(
    patientLang === 'ar' ? 'ar-EG' : 'en-GB',
    { hour: '2-digit', minute: '2-digit' });
  var doctorDateStr = formatDate(scheduledDate, doctorLang,
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var doctorTimeStr = scheduledDate.toLocaleTimeString(
    doctorLang === 'ar' ? 'ar-EG' : 'en-GB',
    { hour: '2-digit', minute: '2-digit' });

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
        lang: patientLang,
        data: {
          patientName: appt.patient_name || 'Patient',
          doctorName: appt.doctor_name || 'Doctor',
          appointmentDate: patientDateStr,
          appointmentTime: patientTimeStr,
          joinUrl: joinUrl,
          timing: timing
        }
      }).catch(function() { /* fire and forget */ });
    } catch (_) {}
  }

  // Queue multi-channel notification to patient (uses patientLang-formatted strings)
  try {
    await queueMultiChannelNotification({
      orderId: appt.order_id || null,
      toUserId: appt.patient_id,
      channels: ['internal', 'email', 'whatsapp'],
      template: 'appointment_reminder',
      response: {
        doctor_name: appt.doctor_name,
        doctorName: appt.doctor_name,
        appointment_date: patientDateStr,
        appointment_time: patientTimeStr,
        appointmentDate: patientDateStr + ' ' + patientTimeStr
      },
      dedupe_key: 'appt:reminder:' + timing + ':' + appt.id
    });
  } catch (_) {}

  // Queue multi-channel notification to doctor (uses doctorLang-formatted strings)
  try {
    await queueMultiChannelNotification({
      orderId: appt.order_id || null,
      toUserId: appt.doctor_id,
      channels: ['internal', 'email'],
      template: 'appointment_reminder',
      response: {
        patient_name: appt.patient_name,
        patientName: appt.patient_name,
        appointment_date: doctorDateStr,
        appointment_time: doctorTimeStr,
        appointmentDate: doctorDateStr + ' ' + doctorTimeStr
      },
      dedupe_key: 'appt:reminder:doctor:' + timing + ':' + appt.id
    });
  } catch (_) {}
}

module.exports = { runAppointmentReminders };
