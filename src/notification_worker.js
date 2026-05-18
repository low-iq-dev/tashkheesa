// src/notification_worker.js
// Production notification worker: processes queued notifications via email and WhatsApp

const { queryAll, queryOne, execute } = require('./pg');
const { logErrorToDb } = require('./logger');
const { sendEmail, renderEmail, EMAIL_ENABLED } = require('./services/emailService');
const { sendWhatsApp } = require('./notify/whatsapp');
const { getNotificationTitles } = require('./notify/notification_titles');
const { getWhatsAppTemplate } = require('./notify/whatsappTemplateMap');
const { emitNotificationDropped } = require('./notify');

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
  // Theme 7b Phase 2 — patient confirmation email when a refund
  // request is submitted. Admin templates (admin_refund_request_received,
  // admin_refund_cancelled_by_patient) are intentionally NOT mapped:
  // admins use the in-app /superadmin queue, not email, for refund triage.
  patient_refund_requested: 'patient-refund-requested',
  // Theme 7b Phase 3 — superadmin actions on patient refund requests.
  // All three are patient-facing email + in-app.
  patient_refund_approved:  'patient-refund-approved',
  patient_refund_denied:    'patient-refund-denied',
  patient_refund_paid:      'patient-refund-paid',
  // Side issue #44 — operator-initiated refund: patient notification.
  patient_refund_opened_by_operator: 'patient-refund-opened-by-operator',
  appointment_cancelled: 'appointment-cancelled',
  // WhatsApp-via-OpenClaw rollout: queue-ified case cancellation
  // (previously sent inline from superadmin.js:2785). Adds WhatsApp
  // delivery alongside the existing email.
  case_cancelled_patient: 'case-cancelled',
  // Add-on purchase confirmations (email parity with the new WhatsApp
  // bodies in openclawTemplates.js).
  addon_purchased_video:        'addon-video-purchased',
  addon_purchased_urgency:      'addon-urgency-purchased',
  addon_purchased_prescription: 'addon-prescription-purchased',
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
  let rawVars = {};
  try {
    if (notification.response) {
      rawVars = typeof notification.response === 'string'
        ? JSON.parse(notification.response)
        : notification.response;
    }
  } catch (e) {
    rawVars = {};
  }

  // Enrich vars with the same canonical fields the email path computes
  // (notification_worker.processEmail at ~line 114). The OpenClaw body
  // composer reads doctorName/caseReference/link/etc; the Meta path's
  // paramBuilder also tolerates these fields as fallbacks.
  const appUrl = process.env.APP_URL || 'https://tashkheesa.com';
  const vars = {
    ...rawVars,
    patientName:  rawVars.patientName  || user.name || 'Patient',
    doctorName:   stripDrPrefix(rawVars.doctorName),
    caseReference: rawVars.caseReference || (order ? String(order.id).slice(0, 12).toUpperCase() : ''),
    slaHours:     rawVars.slaHours || (order ? order.sla_hours : ''),
    appUrl,
    // Patient-facing portal URL for the OpenClaw body's call-to-action.
    // Email templates use a generic dashboardUrl; for WhatsApp we deep-link
    // to the patient's order page so taps land on the relevant case.
    link:         rawVars.link || (order ? `${appUrl}/portal/patient/orders/${order.id}` : appUrl)
  };

  if (DRY_RUN) {
    console.log('[notify-worker][DRY_RUN] Would send WhatsApp', { to: user.phone, template: notification.template });
    return { ok: true, dryRun: true };
  }

  // Transport-agnostic dispatch: sendWhatsApp branches on
  // NOTIFICATIONS_WHATSAPP_TRANSPORT internally. We pass the raw
  // internal event name + enriched vars + orderId/userId; the OpenClaw
  // branch composes a free-form body, the Meta branch looks up the
  // HSM template via whatsappTemplateMap.
  //
  // For the Meta branch's paramBuilder contract we still need to honor
  // the historical shape — but enrichment above doesn't break it
  // (paramBuilders read `data.caseReference || data.case_id`, etc).
  const fallbackLang = user.lang === 'ar' ? 'ar' : 'en_US';
  const mapped = getWhatsAppTemplate(notification.template);
  const wa = mapped
    ? {
        to: user.phone,
        template: mapped.templateName,
        lang: mapped.lang || fallbackLang,
        vars: typeof mapped.paramBuilder === 'function' ? mapped.paramBuilder(vars) : vars,
        orderId: notification.order_id || (order && order.id) || null,
        userId: user.id
      }
    : {
        to: user.phone,
        template: notification.template,
        lang: fallbackLang,
        vars,
        orderId: notification.order_id || (order && order.id) || null,
        userId: user.id
      };

  // OpenClaw transport keys on the internal event name, not the Meta
  // template name. When the map has rewritten `template` for Meta, the
  // OpenClaw branch in sendWhatsApp won't find a body. Pass the
  // original internal name as `template` when transport is OpenClaw.
  if (String(process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT || 'meta').toLowerCase() === 'openclaw') {
    wa.template = notification.template;
    wa.lang = user.lang === 'ar' ? 'ar' : 'en';
  }

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
    // Theme 8 Phase 4-D — `FOR UPDATE SKIP LOCKED` (OQ-5 deferred from
    // Theme 6 sub-issue D commit `3d6f05f`). Single-instance Render
    // deploy: no-op (no contention possible). Activates if a second
    // instance is ever spun up (scale-out test, accidental dual deploy,
    // manual one-off worker). Pairs with Theme 6 sub-issue A's
    // SLA_MODE=primary gating — SKIP LOCKED is defense-in-depth if the
    // primary-only gate ever fails. ORDER BY at ASC stays for FIFO.
    notifications = await queryAll(
      `SELECT * FROM notifications
       WHERE status IN ('queued', 'retry')
         AND (retry_after IS NULL OR retry_after <= $1)
       ORDER BY at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [nowIso, limit]
    );
  } catch (err) {
    logErrorToDb(err, {
      context: 'notification_worker.fetch_queued',
      category: 'notification_worker',
      workerPhase: 'interval'
    });
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

      if (result.ok) {
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'sent',
          JSON.stringify(result),
          n.id
        ]);
      } else if (result.skipped) {
        // Theme 8 Phase 4-C — split skipped from sent. Pre-fix the
        // ops-dashboard "Notifications: sent" pill counted user-preference
        // skips (opted out, no phone, no email) as successful delivery —
        // misleading every time someone read it. notifications.status is
        // plain TEXT (migrations/001_initial_tables.sql:line "status TEXT"
        // with no CHECK constraint), so adding 'skipped' is purely additive.
        // Downstream readers (superadmin.js, admin.js) only match against
        // 'sent' / 'failed' / 'pending' / 'queued' / 'retry' — none use
        // NOT IN, so 'skipped' rows are simply excluded from those counts.
        await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', [
          'skipped',
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
          // Side issue #46 (Theme 8 Phase 3 follow-up) — emit a
          // NOTIFICATION_DROPPED case_event so /ops/silent-failures
          // surfaces max-retries-exhausted outcomes alongside the
          // enqueue-side drops (invalid_to_user_id, no_phone,
          // db_insert_failed, etc. — see notify.js:271,388,591,618).
          // Without this, the only signal lives in error_logs, which
          // /ops/silent-failures doesn't read. Fire-and-forget; helper
          // has its own try/catch isolation.
          emitNotificationDropped({
            orderId: n.order_id,
            reason: 'max_retries_exceeded',
            channel,
            template: n.template,
            toUserId: n.to_user_id
          });
          // Theme 8 Phase 4-B — surface max-retries to /ops/errors.
          // No Error was thrown at this point (the dispatcher returned
          // { ok:false, error:'<string>' }), so synthesize one. Without
          // this wrap, rate-limit / template-rejection patterns across
          // hundreds of notifications would be invisible — only the
          // per-row notifications.status='failed' would surface, and only
          // to operators who query that table directly.
          logErrorToDb(new Error(result.error || 'max_retries_exceeded'), {
            context: 'notification_worker.max_retries_reached',
            category: 'notification_worker',
            candidateId: n.id,
            template: n.template,
            channel,
            attempts,
            workerPhase: 'per_candidate'
          });
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
          // THEME8-LINT-EXEMPT-HELPER: retry-pending info log, not an error.
          // The notification will be re-dispatched on the next worker tick;
          // surfacing each retry attempt to /ops/errors would be noisy
          // (3 attempts × MAX_RETRIES × notification volume).
          console.warn('[notify-worker] will retry', { id: n.id, template: n.template, channel, attempts, retryAfter });
        }
      }
    } catch (err) {
      logErrorToDb(err, {
        context: 'notification_worker.dispatch',
        category: 'notification_worker',
        candidateId: n.id,
        template: n.template,
        workerPhase: 'per_candidate'
      });
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
  pingOps('notification_worker', 'Notification worker ran');
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
