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

module.exports = {
  sendEmail,
  sendRawEmail,
  renderEmail,
  verifyConnection,
  clearTemplateCache,
  EMAIL_ENABLED,
};
