// src/services/emailService.js
// Production email service using Nodemailer + Handlebars templates

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const Handlebars = require('handlebars');
const { verbose, fatal } = require('../logger');
const { maskEmail } = require('../utils/mask');

// ── Config ──────────────────────────────────────────────────────────────────
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@tashkheesa.com';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Tashkheesa';
const APP_URL = process.env.APP_URL || 'https://tashkheesa.com';

// ── Transporter (lazy init with connection pooling) ─────────────────────────
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    fatal('[email] SMTP not configured — SMTP_HOST, SMTP_USER, SMTP_PASS required');
    return null;
  }

  // ⚠️ REQUIRES ENV VAR: SMTP_PASS — set in Render dashboard before this will work
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });

  verbose('[email] SMTP transporter created', { host: SMTP_HOST, port: SMTP_PORT });
  return _transporter;
}

// ── Template Engine ─────────────────────────────────────────────────────────
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'email');
const templateCache = new Map();

// Register Handlebars helpers
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('year', () => new Date().getFullYear());

/**
 * Load and compile a Handlebars template (cached).
 * @param {string} templateName - e.g. 'case-submitted'
 * @param {string} lang - 'en' or 'ar'
 * @returns {Function|null} Compiled Handlebars template
 */
function loadTemplate(templateName, lang = 'en') {
  const cacheKey = `${lang}:${templateName}`;

  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }

  const langDir = path.join(TEMPLATES_DIR, lang);
  const enDir = path.join(TEMPLATES_DIR, 'en');
  let filePath = path.join(langDir, `${templateName}.hbs`);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(enDir, `${templateName}.hbs`);
  }

  if (!fs.existsSync(filePath)) {
    console.warn(`[email] Template not found: ${templateName} (lang: ${lang})`);
    return null;
  }

  try {
    const source = fs.readFileSync(filePath, 'utf-8');
    const compiled = Handlebars.compile(source);
    templateCache.set(cacheKey, compiled);
    return compiled;
  } catch (err) {
    fatal('[email] Failed to compile template', { templateName, lang, error: err.message });
    return null;
  }
}

/**
 * Render an email template with the base layout.
 */
function renderEmail(templateName, lang = 'en', data = {}) {
  const contentTemplate = loadTemplate(templateName, lang);
  if (!contentTemplate) return null;

  const layoutTemplate = loadTemplate('_layout', lang);

  const vars = {
    ...data,
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    appUrl: APP_URL,
    year: new Date().getFullYear(),
    appName: 'Tashkheesa',
  };

  const bodyHtml = contentTemplate(vars);

  if (layoutTemplate) {
    return layoutTemplate({ ...vars, body: new Handlebars.SafeString(bodyHtml) });
  }

  return bodyHtml;
}

// ── Send Email ──────────────────────────────────────────────────────────────

/**
 * Send a templated email.
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Subject line
 * @param {string} options.template - Template name
 * @param {string} [options.lang='en'] - Language
 * @param {Object} [options.data={}] - Template variables
 * @param {Array}  [options.attachments=[]] - Nodemailer attachments
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendEmail({ to, subject, template, lang = 'en', data = {}, attachments = [] }) {
  if (!EMAIL_ENABLED) {
    verbose('[email] disabled — skipping', { to: maskEmail(to), template });
    return { ok: false, skipped: true, reason: 'email_disabled' };
  }

  if (!to || !subject) {
    console.warn('[email] missing to or subject', { to, subject, template });
    return { ok: false, error: 'missing_to_or_subject' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'smtp_not_configured' };
  }

  let html = null;
  if (template) {
    html = renderEmail(template, lang, data);
    if (!html) {
      console.warn('[email] template render failed, sending plain text fallback', { template, lang });
    }
  }

  const plainText = data.plainText || `Notification from Tashkheesa: ${subject}`;

  try {
    const result = await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to,
      subject,
      html: html || undefined,
      text: plainText,
      attachments,
    });

    verbose('[email] sent', { to: maskEmail(to), subject, messageId: result.messageId });
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    fatal('[email] send failed', { to: maskEmail(to), subject, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Send a raw email without template rendering.
 */
async function sendRawEmail({ to, subject, html, text, attachments = [] }) {
  if (!EMAIL_ENABLED) {
    return { ok: false, skipped: true, reason: 'email_disabled' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'smtp_not_configured' };
  }

  try {
    const result = await transporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to,
      subject,
      html,
      text,
      attachments,
    });
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    fatal('[email] raw send failed', { to, subject, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Verify SMTP connection (health check).
 */
async function verifyConnection() {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'smtp_not_configured' };

  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Clear template cache (dev hot-reload).
 */
function clearTemplateCache() {
  templateCache.clear();
  verbose('[email] template cache cleared');
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: lifecycle email notifications
// ─────────────────────────────────────────────────────────────────────────────
// These wrap a low-level sendMail() that is gated ONLY on SMTP_PASS — the
// existing sendEmail() / sendRawEmail() above keep their EMAIL_ENABLED gate.
// Failures NEVER throw; they log and return so callers can wrap in
// try/catch without risking lost data or rolled-back DB transactions.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlWrap(bodyHtml) {
  return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a202c;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">'
    + bodyHtml
    + '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px;">'
    + '<p style="color:#718096;font-size:12px;">Tashkheesa medical platform</p>'
    + '</body></html>';
}

/**
 * Low-level mailer used by the lifecycle notifications below. Stubs (logs +
 * returns { stub: true }) when SMTP_PASS is not set so this is safe to deploy
 * before SMTP credentials land in Render.
 *
 * Behavioral note: deliberately does NOT consult EMAIL_ENABLED — that flag
 * gates the templated sendEmail() path (which has 6 existing call sites).
 * The lifecycle notifications are unconditional once SMTP creds are present.
 */
async function sendMail({ to, subject, text, html }) {
  if (!SMTP_PASS) {
    console.warn('[MAILER STUB] Not configured. Would send to ' + to + ': "' + subject + '"');
    return { stub: true };
  }
  if (!to) {
    console.warn('[MAILER] Missing recipient for "' + subject + '"');
    return { ok: false, error: 'no_recipient' };
  }
  const transporter = getTransporter();
  if (!transporter) {
    console.error('[MAILER] Transporter unavailable for "' + subject + '"');
    return { ok: false, error: 'transporter_unavailable' };
  }
  try {
    const result = await transporter.sendMail({
      from: '"' + SMTP_FROM_NAME + '" <' + SMTP_FROM_EMAIL + '>',
      to: to,
      subject: subject,
      text: text,
      html: html,
    });
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    console.error('[MAILER] send failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyCaseReceived(patient, referenceId) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const subject = 'Your case ' + referenceId + ' has been received';
  const lead = 'Your case ' + referenceId + ' has been received. Our specialist team will review your files and deliver your report within 72 hours.';
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + lead + '\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(lead) + '</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

async function notifyCaseAssigned(patient, referenceId, doctorName, slaHours) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const who = doctorName || 'a specialist';
  const subject = 'Your case ' + referenceId + ' has been assigned';
  const timeframe = slaHours ? ('within ' + slaHours + ' hours') : 'within the agreed timeframe';
  const lead = 'Your case ' + referenceId + ' has been assigned to ' + who + '. You will receive your report ' + timeframe + '.';
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + lead + '\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(lead) + '</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

async function notifyMoreInfoRequested(patient, referenceId, message) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const msg = String(message || '').trim();
  const subject = 'Additional information needed for case ' + referenceId;
  const lead = 'Additional information is needed for your case ' + referenceId + '.';
  const detailText = msg ? ('\n\nDoctor\'s note:\n' + msg) : '';
  const detailHtml = msg ? ('<p><strong>Doctor\'s note:</strong><br>' + escapeHtml(msg) + '</p>') : '';
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + lead + detailText + '\n\nPlease log in to upload the requested files.\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(lead) + '</p>' + detailHtml + '<p>Please log in to upload the requested files.</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

async function notifyCaseReassigned(patient, referenceId) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const subject = 'Your case ' + referenceId + ' has been reassigned';
  const lead = 'Your case ' + referenceId + ' has been reassigned to a new specialist. Your report timeline remains unchanged.';
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + lead + '\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(lead) + '</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

async function notifyCaseCancelled(patient, referenceId, reason) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const r = String(reason || '').trim();
  const subject = 'Your case ' + referenceId + ' has been cancelled';
  const lead = 'Your case ' + referenceId + ' has been cancelled.';
  const detailText = r ? ('\n\nReason:\n' + r) : '';
  const detailHtml = r ? ('<p><strong>Reason:</strong><br>' + escapeHtml(r) + '</p>') : '';
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + lead + detailText + '\n\nIf you have questions, please contact support.\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(lead) + '</p>' + detailHtml + '<p>If you have questions, please contact support.</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

async function notifyDoctorFileUploaded(doctorEmail, referenceId, patientName) {
  const subject = 'New files uploaded for case ' + referenceId;
  const who = patientName ? ('by ' + patientName) : '';
  const lead = ('New files have been uploaded for case ' + referenceId + ' ' + who + '. Please review.').replace(/\s+/g, ' ').trim();
  return sendMail({
    to: doctorEmail,
    subject: subject,
    text: 'Hello Doctor,\n\n' + lead + '\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>Hello Doctor,</p><p>' + escapeHtml(lead) + '</p><p>Thank you,<br>Tashkheesa</p>'),
  });
}

module.exports = {
  sendEmail,
  sendRawEmail,
  renderEmail,
  verifyConnection,
  clearTemplateCache,
  EMAIL_ENABLED,
  // Phase 4 lifecycle notifications (gated only on SMTP_PASS)
  sendMail,
  notifyCaseReceived,
  notifyCaseAssigned,
  notifyMoreInfoRequested,
  notifyCaseReassigned,
  notifyCaseCancelled,
  notifyDoctorFileUploaded,
};
