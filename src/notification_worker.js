// src/notification_worker.js
// Production notification worker: processes queued notifications via email and WhatsApp

const { queryAll, queryOne, execute } = require('./pg');
const { sendEmail, renderEmail, EMAIL_ENABLED } = require('./services/emailService');
const { sendWhatsApp } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');
const { getWhatsAppTemplate } = require('./notify/whatsappTemplateMap');

const MAX_RETRIES = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
const DRY_RUN = String(process.env.NOTIFICATION_DRY_RUN || 'false').toLowerCase() === 'true';

// P1-NOTIF-4: doctor names in the users table are stored already-prefixed
// (per src/create_test_doctor.js seed data — "Dr. Ahmed Hassan"). Email
// templates also prepend "Dr. " (e.g. doctor-welcome.hbs:7, sla-warning.hbs:7,
// case-accepted.hbs:36, report-ready.hbs:36). Without this strip, doctors see
// "Hi Dr. Dr. Ahmed Hassan,". Stripping centrally in the worker is more
// defensive than removing the prefix from 4 templates: if a future caller
// passes an unprefixed name, templates still render correctly.
function stripDrPrefix(name) {
  return String(name == null ? '' : name).replace(/^\s*Dr\.?\s+/i, '').trim();
}

/**
 * Map notification template names to email template file names.
 * notification template -> email .hbs file (without extension)
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
  // P1-FIN-2: explainer to the BOOTED doctor (the one removed from the case)
  // about partial pay. Different template than 'case-reassigned' which is
  // addressed to the NEW doctor.
  order_reassigned_from_doctor: 'case-reassigned-original',
  welcome_patient: 'welcome',
  doctor_approved: 'doctor-welcome',
  additional_files_requested_patient: 'additional-files-request',
  additional_files_request_approved_patient: 'additional-files-request',
  patient_uploaded_files_doctor: 'patient-uploaded-files',
  prescription_uploaded_patient: 'prescription-uploaded',
  new_message: 'new-message',
  appointment_cancelled: 'appointment-cancelled',
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
    // No email template mapping -- treat as unsupported
    return { ok: false, error: `no_email_template_mapping_for_${notification.template}` };
  }

  const lang = user.lang || 'en';

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

  // Enrich template data with common variables.
  // P1-NOTIF-4: stripDrPrefix removes any leading "Dr." / "Dr " from
  // doctorName. Doctor records are typically stored already-prefixed
  // (e.g. "Dr. Ahmed Hassan"), and the email templates also prepend
  // "Dr. " — without this strip, recipients see "Hi Dr. Dr. Ahmed".
  // Idempotent: stripping a name that has no prefix returns it unchanged.
  const templateData = {
    ...data,
    patientName: data.patientName || user.name || 'Patient',
    doctorName: stripDrPrefix(data.doctorName),
    caseReference: data.caseReference || (order ? String(order.id).slice(0, 12).toUpperCase() : ''),
    specialty: data.specialty || '',
    slaHours: data.slaHours || (order ? order.sla_hours : ''),
    dashboardUrl: data.dashboardUrl || `${process.env.APP_URL || 'https://tashkheesa.com'}/dashboard`,
    caseUrl: data.caseUrl || (order ? `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/doctor/case/${order.id}` : ''),
    reportUrl: data.reportUrl || (order ? `${process.env.APP_URL || 'https://tashkheesa.com'}/portal/case/${order.id}/report` : ''),
    appUrl: process.env.APP_URL || 'https://tashkheesa.com',
  };

  // Subject derivation moved AFTER templateData so subjects can interpolate
  // any template variable (e.g. "Dr. {doctorName} has accepted your case").
  const titles = getNotificationTitles(notification.template, templateData);
  const subject = lang === 'ar' ? titles.title_ar : titles.title_en;

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

  // P1-NOTIF-1: safe-fallback template resolution.
  // First try the whatsappTemplateMap (which has the Meta-approved
  // template name + per-template paramBuilder + lang). If the map
  // has no entry for this internal event name, fall back to the raw
  // event name + user.lang. This handles both scenarios:
  //   (X) Meta has templates approved with the internal event names
  //       → map miss, raw name + user.lang is sent (works as before)
  //   (Y) Meta has the _en-suffixed names from the map
  //       → map hit, mapped templateName + map's lang + paramBuilder
  //         is sent (this is the previously-broken case the map was
  //         written for but never wired up).
  const fallbackLang = user.lang === 'ar' ? 'ar' : 'en_US';
  const mapped = getWhatsAppTemplate(notification.template);
  const wa = mapped
    ? {
        to: user.phone,
        template: mapped.templateName,
        lang: mapped.lang || fallbackLang,
        vars: typeof mapped.paramBuilder === 'function' ? mapped.paramBuilder(vars) : vars
      }
    : {
        to: user.phone,
        template: notification.template,
        lang: fallbackLang,
        vars
      };

  const result = await sendWhatsApp(wa);

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
    notifications = await queryAll(
      `SELECT * FROM notifications
       WHERE status IN ('queued', 'retry')
         AND (retry_after IS NULL OR retry_after <= $1)
       ORDER BY at ASC
       LIMIT $2`,
      [nowIso, limit]
    );
  } catch (err) {
    console.error('[notify-worker] failed to load notifications', err);
    return;
  }

  if (!notifications.length) return;

  for (const n of notifications) {
    try {
      const user = await queryOne(
        'SELECT id, email, name, phone, lang, notify_whatsapp FROM users WHERE id = $1',
        [n.to_user_id]
      );

      const order = n.order_id
        ? await queryOne('SELECT * FROM orders_active WHERE id = $1', [n.order_id])
        : null;

      if (!user) {
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'failed',
          'error: user not found',
          n.id
        ]);
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
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'sent',
          JSON.stringify(result),
          n.id
        ]);
      } else {
        // Handle failure with retry
        const attempts = (n.attempts || 0) + 1;

        if (attempts >= MAX_RETRIES) {
          await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3 WHERE id = $4', [
            'failed',
            JSON.stringify({ error: result.error || 'max_retries_exceeded', attempts }),
            attempts,
            n.id
          ]);
          console.error('[notify-worker] max retries reached', { id: n.id, template: n.template, channel, attempts });
        } else {
          // Exponential backoff: 30s, 120s, 480s
          const backoffMs = 30000 * Math.pow(4, attempts - 1);
          const retryAfter = new Date(Date.now() + backoffMs).toISOString();

          await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3, retry_after = $4 WHERE id = $5', [
            'retry',
            JSON.stringify({ error: result.error || 'send_failed', attempts }),
            attempts,
            retryAfter,
            n.id
          ]);
          console.warn('[notify-worker] will retry', { id: n.id, template: n.template, channel, attempts, retryAfter });
        }
      }
    } catch (err) {
      console.error('[notify-worker] failed to process notification', n.id, err);
      const attempts = (n.attempts || 0) + 1;
      await execute('UPDATE notifications SET status = $1, response = $2, attempts = $3 WHERE id = $4', [
        attempts >= MAX_RETRIES ? 'failed' : 'retry',
        `error: ${String(err).slice(0, 500)}`,
        attempts,
        n.id
      ]);
    }
  }
  pingOps('care-agent', 'Notification worker ran');
}

function pingOps(agentName, task) {
  try {
    var http = require('http');
    var body = JSON.stringify({ agent_name: agentName, status: 'running', current_task: task });
    var req = http.request({ hostname: 'localhost', port: Number(process.env.PORT || 3000), path: '/ops/agent/ping', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    req.on('error', function() {});
    req.write(body);
    req.end();
  } catch(e) {}
}

module.exports = { runNotificationWorker, TEMPLATE_TO_EMAIL };
