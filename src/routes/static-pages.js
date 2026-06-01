// src/routes/static-pages.js
// Public static pages, contact form, pre-launch interest, and .html redirects.

var express = require('express');
var { body, validationResult } = require('express-validator');
var crypto = require('crypto');
var { v4: uuidv4 } = require('uuid');
var router = express.Router();

var comingSoonNotify = require('../notify/coming_soon');

function setupStaticPages(opts) {
  var execute = opts.execute;
  var safeAll = opts.safeAll;

  // EN strings are the canonical fields. *_ar fields are the Egyptian-Arabic
  // counterparts consumed by about.ejs / contact.ejs via canonical tt() with
  // biz.<field>_ar as the AR fallback. See Theme 10 Phase 2C / OQ-1 follow-up.
  var BUSINESS_INFO = {
    email: 'info@tashkheesa.com',
    phone: '+20 110 200 9886',
    address: 'Cairo, Egypt',
    address_ar: 'القاهرة، مصر',
    businessHours: 'Sunday – Thursday: 9:00 AM – 5:00 PM (Cairo Time)',
    businessHours_ar: 'الأحد – الخميس: 9:00 صباحاً – 5:00 مساءً (بتوقيت القاهرة)',
    instagram: 'https://instagram.com/tashkheesa',
  };

  var SERVICE_DESCRIPTIONS = {
    'X-Ray Review': 'A board-certified radiologist reviews your X-ray images and provides a detailed written report with findings and recommendations.',
    'MRI Review': 'Expert analysis of your MRI scan by a specialist radiologist, with a comprehensive written report covering all findings.',
    'CT Scan Review': 'Detailed review of your CT scan images by a specialist, including a written report with diagnosis and recommendations.',
    'Ultrasound Review': 'Professional review of your ultrasound images by an experienced specialist with a written findings report.',
    'Brain MRI Review': 'Neuroimaging specialist reviews your brain MRI and provides detailed findings, differential diagnosis, and recommendations.',
    'Echocardiogram Review': 'A cardiologist reviews your echocardiogram and provides a detailed assessment of cardiac structure and function.',
    'ECG Review': 'Expert interpretation of your 12-lead ECG by a cardiologist, including rhythm analysis and clinical recommendations.',
    'Blood Work Review': 'Comprehensive analysis of your blood test results by an internal medicine specialist with clinical interpretation.',
    'Chest X-Ray Review': 'Specialist radiologist reviews your chest X-ray and provides a written report covering all thoracic findings.',
    'Mammogram Review': 'Expert breast imaging review by a radiologist, including BI-RADS classification and follow-up recommendations.',
    'Biopsy / Histopathology Review': 'A pathologist reviews your biopsy slides and provides a detailed histopathological assessment.',
    'Oncology Case Review': 'Comprehensive cancer case review by an oncologist, including staging assessment and treatment recommendations.',
    'PET Scan Review': 'Nuclear medicine specialist reviews your PET-CT scan with detailed metabolic activity assessment.',
    'Cardiac Catheterization Review': 'Interventional cardiologist reviews your catheterization findings and provides treatment recommendations.',
    'Holter Monitor Review': 'Cardiologist reviews your Holter monitor recording and provides rhythm analysis over the monitoring period.',
    'General Second Opinion': 'A specialist in the relevant field reviews your medical records and provides an independent second opinion.',
  };

  function getServiceDescription(name) {
    if (SERVICE_DESCRIPTIONS[name]) return SERVICE_DESCRIPTIONS[name];
    return 'Expert specialist review with a detailed written report covering findings and clinical recommendations.';
  }

  // In-memory services cache (5-min TTL)
  var _servicesCache = { services: null, specialtyNames: null, specialtyNameArMap: null, ts: 0 };
  var SERVICES_CACHE_TTL_MS = 5 * 60 * 1000;

  router.get('/services', async function(req, res) {
    var now = Date.now();
    if (!_servicesCache.services || (now - _servicesCache.ts) >= SERVICES_CACHE_TTL_MS) {
      var services = await safeAll('\n      SELECT DISTINCT ON (sv.id) sv.*, sp.name as specialty_name, sp.name_ar as specialty_name_ar\n      FROM services sv\n      JOIN specialties sp ON sv.specialty_id = sp.id AND COALESCE(sp.is_visible, true) = true\n      WHERE COALESCE(sv.is_visible, true) = true\n        AND sv.base_price IS NOT NULL\n        AND sv.base_price > 0\n      ORDER BY sv.id, sp.name, sv.base_price ASC\n    ', [], []);
      services.forEach(function(s) { s.description = getServiceDescription(s.name); });
      var specialtyNames = [];
      var specialtyNameArMap = {};
      var seen = {};
      services.forEach(function(s) {
        if (s.specialty_name && !seen[s.specialty_name]) {
          seen[s.specialty_name] = true;
          specialtyNames.push(s.specialty_name);
          if (s.specialty_name_ar) specialtyNameArMap[s.specialty_name] = s.specialty_name_ar;
        }
      });
      specialtyNames.sort();
      _servicesCache = { services: services, specialtyNames: specialtyNames, specialtyNameArMap: specialtyNameArMap, ts: now };
    }
    res.render('services', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', services: _servicesCache.services, specialtyNames: _servicesCache.specialtyNames, specialtyNameArMap: _servicesCache.specialtyNameArMap, title: 'Services & Pricing — Tashkheesa', BUSINESS_INFO: BUSINESS_INFO, description: 'Browse 150+ specialist medical review services with transparent EGP pricing. Radiology, cardiology, oncology, gastroenterology and more.', canonical: '/services' });
  });

  var LAUNCH_DATE = process.env.LAUNCH_DATE || '';
  var comingSoonTitle = LAUNCH_DATE ? 'Coming Soon — ' + LAUNCH_DATE : 'Coming Soon';
  var comingSoonDesc = (LAUNCH_DATE ? 'Tashkheesa launches ' + LAUNCH_DATE + '. ' : '') + 'Get expert medical second opinions from board-certified specialists.';
  router.get('/coming-soon', function(req, res) {
    // UTM params are captured from the URL and re-emitted as hidden form
    // inputs so they round-trip into pre_launch_leads on submit. Truncated
    // defensively (paid-traffic campaigns sometimes append tracking blobs).
    var q = req.query || {};
    function utm(name) {
      var v = q[name];
      if (typeof v !== 'string') return '';
      return v.slice(0, 120);
    }
    res.render('coming_soon', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      title: comingSoonTitle,
      BUSINESS_INFO: BUSINESS_INFO,
      description: comingSoonDesc,
      canonical: '/coming-soon',
      utm_source: utm('utm_source'),
      utm_medium: utm('utm_medium'),
      utm_campaign: utm('utm_campaign'),
      formState: 'idle',
      formErrors: null,
      formValues: null
    });
  });
  router.get('/help-me-choose', function(req, res) { res.render('help_me_choose', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: 'Find Your Service – Tashkheesa', BUSINESS_INFO: BUSINESS_INFO, description: 'Not sure which medical review service you need? Our AI assistant will guide you in seconds.', canonical: '/help-me-choose' }); });
  router.get('/about', function(req, res) { res.render('about', { title: 'About Us', BUSINESS_INFO: BUSINESS_INFO, description: 'Tashkheesa connects patients with board-certified hospital-based specialists for medical second opinions. Learn about our mission and standards.', canonical: '/about' }); });
  router.get('/contact', function(req, res) { res.render('contact', { title: 'Contact Us', BUSINESS_INFO: BUSINESS_INFO, description: 'Get in touch with Tashkheesa. We respond within 24 hours during business days.', canonical: '/contact' }); });
  router.get('/privacy', function(req, res) { res.render('privacy', { title: 'Privacy Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'How Tashkheesa collects, stores, and protects your personal and medical data.', canonical: '/privacy' }); });
  router.get('/terms', function(req, res) { res.render('terms', { title: 'Terms of Service', BUSINESS_INFO: BUSINESS_INFO, description: 'Terms and conditions for using Tashkheesa medical second opinion services.', canonical: '/terms' }); });
  router.get('/refund-policy', function(req, res) { res.render('refund_policy', { title: 'Refund & Cancellation Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'Clear refund and cancellation terms for all Tashkheesa services including video consultations.', canonical: '/refund-policy' }); });
  router.get('/delivery-policy', function(req, res) { res.render('delivery_policy', { title: 'Delivery & Service Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'How Tashkheesa delivers specialist medical reports. Digital delivery within 24-72 hours.', canonical: '/delivery-policy' }); });
  router.get('/faq', function(req, res) { res.render('faq', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: 'FAQ – Frequently Asked Questions', BUSINESS_INFO: BUSINESS_INFO, description: 'Answers to the most common questions about Tashkheesa: how second opinions work, turnaround times, pricing, privacy, and payment options.', canonical: '/faq' }); });

  // /blog — index + posts (P1-PUB-1 part 3).
  //
  // Two posts at launch, rendered from inline EJS views. Slug → view map below
  // is the source of truth; index page reads its catalog from blog_index.ejs
  // (kept in sync manually for now). When this hits ~5+ posts, migrate to
  // markdown-in-git with a single shared post template.
  var BLOG_POST_VIEWS = {
    'when-to-get-medical-second-opinion': {
      view: 'blog_when_to_get_second_opinion',
      title: 'When Should You Get a Medical Second Opinion? – Tashkheesa',
      title_ar: 'إمتى تاخد رأي طبي تاني؟ – تشخيصة',
      description: 'Five signs you need a second opinion, why research shows 1 in 5 diagnoses is incomplete, and how to get one without leaving home.'
    },
    'how-tashkheesa-works': {
      view: 'blog_how_tashkheesa_works',
      title: 'How Tashkheesa Works: Get a Second Opinion in 3 Steps – Tashkheesa',
      title_ar: 'إزاي تشخيصة بتشتغل: رأي تاني في ٣ خطوات – تشخيصة',
      description: 'Upload your records, get a specialist review, receive a detailed bilingual report in 24-72 hours. Here is the full process.'
    }
  };
  router.get('/blog', function(req, res) {
    res.render('blog_index', {
      title: 'Blog – Tashkheesa',
      BUSINESS_INFO: BUSINESS_INFO,
      description: 'Expert guides on medical second opinions, telemedicine, and how to make better decisions about your care. Bilingual EN/AR.',
      canonical: '/blog'
    });
  });
  router.get('/blog/:slug', function(req, res) {
    var slug = String((req.params && req.params.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    var entry = BLOG_POST_VIEWS[slug];
    if (!entry) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/blog' });
    }
    var isAr = !!(res.locals && res.locals.isAr);
    res.render(entry.view, {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      title: isAr && entry.title_ar ? entry.title_ar : entry.title,
      BUSINESS_INFO: BUSINESS_INFO,
      description: entry.description,
      canonical: '/blog/' + slug
    });
  });

  // /specialties — index page (P1-PUB-1 part 2).
  //
  // The EXISTS clause hides specialties with zero visible services.
  // 10 of the 22 visible specialties currently have no services
  // (Anesthesiology, Cardiothoracic, Clinical Nutrition, Emergency
  // Medicine, Nephrology, OB/GYN, Pathology, Psychiatry, Rheumatology,
  // Vascular Surgery). They will reappear automatically once services
  // are added — no code change required. This is intentional, not a bug.
  router.get('/specialties', async function(req, res) {
    var rows = await safeAll(
      "SELECT s.id, s.name, s.name_ar, s.description, s.description_ar, " +
      "  (SELECT COUNT(*)::int FROM services sv " +
      "   WHERE sv.specialty_id = s.id AND COALESCE(sv.is_visible, true) = true) AS service_count " +
      "FROM specialties s " +
      "WHERE COALESCE(s.is_visible, true) = true " +
      "  AND EXISTS ( " +
      "    SELECT 1 FROM services sv " +
      "    WHERE sv.specialty_id = s.id AND COALESCE(sv.is_visible, true) = true) " +
      "ORDER BY s.name ASC",
      [],
      []
    );
    return res.render('specialties_index', {
      title: 'Medical Specialties',
      BUSINESS_INFO: BUSINESS_INFO,
      description: 'Browse medical specialties available on Tashkheesa for second-opinion reviews by board-certified Egyptian consultants.',
      canonical: '/specialties',
      specialties: rows
    });
  });

  // /specialties/:slug — child page. Slug derives from id: cardiology
  // → spec-cardiology. Returns 404 if the specialty is hidden, missing,
  // or has zero visible services (matches index visibility rules).
  router.get('/specialties/:slug', async function(req, res) {
    var slug = String((req.params && req.params.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/specialties' });
    }
    var id = 'spec-' + slug;
    var specialtyRows = await safeAll(
      "SELECT s.id, s.name, s.name_ar, s.description, s.description_ar " +
      "FROM specialties s " +
      "WHERE s.id = $1 " +
      "  AND COALESCE(s.is_visible, true) = true " +
      "  AND EXISTS ( " +
      "    SELECT 1 FROM services sv " +
      "    WHERE sv.specialty_id = s.id AND COALESCE(sv.is_visible, true) = true) " +
      "LIMIT 1",
      [id],
      []
    );
    var specialty = specialtyRows[0] || null;
    if (!specialty) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/specialties' });
    }
    var services = await safeAll(
      "SELECT sv.id, sv.name, sv.base_price, sv.currency, sv.sla_hours " +
      "FROM services sv " +
      "WHERE sv.specialty_id = $1 " +
      "  AND COALESCE(sv.is_visible, true) = true " +
      "ORDER BY (sv.base_price IS NULL), sv.base_price ASC, sv.name ASC",
      [id],
      []
    );
    return res.render('specialty_detail', {
      title: specialty.name + ' – Tashkheesa',
      BUSINESS_INFO: BUSINESS_INFO,
      description: (specialty.description || '').slice(0, 160) ||
        ('Specialist ' + specialty.name + ' second opinions by board-certified consultants.'),
      canonical: '/specialties/' + slug,
      specialty: specialty,
      services: services,
      slug: slug
    });
  });

  router.get('/how-it-works', function(req, res) { res.redirect(302, '/#how-it-works'); });
  router.get('/doctors', function(req, res) { res.redirect(302, '/about'); });

  router.post('/contact', async function(req, res) {
    var body = req.body || {};
    var name = body.name;
    var email = body.email;
    var subject = body.subject;
    var message = body.message;
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    console.log('[CONTACT] New message from %s <%s> — subject: %s', name, email, subject || 'none');

    try {
      var { sendMail } = require('../services/emailService');
      await sendMail({
        to: process.env.SMTP_FROM_EMAIL || 'info@tashkheesa.com',
        replyTo: email,
        subject: 'New contact form submission from ' + name + (subject ? ' — ' + subject : ''),
        text: 'Name: ' + name + '\nEmail: ' + email + '\nSubject: ' + (subject || 'none') + '\nMessage: ' + message,
        html: '<p><b>Name:</b> ' + name + '</p><p><b>Email:</b> ' + email + '</p>' +
              (subject ? '<p><b>Subject:</b> ' + subject + '</p>' : '') +
              '<p><b>Message:</b> ' + message + '</p>'
      });
    } catch (err) {
      console.error('[CONTACT] Email send failed:', err.message);
    }

    return res.json({ ok: true });
  });

  // ─── Pre-launch lead capture ────────────────────────────────────────
  // Single source of truth for the /coming-soon form. Handles JSON
  // (fetch-driven) AND form-encoded (no-JS fallback) callers; the
  // response shape and the re-render path are chosen from the Accept
  // header.
  //
  // Storage: existing `pre_launch_leads` table, extended by migration
  // 068. UPSERT-on-LOWER(email) via SELECT-then-UPDATE/INSERT inside a
  // transaction (the unique index in migration 068 only lands when the
  // legacy table has no duplicates; the app-level path is the
  // authoritative dedupe surface either way).
  //
  // Dispatch: fire-and-forget AFTER the response is sent. pg-boss is
  // wired in this codebase (src/job_queue.js) but adding a new queue
  // would mean editing a high-risk file; the brief explicitly permits
  // inline fire-and-forget when traffic is low (an Instagram landing
  // page is). Marked as a follow-up.
  var pgHelpers = require('../pg');

  var leadValidators = [
    body('name').trim().notEmpty().withMessage('name_required').isLength({ max: 120 }),
    body('email').trim().isEmail().withMessage('email_invalid').isLength({ max: 254 }),
    body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 32 }),
    body('language').optional({ checkFalsy: true }).isIn(['en', 'ar', 'both']),
    body('service_interest').optional({ checkFalsy: true }).isLength({ max: 32 }),
    body('case_description').optional({ checkFalsy: true }).trim().isLength({ max: 2000 })
  ];

  function isTruthy(v) {
    if (v === true) return true;
    if (typeof v !== 'string') return false;
    var s = v.toLowerCase().trim();
    return s === 'on' || s === 'true' || s === '1' || s === 'yes';
  }

  function wantsJson(req) {
    var accept = String(req.get('accept') || '').toLowerCase();
    if (accept.includes('application/json')) return true;
    if (String(req.get('content-type') || '').toLowerCase().includes('application/json')) return true;
    if (String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest') return true;
    return false;
  }

  function renderComingSoon(req, res, state) {
    var q = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
    function utmFromBody(name) {
      var v = q[name];
      if (typeof v !== 'string') return '';
      return v.slice(0, 120);
    }
    res.render('coming_soon', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      title: comingSoonTitle,
      BUSINESS_INFO: BUSINESS_INFO,
      description: comingSoonDesc,
      canonical: '/coming-soon',
      utm_source: utmFromBody('utm_source'),
      utm_medium: utmFromBody('utm_medium'),
      utm_campaign: utmFromBody('utm_campaign'),
      formState: state.formState || 'idle',
      formErrors: state.formErrors || null,
      formValues: state.formValues || null
    });
  }

  function dispatchConfirmations(leadRow) {
    // Fire-and-forget. The response has already been flushed; this
    // updates pre_launch_leads asynchronously and never re-enters the
    // response cycle. Failures are logged + persisted as 'failed' on the
    // row so the admin view + future retries can see what happened.
    setImmediate(async function() {
      try {
        var emailResult = await comingSoonNotify.sendConfirmationEmail(leadRow);
        var smsResult = await comingSoonNotify.sendConfirmationSms(leadRow);
        try {
          await execute(
            'UPDATE pre_launch_leads SET confirm_email_status = $1, confirm_sms_status = $2, updated_at = NOW() WHERE id = $3',
            [emailResult.status, smsResult.status, leadRow.id]
          );
        } catch (e) {
          console.error('[PRE-LAUNCH] failed to update confirm statuses for ' + leadRow.id + ':', e.message);
        }
        if (emailResult.status === 'failed') {
          console.warn('[PRE-LAUNCH] email failed for ' + leadRow.id + ': ' + (emailResult.reason || ''));
        }
        if (smsResult.status === 'failed') {
          console.warn('[PRE-LAUNCH] sms failed for ' + leadRow.id + ': ' + (smsResult.reason || ''));
        }
      } catch (err) {
        console.error('[PRE-LAUNCH] dispatch threw for ' + leadRow.id + ':', err && err.message);
      }
    });
  }

  router.post('/api/pre-launch-interest', leadValidators, async function(req, res) {
    var body = req.body || {};
    var asJson = wantsJson(req);

    // ── Honeypot: silent 200. A real user never fills `website`. We do
    // NOT tell the bot it failed — that turns into a signal. We also
    // never dispatch (no leak of email transport behavior).
    if (body.website && String(body.website).trim() !== '') {
      if (asJson) return res.json({ success: true, message: 'ok' });
      return renderComingSoon(req, res, { formState: 'success' });
    }

    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      var mapped = errors.mapped();
      if (asJson) {
        return res.status(400).json({ success: false, error: 'invalid_input', fields: mapped });
      }
      return renderComingSoon(req, res, {
        formState: 'error',
        formErrors: mapped,
        formValues: body
      });
    }

    var name = String(body.name || '').trim();
    var email = String(body.email || '').trim();
    var phoneRaw = String(body.phone || '').trim();
    var phoneE164 = comingSoonNotify.normalizePhoneE164(phoneRaw);
    var language = String(body.language || '').trim().toLowerCase();
    if (['en', 'ar', 'both'].indexOf(language) === -1) language = 'ar';
    var serviceInterest = String(body.service_interest || 'all').trim().slice(0, 32);
    var caseDescription = String(body.case_description || '').trim();
    if (!caseDescription) caseDescription = null;
    var consent = isTruthy(body.consent);
    var utmSource = String(body.utm_source || '').trim().slice(0, 120) || null;
    var utmMedium = String(body.utm_medium || '').trim().slice(0, 120) || null;
    var utmCampaign = String(body.utm_campaign || '').trim().slice(0, 120) || null;
    var ipAddress = (req.ip || (req.connection && req.connection.remoteAddress) || '').toString();
    var userAgent = String(req.get('user-agent') || '').slice(0, 500);

    var leadRow;
    try {
      leadRow = await pgHelpers.withTransaction(async function(client) {
        var existing = await client.query(
          'SELECT id, name, email, phone, language, consent FROM pre_launch_leads WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [email]
        );
        if (existing.rows.length > 0) {
          var prev = existing.rows[0];
          // UPDATE — preserve consent=true if previously granted, only
          // bump it to true on this submission (never downgrade
          // true→false here; an unsubscribe is the only path to false).
          var nextConsent = prev.consent === true ? true : consent;
          var upd = await client.query(
            "UPDATE pre_launch_leads SET " +
              "name = $1, phone = COALESCE($2, phone), phone_e164 = COALESCE($3, phone_e164), " +
              "language = $4, service_interest = COALESCE($5, service_interest), " +
              "case_description = COALESCE($6, case_description), " +
              "utm_source = COALESCE($7, utm_source), utm_medium = COALESCE($8, utm_medium), utm_campaign = COALESCE($9, utm_campaign), " +
              "consent = $10, ip_address = COALESCE($11, ip_address), user_agent = COALESCE($12, user_agent), " +
              "confirm_email_status = 'pending', confirm_sms_status = CASE WHEN $3 IS NOT NULL AND $10 THEN 'pending' ELSE 'na' END, " +
              "updated_at = NOW() " +
              "WHERE id = $13 RETURNING *",
            [name, phoneRaw || null, phoneE164, language, serviceInterest, caseDescription,
             utmSource, utmMedium, utmCampaign, nextConsent, ipAddress, userAgent, prev.id]
          );
          return upd.rows[0];
        }
        // INSERT
        var id = uuidv4();
        var smsStart = (phoneE164 && consent) ? 'pending' : 'na';
        var ins = await client.query(
          "INSERT INTO pre_launch_leads (" +
            "id, name, email, phone, phone_e164, language, service_interest, case_description, " +
            "source, utm_source, utm_medium, utm_campaign, " +
            "ip_address, user_agent, consent, " +
            "confirm_email_status, confirm_sms_status, updated_at" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'coming_soon',$9,$10,$11,$12,$13,$14,'pending',$15,NOW()) RETURNING *",
          [id, name, email, phoneRaw || null, phoneE164, language, serviceInterest, caseDescription,
           utmSource, utmMedium, utmCampaign, ipAddress, userAgent, consent, smsStart]
        );
        return ins.rows[0];
      });
    } catch (err) {
      console.error('[PRE-LAUNCH] upsert failed:', err && err.message);
      if (asJson) {
        return res.status(500).json({ success: false, error: 'save_failed' });
      }
      return renderComingSoon(req, res, {
        formState: 'error',
        formErrors: { _global: { msg: 'save_failed' } },
        formValues: body
      });
    }

    console.log('[PRE-LAUNCH] lead upserted id=%s email=%s lang=%s consent=%s utm=%s',
      leadRow.id, email, language, String(consent), utmSource || '-');

    // Fire-and-forget dispatch. Response goes out first.
    if (asJson) {
      res.json({ success: true, message: 'Thank you for your interest! We will notify you when we launch.' });
    } else {
      renderComingSoon(req, res, { formState: 'success' });
    }
    dispatchConfirmations(leadRow);
  });

  // ─── /unsubscribe ─────────────────────────────────────────────────────
  // Flips pre_launch_leads.consent=false for the matching email if the
  // HMAC token is valid. The token is HMAC-SHA256(lower(email), JWT_SECRET)
  // truncated to 32 hex chars — matches the link the email footer renders
  // via comingSoonNotify.unsubscribeUrl. We do NOT 404 on bad tokens or
  // missing emails — that would enumerate which addresses are in the list.
  // Always returns the same shaped page; the only thing that varies is the
  // success/already-unsubscribed copy.
  router.get('/unsubscribe', async function(req, res) {
    var email = String((req.query && req.query.email) || '').toLowerCase().trim();
    var token = String((req.query && req.query.token) || '').trim();
    var ok = false;

    if (email && token) {
      var secret = process.env.JWT_SECRET || '';
      var expected = crypto.createHmac('sha256', secret).update(email).digest('hex').slice(0, 32);
      var validToken = false;
      try {
        if (token.length === expected.length) {
          validToken = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
        }
      } catch (_) { validToken = false; }

      if (validToken) {
        try {
          var r = await execute(
            'UPDATE pre_launch_leads SET consent = false, updated_at = NOW() WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          ok = r && (r.rowCount || 0) > 0;
        } catch (e) {
          console.error('[UNSUBSCRIBE] update failed:', e && e.message);
        }
      }
    }

    res.type('html').send(
      '<!doctype html><html lang="en"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Unsubscribed — Tashkheesa</title>' +
      '<link rel="stylesheet" href="/styles.css">' +
      '</head><body style="background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;">' +
      '<div style="max-width:560px;margin:80px auto;padding:32px 24px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">' +
      '<h1 style="margin:0 0 12px;font-size:22px;color:#0066CC;">Tashkheesa</h1>' +
      '<h2 style="margin:0 0 16px;font-size:18px;">' +
      (ok ? 'You have been unsubscribed.' : 'Unsubscribe link is invalid or already used.') +
      '</h2>' +
      '<p style="margin:0;font-size:14px;color:#6B7280;line-height:1.6;">' +
      (ok
        ? "We won't email you about the launch again. If this was a mistake, you can re-submit the form on our site."
        : "If you believe this is a mistake, please email <a href=\"mailto:info@tashkheesa.com\" style=\"color:#0066CC;\">info@tashkheesa.com</a> and we'll handle it manually.") +
      '</p>' +
      '<p style="margin:24px 0 0;font-size:13px;"><a href="/" style="color:#0066CC;">Back to site</a></p>' +
      '</div></body></html>'
    );
  });

  // Legacy .html redirects
  router.get('/services.html', function(req, res) { res.redirect(301, '/services'); });
  router.get('/privacy.html', function(req, res) { res.redirect(301, '/privacy'); });
  router.get('/terms.html', function(req, res) { res.redirect(301, '/terms'); });
  router.get('/about.html', function(req, res) { res.redirect(301, '/about'); });
  router.get('/contact.html', function(req, res) { res.redirect(301, '/contact'); });
  router.get('/doctors.html', function(req, res) { res.redirect(301, '/about'); });
  router.get('/site/services.html', function(req, res) { res.redirect(301, '/services'); });
  router.get('/site/about.html', function(req, res) { res.redirect(301, '/about'); });
  router.get('/site/contact.html', function(req, res) { res.redirect(301, '/contact'); });
  router.get('/site/doctors.html', function(req, res) { res.redirect(301, '/about'); });
  router.get('/site/privacy.html', function(req, res) { res.redirect(301, '/privacy'); });
  router.get('/site/terms.html', function(req, res) { res.redirect(301, '/terms'); });

  return router;
}

module.exports = { setupStaticPages: setupStaticPages };
