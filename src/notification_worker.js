// src/notification_worker.js
// Production notification worker: processes queued notifications via email and WhatsApp

const { db } = require('./db');
const { sendEmail, renderEmail, EMAIL_ENABLED } = require('./services/emailService');
const { sendWhatsApp } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');

const MAX_RETRIES = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
const DRY_RUN = String(process.env.NOTIFICATION_DRY_RUN || 'false').toLowerCase() === 'true';

/**
 * Map notification template names to email template file names.
 * notification template → email .hbs file (without extension)
 */
const TEMPLATE_TO_EMAIL = {
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
  order_reassigned_doctor: 'case-reassigned',
  order_reassigned_to_doctor: 'case-reassigned',
  welcome_patient: 'welcome',
  doctor_approved: 'doctor-welcome',
};

/**
 * Process a single email notification.
 * @param {Object} notification - The notification row
 * @param {Object} user - The user row (id, email, name, phone, lang)
 * @param {Object|null} order - The order row if applicable
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function processEmail(notification, user, order) {
  if (!user.email) {
    return { ok: false, error: 'no_email_for_user' };
  }

  const emailTemplate = TEMPLATE_TO_EMAIL[notification.template];
  if (!emailTemplate) {
    // No email template mapping — treat as unsupported
    return { ok: false, error: `no_email_template_mapping_for_${notification.template}` };
  }

  const lang = user.lang || 'en';
  const titles = getNotificationTitles(notification.template);
  const subject = lang === 'ar' ? titles.title_ar : titles.title_en;

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

  // Enrich template data with common variables
  const templateData = {
    ...data,
    patientName: data.patientName || user.name || 'Patient',
    doctorName: data.doctorName || '',
    caseReference: data.caseReference || (order ? String(order.id).slice(0, 12).toUpperCase() : ''),
    specialty: data.specialty || '',
    slaHours: data.slaHours || (order ? order.sla_hours : ''),
    dashboardUrl: data.dashboardUrl || `${process.env.APP_URL || 'https://tashkheesa.com'}/dashboard`,
    caseUrl: data.caseUrl || (order ? `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/doctor/case/${order.id}` : ''),
    reportUrl: data.reportUrl || (order && order.report_url ? `${process.env.APP_URL || 'https://tashkheesa.com'}${order.report_url}` : ''),
    appUrl: process.env.APP_URL || 'https://tashkheesa.com',
  };

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
    return { ok: false, error: 'no_phone_for_user' };
  }

  // Parse response payload for template variables
  let vars = {};
  try {
    if (notification.response) {
      vars = typeof notification.response === 'string'
        ? JSON.parse(notification.response)
        : notification.response;
    }
  } catch (e) {
    vars = {};
  }

  if (DRY_RUN) {
    console.log('[notify-worker][DRY_RUN] Would send WhatsApp', { to: user.phone, template: notification.template });
    return { ok: true, dryRun: true };
  }

  const lang = user.lang === 'ar' ? 'ar' : 'en_US';

  const result = await sendWhatsApp({
    to: user.phone,
    template: notification.template,
    lang,
    vars,
  });

  return result;
}

/**
 * Run the notification worker: poll queued/retry notifications and process them.
 * @param {number} limit - Max notifications to process per run
 */
async function runNotificationWorker(limit = 50) {
  const nowIso = new Date().toISOString();
  let notifications = [];

  try {
    notifications = db
      .prepare(
        `SELECT * FROM notifications
         WHERE status IN ('queued', 'retry')
           AND (retry_after IS NULL OR retry_after <= ?)
         ORDER BY at ASC
         LIMIT ?`
      )
      .all(nowIso, limit);
  } catch (err) {
    console.error('[notify-worker] failed to load notifications', err);
    return;
  }

  if (!notifications.length) return;

  for (const n of notifications) {
    try {
      const user = db
        .prepare('SELECT id, email, name, phone, lang, notify_whatsapp FROM users WHERE id = ?')
        .get(n.to_user_id);

      const order = n.order_id
        ? db.prepare('SELECT * FROM orders WHERE id = ?').get(n.order_id)
        : null;

      if (!user) {
        db.prepare('UPDATE notifications SET status = ?, response = ? WHERE id = ?').run(
          'failed',
          'error: user not found',
          n.id
        );
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

      if (result.ok || result.skipped) {
        db.prepare('UPDATE notifications SET status = ?, response = ? WHERE id = ?').run(
          'sent',
          JSON.stringify(result),
          n.id
        );
      } else {
        // Handle failure with retry
        const attempts = (n.attempts || 0) + 1;

        if (attempts >= MAX_RETRIES) {
          db.prepare('UPDATE notifications SET status = ?, response = ?, attempts = ? WHERE id = ?').run(
            'failed',
            JSON.stringify({ error: result.error || 'max_retries_exceeded', attempts }),
            attempts,
            n.id
          );
          console.error('[notify-worker] max retries reached', { id: n.id, template: n.template, channel, attempts });
        } else {
          // Exponential backoff: 30s, 120s, 480s
          const backoffMs = 30000 * Math.pow(4, attempts - 1);
          const retryAfter = new Date(Date.now() + backoffMs).toISOString();

          db.prepare('UPDATE notifications SET status = ?, response = ?, attempts = ?, retry_after = ? WHERE id = ?').run(
            'retry',
            JSON.stringify({ error: result.error || 'send_failed', attempts }),
            attempts,
            retryAfter,
            n.id
          );
          console.warn('[notify-worker] will retry', { id: n.id, template: n.template, channel, attempts, retryAfter });
        }
      }
    } catch (err) {
      console.error('[notify-worker] failed to process notification', n.id, err);
      const attempts = (n.attempts || 0) + 1;
      db.prepare('UPDATE notifications SET status = ?, response = ?, attempts = ? WHERE id = ?').run(
        attempts >= MAX_RETRIES ? 'failed' : 'retry',
        `error: ${String(err).slice(0, 500)}`,
        attempts,
        n.id
      );
    }
  }
}

module.exports = { runNotificationWorker, TEMPLATE_TO_EMAIL };
