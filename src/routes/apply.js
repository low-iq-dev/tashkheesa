'use strict';

// PUBLIC doctor-application form — GET /apply (render) + POST /apply (submit).
//
// PUBLIC by design: mounted at app.use('/', ...) with NO requireRole/requireAuth.
// Applications are NOT doctors — POST writes ONLY to doctor_applications and
// touches `users` not at all (slice-2 Command review promotes an application).
//
// Write follows the split-lifecycle house pattern (mirrors admin_refund.js): the
// ROUTE owns the pg client (db.connect()/release()); the SERVICE owns
// BEGIN/COMMIT/ROLLBACK. The notification email is POST-COMMIT, best-effort, and
// wrapped so it can never throw or roll back the saved application.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { validationResult } = require('express-validator');

const taxonomy = require('../services/specialties_taxonomy');
const { applyValidators, coerceSubSpecialties, buildApplicationRecord } = require('../validators/apply');
const { createApplication } = require('../services/doctor_applications');

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function specialtyLabel(data) {
  if (data.specialty_id === 'other') return data.specialty_other || 'Other';
  return taxonomy.labelFor(data.specialty_id, 'en') || data.specialty_id;
}

// Internal ops notification — English (operator-facing). Applicant email is in
// the body (sendMail has no replyTo). All user values are HTML-escaped.
function buildNotificationEmail(to, data, appRow) {
  const label = specialtyLabel(data);
  const subject = `New doctor application — ${data.full_name || 'Unknown'} (${label})`;
  const rows = [
    ['Application ID', appRow && appRow.id],
    ['Submitted', appRow && appRow.createdAt],
    ['Full name', data.full_name],
    ['Full name (AR)', data.full_name_ar],
    ['Email', data.email],
    ['Phone', data.phone],
    ['Specialty', `${label} (${data.specialty_id})`],
    ['Sub-specialties', (data.sub_specialties || []).join(', ')],
    ['Medical license #', data.medical_license_number],
    ['License country', data.license_country],
    ['Years of experience', data.years_experience],
    ['Current affiliation', data.current_affiliation],
    ['CV URL', data.cv_url],
    ['Bio', data.bio],
    ['Bio (AR)', data.bio_ar],
    ['Submitter IP', data.submitter_ip],
    ['User agent', data.user_agent],
  ].filter(([, v]) => v != null && v !== '');

  const text = 'New doctor application received.\n\n'
    + rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    + '\n\nReview in Command → Applications (slice 2).';

  const htmlRows = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0f172a;">${escapeHtml(v)}</td></tr>`)
    .join('');
  const html = '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;max-width:640px;margin:0 auto;padding:24px;">'
    + '<h2 style="margin:0 0 4px;">New doctor application</h2>'
    + '<p style="color:#64748b;margin:0 0 16px;">Submitted via the public /apply form.</p>'
    + `<table style="border-collapse:collapse;font-size:14px;">${htmlRows}</table>`
    + '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px;">'
    + `<p style="color:#94a3b8;font-size:12px;">Applications are not doctors — review &amp; promote in Command → Applications (slice 2). Reply to the applicant at <a href="mailto:${escapeHtml(data.email || '')}">${escapeHtml(data.email || '')}</a>.</p>`
    + '</body></html>';

  return { to, subject, text, html };
}

module.exports = function (deps) {
  deps = deps || {};
  const db = deps.pool || deps.db;
  const sendMail = deps.sendMail || require('../services/emailService').sendMail;
  const router = express.Router();

  // Per-IP throttle on the POST only (GET render is unthrottled). trust proxy=1
  // is set globally, so this keys on the real client IP behind Render's proxy.
  const applyPostLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many applications from this network. Please wait 15 minutes and try again.',
  });

  function render(req, res, status, extra) {
    const lang = (res.locals && res.locals.lang) || 'en';
    const title = lang === 'ar' ? 'قدّم للانضمام لتشخيصة' : 'Apply to Tashkheesa';
    return res.status(status).render('apply', Object.assign({
      title: title,
      lang: lang,
      isAr: lang === 'ar',
      specialties: taxonomy.getSpecialties(),
      errors: {},
      old: {},
      submitted: false,
    }, extra || {}));
  }

  router.get('/apply', function (req, res) {
    return render(req, res, 200, { submitted: String((req.query && req.query.submitted) || '') === '1' });
  });

  router.post('/apply', applyPostLimiter, coerceSubSpecialties, applyValidators, async function (req, res) {
    // Honeypot — a genuine user never fills `website`. Show success but insert
    // nothing and send nothing (never signal the bot).
    if (req.body && String(req.body.website || '').trim() !== '') {
      return res.redirect(303, '/apply?submitted=1');
    }

    const errors = validationResult(req).mapped();
    if (Object.keys(errors).length > 0) {
      return render(req, res, 400, { errors: errors, old: req.body || {} });
    }

    const data = buildApplicationRecord(req);

    let client;
    let appRow;
    try {
      client = await db.connect();
      appRow = await createApplication(client, data);
    } catch (err) {
      console.error('[apply] insert failed:', err && err.message);
      return render(req, res, 500, { errors: { _global: { msg: 'server_error' } }, old: req.body || {} });
    } finally {
      if (client && client.release) client.release();
    }

    // POST-COMMIT, best-effort. A mailer failure must NEVER throw and NEVER
    // affect the already-committed application row.
    try {
      const to = process.env.APPLICATIONS_NOTIFY_EMAIL || 'info@tashkheesa.com';
      await sendMail(buildNotificationEmail(to, data, appRow));
    } catch (mailErr) {
      console.error('[apply] notification email failed (application already saved):', mailErr && mailErr.message);
    }

    return res.redirect(303, '/apply?submitted=1');
  });

  return router;
};

// Exported for unit inspection (not used by the mount).
module.exports.buildNotificationEmail = buildNotificationEmail;
