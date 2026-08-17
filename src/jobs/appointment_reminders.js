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
      await markReminderSent(appt, '24h', 'reminder_24h_sent');
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
      await markReminderSent(appt, '1h', 'reminder_1h_sent');
    }

    if (appts24h.length > 0 || appts1h.length > 0) {
      console.log('[reminders] Sent ' + appts24h.length + ' 24h reminders, ' + appts1h.length + ' 1h reminders');
    }
  } catch (err) {
    logErrorToDb(err, { context: 'appointment_reminders', type: 'cron_job' });
  }
}

/**
 * Flip the reminder_{24h,1h}_sent flag AFTER the reminder has been queued.
 *
 * AUDIT (FIX 10) — both call sites used to be `try { await execute(...) }
 * catch (_) {}`. That swallow sits AFTER delivery, on the only piece of
 * state that stops the sweep re-selecting this appointment: the WHERE
 * clause above filters on `reminder_Nh_sent = false`. If the UPDATE fails
 * — connection blip, statement timeout, pool exhaustion during a spike —
 * the flag stays false, the next tick re-selects the same row, and the
 * patient is re-reminded every 15 minutes until the appointment passes,
 * with not one line written anywhere an operator would look.
 *
 * Two changes:
 *   1. The failure is written to error_logs via logErrorToDb, so a stuck
 *      flag surfaces on /ops/errors instead of only in the patient's
 *      WhatsApp thread.
 *   2. One in-process retry. The realistic failure here is transient, and
 *      a single immediate retry closes most of the window without adding
 *      a backoff loop to a cron that already runs every 15 minutes.
 *
 * Note on blast radius: the queued notifications carry a stable dedupe_key
 * ('appt:reminder:<timing>:<id>'), so queueNotification dedupes the repeat
 * and the patient does NOT actually receive duplicate messages once the
 * first copy exists. The damage is a permanently re-processed row and a
 * hidden write failure — real, but not a duplicate-send. Do not "fix" this
 * by weakening the dedupe key.
 */
async function markReminderSent(appt, timing, column) {
  // `column` is a fixed internal literal ('reminder_24h_sent' /
  // 'reminder_1h_sent'), never caller/user input — safe to interpolate.
  const sql = 'UPDATE appointments SET ' + column + ' = true WHERE id = $1';
  try {
    await execute(sql, [appt.id]);
    return true;
  } catch (firstErr) {
    try {
      await execute(sql, [appt.id]);
      return true;
    } catch (err) {
      logErrorToDb(err, {
        context: 'appointment_reminders.mark_sent',
        category: 'cron_job',
        type: 'cron_job',
        appointmentId: appt.id,
        orderId: appt.order_id || null,
        userId: appt.patient_id || null,
        timing: timing,
        column: column
      });
      console.error(
        '[reminders] FAILED to set ' + column + ' for appointment ' + appt.id +
        ' — this appointment will be re-processed every sweep until the write succeeds',
        err && err.message ? err.message : err
      );
      return false;
    }
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
  // AUDIT-P1-4 — the direct sendEmailFn call here was REMOVED.
  //
  // It sent template 'appointment-reminder' to the patient, and then the queued
  // multi-channel notification below includes the 'email' channel with template
  // 'appointment_reminder', which TEMPLATE_TO_EMAIL maps to the SAME
  // appointment-reminder.hbs file. Every patient therefore received two
  // identical reminder emails at 24h and two more at 1h. The dedupe_key does
  // not help — it only dedupes the queued copy against itself.
  //
  // The queued path is the one to keep: it is dedupe-keyed, retried, recorded
  // in the notifications table, visible on /ops, and also delivers WhatsApp and
  // the in-app bell.

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
  } catch (err) {
    // AUDIT (FIX 10) — was `catch (_) {}`. queueMultiChannelNotification is
    // documented as non-throwing, so reaching here means something upstream
    // of it broke (module load, normalizeToUserId). Either way the patient
    // was not reminded and the caller then sets reminder_Nh_sent = true, so
    // this is the last chance to record that the reminder is gone.
    logErrorToDb(err, {
      context: 'appointment_reminders.queue_patient',
      category: 'cron_job',
      type: 'cron_job',
      appointmentId: appt.id,
      orderId: appt.order_id || null,
      userId: appt.patient_id || null,
      timing: timing
    });
  }

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
  } catch (err) {
    // AUDIT (FIX 10) — see the patient branch above.
    logErrorToDb(err, {
      context: 'appointment_reminders.queue_doctor',
      category: 'cron_job',
      type: 'cron_job',
      appointmentId: appt.id,
      orderId: appt.order_id || null,
      userId: appt.doctor_id || null,
      timing: timing
    });
  }
}

module.exports = { runAppointmentReminders };
