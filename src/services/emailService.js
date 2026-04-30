// src/services/emailService.js
// Production email service using Resend + Handlebars templates.
//
// Transport: Resend HTTP API via the official `resend` SDK. The SDK is wrapped
// in a thin nodemailer-shaped adapter so that:
//   - recipientGuard (`wrapWithGuard` / `_guardedSendMail`) keeps the same
//     contract it had under nodemailer — it sees an object with `sendMail`
//     and `verify` and a `{messageId, accepted, rejected}` response.
//   - Every public surface (`sendEmail`, `sendRawEmail`, `sendMail`,
//     `notify*`) and every caller of those keeps its existing signature and
//     return shape.
//   - Tests that inject a fake transporter via `_setTestTransporter` keep
//     working — they bypass the adapter entirely.
//
// Migration note: this replaced a Gmail SMTP / nodemailer transport on
// 2026-04-30 to land before the launch traffic ramp. Gmail's 500-emails/day
// cap and SPF/DKIM/DMARC posture were unsuitable for transactional patient
// email at scale.

const { Resend } = require('resend');
const path = require('path');
const fs = require('fs');
const Handlebars = require('handlebars');
const { verbose, fatal } = require('../logger');
const { maskEmail } = require('../utils/mask');
var recipientGuard = require('./recipientGuard');
// Pool is read at send-time (not require-time) so tests can swap it in.
var _poolOverride = null;
function _resolvePool() {
  if (_poolOverride) return _poolOverride;
  try {
    return require('../db').pool;
  } catch (_e) {
    return null;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Env-var names retained from the SMTP era for continuity — they describe the
// from-address, not the transport. Renaming would also touch static-pages.js
// (which reads SMTP_FROM_EMAIL as a contact-form recipient default), so the
// names stay; only the transport changed.
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || 'noreply@tashkheesa.com';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Tashkheesa';
const APP_URL = process.env.APP_URL || 'https://tashkheesa.com';

// ── Transporter (lazy init) ─────────────────────────────────────────────────
// _transporter holds a guard-wrapped facade; tests can replace it via
// _setTestTransporter to inject a stub without touching the Resend SDK.
let _transporter = null;

// Translate Resend's `{data, error}` envelope into the nodemailer-shaped
// response that recipientGuard and the public sendEmail/sendRawEmail/sendMail
// callers expect. On Resend error, throws so the existing try/catch paths in
// the public functions log and return `{ok:false, error: ...}`.
function _resendAdapter(client) {
  return {
    sendMail: async function (opts) {
      var to = opts && opts.to;
      var toList;
      if (Array.isArray(to)) {
        toList = to.map(function (v) { return String(v).trim(); }).filter(Boolean);
      } else if (typeof to === 'string' && to.indexOf(',') !== -1) {
        toList = to.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      } else if (to != null && to !== '') {
        toList = [String(to)];
      } else {
        var errNo = new Error('No recipients defined');
        errNo.code = 'EENVELOPE';
        throw errNo;
      }

      var payload = {
        from: opts.from,
        to: toList,
        subject: opts.subject,
      };
      if (opts.html != null) payload.html = opts.html;
      if (opts.text != null) payload.text = opts.text;
      if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
        payload.attachments = opts.attachments;
      }

      var result = await client.emails.send(payload);
      if (result && result.error) {
        var e = new Error(result.error.message || 'resend_send_failed');
        e.name = result.error.name || 'ResendError';
        throw e;
      }
      return {
        messageId: result && result.data && result.data.id,
        accepted: toList.slice(),
        rejected: [],
        response: 'resend:' + (result && result.data && result.data.id),
      };
    },
    verify: function () {
      // Resend has no SMTP-style handshake. Returning true preserves the
      // health-check contract: the boot-time RESEND_API_KEY presence check
      // is the real config gate (see getTransporter below).
      return Promise.resolve(true);
    }
  };
}

function getTransporter() {
  if (_transporter) return _transporter;

  if (!RESEND_API_KEY) {
    fatal('[email] Resend not configured — RESEND_API_KEY required');
    return null;
  }

  // ⚠️ REQUIRES ENV VAR: RESEND_API_KEY — set in Render dashboard before this will work
  var client = new Resend(RESEND_API_KEY);
  var adapter = _resendAdapter(client);

  verbose('[email] Resend transport created');
  _transporter = wrapWithGuard(adapter);
  return _transporter;
}

// ── Recipient guard wiring ──────────────────────────────────────────────────
// Every transporter.sendMail() call routes through validateRecipient. Blocked
// addresses are removed from the recipient list and logged to
// blocked_send_attempts; if some recipients remain the send proceeds for them
// (batch-safe). If all recipients are blocked, the wrapped sendMail returns
// { blocked: true, ... } without throwing — the three callers in this file
// detect that shape and translate to { ok: false, blocked: true } for the
// public API.

function _parseRecipients(to) {
  if (to == null || to === '') return [];
  if (Array.isArray(to)) {
    return to.map(function(v) { return String(v).trim(); }).filter(Boolean);
  }
  return String(to).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function wrapWithGuard(rawTransporter) {
  return {
    sendMail: function(opts) { return _guardedSendMail(rawTransporter, opts); },
    verify: function() {
      if (typeof rawTransporter.verify === 'function') return rawTransporter.verify();
      return Promise.resolve(true);
    }
  };
}

async function _guardedSendMail(rawTransporter, opts) {
  var subject = opts && opts.subject;
  var rcpts = _parseRecipients(opts && opts.to);
  if (rcpts.length === 0) {
    // No recipient — let the underlying transporter raise its own error so
    // existing callers' try/catch path is preserved.
    return rawTransporter.sendMail(opts);
  }
  var allowed = [];
  var blocked = [];
  for (var i = 0; i < rcpts.length; i++) {
    var addr = rcpts[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await recipientGuard.validateRecipient(addr);
      allowed.push(addr);
    } catch (err) {
      if (err && err.name === 'BlockedRecipientError') {
        blocked.push({ email: addr, reason: err.reason });
      } else {
        // Fail-closed: if validation throws something unexpected, treat as
        // blocked rather than letting an untrusted address through.
        fatal('[email] recipient validation failed unexpectedly', {
          error: err && err.message,
          email: maskEmail(addr)
        });
        blocked.push({ email: addr, reason: 'validation_error' });
      }
    }
  }
  if (blocked.length > 0) {
    var caller = recipientGuard.detectCaller();
    var pool = _resolvePool();
    for (var j = 0; j < blocked.length; j++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await recipientGuard.recordBlockedAttempt(pool, {
          email: blocked[j].email,
          reason: blocked[j].reason,
          subject: subject,
          caller: caller
        });
      } catch (_e) { /* recordBlockedAttempt swallows internally */ }
      console.warn('[email] recipient blocked', {
        email: maskEmail(blocked[j].email),
        reason: blocked[j].reason,
        subject: subject,
        caller: caller
      });
    }
  }
  if (allowed.length === 0) {
    return {
      blocked: true,
      blockedCount: blocked.length,
      reason: blocked[0] ? blocked[0].reason : 'all_recipients_blocked'
    };
  }
  // Some recipients survived. Forward to the underlying transporter with the
  // filtered recipient list. Single recipient as a string preserves the
  // existing wire shape; multiple as an array is nodemailer-native.
  var newOpts = Object.assign({}, opts, {
    to: allowed.length === 1 ? allowed[0] : allowed
  });
  var result = await rawTransporter.sendMail(newOpts);
  // Annotate so callers can tell some recipients were dropped.
  if (blocked.length > 0 && result && typeof result === 'object') {
    result.partialBlocked = blocked.length;
  }
  return result;
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
 * @param {Array}  [options.attachments=[]] - Attachments — `{filename, content}` shape (Resend-compatible).
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
    return { ok: false, error: 'email_not_configured' };
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

    if (result && result.blocked) {
      return { ok: false, blocked: true, reason: result.reason, blockedCount: result.blockedCount };
    }
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
    return { ok: false, error: 'email_not_configured' };
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
    if (result && result.blocked) {
      return { ok: false, blocked: true, reason: result.reason, blockedCount: result.blockedCount };
    }
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    fatal('[email] raw send failed', { to, subject, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Verify the email transport is reachable (health check).
 *
 * Resend has no SMTP-style handshake, so the adapter's verify() always
 * resolves to true once RESEND_API_KEY is present. The boot-time API-key
 * presence check inside getTransporter() is the actual config gate; the
 * first real send surfaces auth errors via the standard error path.
 */
async function verifyConnection() {
  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'email_not_configured' };

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
// These wrap a low-level sendMail() that is gated ONLY on RESEND_API_KEY —
// the existing sendEmail() / sendRawEmail() above keep their EMAIL_ENABLED
// gate. Failures NEVER throw; they log and return so callers can wrap in
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
 * returns { stub: true }) when RESEND_API_KEY is not set so this is safe to
 * deploy before the API key lands in Render.
 *
 * Behavioral note: deliberately does NOT consult EMAIL_ENABLED — that flag
 * gates the templated sendEmail() path (which has 6 existing call sites).
 * The lifecycle notifications are unconditional once Resend creds are present.
 */
async function sendMail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) {
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
    if (result && result.blocked) {
      return { ok: false, blocked: true, reason: result.reason, blockedCount: result.blockedCount };
    }
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    console.error('[MAILER] send failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyCaseReceived(patient, referenceId, slaHours) {
  const greet = (patient && patient.name) ? ('Hello ' + patient.name + ',') : 'Hello,';
  const subject = 'Your case ' + referenceId + ' has been received';
  const timeframe = slaHours ? ('within ' + slaHours + ' hours') : 'within 72 hours';
  const lead = 'Your case ' + referenceId + ' has been received. Our specialist team will review your files and deliver your report ' + timeframe + '.';
  const urgencyNote = slaHours && slaHours <= 4
    ? ' Your case is marked URGENT and will be prioritised immediately.'
    : slaHours && slaHours <= 24
    ? ' Your case is marked Fast Track and will be reviewed within 24 hours.'
    : '';
  const fullLead = lead + urgencyNote;
  return sendMail({
    to: patient && patient.email,
    subject: subject,
    text: greet + '\n\n' + fullLead + '\n\nThank you,\nTashkheesa',
    html: htmlWrap('<p>' + escapeHtml(greet) + '</p><p>' + escapeHtml(fullLead) + '</p><p>Thank you,<br>Tashkheesa</p>'),
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

// Test-only seams. Allow tests to swap in a stub transporter and a stub
// pg pool without touching the Resend SDK or hitting a real DB. The stub
// must expose a nodemailer-shaped sendMail({from,to,subject,html,text,attachments})
// returning {messageId, accepted, rejected}; wrapWithGuard handles the rest.
function _setTestTransporter(t) { _transporter = t ? wrapWithGuard(t) : null; }
function _setTestPool(p) { _poolOverride = p; }
function _resetTransporter() { _transporter = null; }

module.exports = {
  sendEmail,
  sendRawEmail,
  renderEmail,
  verifyConnection,
  clearTemplateCache,
  EMAIL_ENABLED,
  // Phase 4 lifecycle notifications (gated only on RESEND_API_KEY)
  sendMail,
  notifyCaseReceived,
  notifyCaseAssigned,
  notifyMoreInfoRequested,
  notifyCaseReassigned,
  notifyCaseCancelled,
  notifyDoctorFileUploaded,
  // Internals exposed for tests only.
  _setTestTransporter: _setTestTransporter,
  _setTestPool: _setTestPool,
  _resetTransporter: _resetTransporter,
};
