// src/routes/static-pages.js
// Public static pages, contact form, pre-launch interest, and .html redirects.

var express = require('express');
var router = express.Router();

function setupStaticPages(opts) {
  var execute = opts.execute;
  var safeAll = opts.safeAll;

  var BUSINESS_INFO = {
    email: 'info@tashkheesa.com',
    phone: '+20 110 200 9886',
    address: 'Cairo, Egypt',
    businessHours: 'Sunday – Thursday: 9:00 AM – 5:00 PM (Cairo Time)',
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
  var _servicesCache = { services: null, specialtyNames: null, ts: 0 };
  var SERVICES_CACHE_TTL_MS = 5 * 60 * 1000;

  router.get('/services', async function(req, res) {
    var now = Date.now();
    if (!_servicesCache.services || (now - _servicesCache.ts) >= SERVICES_CACHE_TTL_MS) {
      var services = await safeAll('\n      SELECT DISTINCT ON (sv.id) sv.*, sp.name as specialty_name\n      FROM services sv\n      JOIN specialties sp ON sv.specialty_id = sp.id AND COALESCE(sp.is_visible, true) = true\n      WHERE COALESCE(sv.is_visible, true) = true\n        AND sv.base_price IS NOT NULL\n        AND sv.base_price > 0\n      ORDER BY sv.id, sp.name, sv.base_price ASC\n    ', [], []);
      services.forEach(function(s) { s.description = getServiceDescription(s.name); });
      var specialtyNames = [];
      var seen = {};
      services.forEach(function(s) {
        if (s.specialty_name && !seen[s.specialty_name]) {
          seen[s.specialty_name] = true;
          specialtyNames.push(s.specialty_name);
        }
      });
      specialtyNames.sort();
      _servicesCache = { services: services, specialtyNames: specialtyNames, ts: now };
    }
    res.render('services', { services: _servicesCache.services, specialtyNames: _servicesCache.specialtyNames, title: 'Services & Pricing — Tashkheesa', BUSINESS_INFO: BUSINESS_INFO, description: 'Browse 150+ specialist medical review services with transparent EGP pricing. Radiology, cardiology, oncology, gastroenterology and more.', canonical: '/services' });
  });

  var LAUNCH_DATE = process.env.LAUNCH_DATE || '';
  var comingSoonTitle = LAUNCH_DATE ? 'Coming Soon — ' + LAUNCH_DATE : 'Coming Soon';
  var comingSoonDesc = (LAUNCH_DATE ? 'Tashkheesa launches ' + LAUNCH_DATE + '. ' : '') + 'Get expert medical second opinions from board-certified specialists.';
  router.get('/coming-soon', function(req, res) { res.render('coming_soon', { title: comingSoonTitle, BUSINESS_INFO: BUSINESS_INFO, description: comingSoonDesc, canonical: '/coming-soon' }); });
  router.get('/help-me-choose', function(req, res) { res.render('help_me_choose', { title: 'Find Your Service – Tashkheesa', BUSINESS_INFO: BUSINESS_INFO, description: 'Not sure which medical review service you need? Our AI assistant will guide you in seconds.', canonical: '/help-me-choose' }); });
  router.get('/about', function(req, res) { res.render('about', { title: 'About Us', BUSINESS_INFO: BUSINESS_INFO, description: 'Tashkheesa connects patients with board-certified hospital-based specialists for medical second opinions. Learn about our mission and standards.', canonical: '/about' }); });
  router.get('/contact', function(req, res) { res.render('contact', { title: 'Contact Us', BUSINESS_INFO: BUSINESS_INFO, description: 'Get in touch with Tashkheesa. We respond within 24 hours during business days.', canonical: '/contact' }); });
  router.get('/privacy', function(req, res) { res.render('privacy', { title: 'Privacy Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'How Tashkheesa collects, stores, and protects your personal and medical data.', canonical: '/privacy' }); });
  router.get('/terms', function(req, res) { res.render('terms', { title: 'Terms of Service', BUSINESS_INFO: BUSINESS_INFO, description: 'Terms and conditions for using Tashkheesa medical second opinion services.', canonical: '/terms' }); });
  router.get('/refund-policy', function(req, res) { res.render('refund_policy', { title: 'Refund & Cancellation Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'Clear refund and cancellation terms for all Tashkheesa services including video consultations.', canonical: '/refund-policy' }); });
  router.get('/delivery-policy', function(req, res) { res.render('delivery_policy', { title: 'Delivery & Service Policy', BUSINESS_INFO: BUSINESS_INFO, description: 'How Tashkheesa delivers specialist medical reports. Digital delivery within 24-72 hours.', canonical: '/delivery-policy' }); });
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

  router.post('/api/pre-launch-interest', async function(req, res) {
    var body = req.body || {};
    var name = body.name;
    var email = body.email;
    var phone = body.phone;
    var language = body.language;
    var service_interest = body.service_interest;
    var case_description = body.case_description;

    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }

    var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    try {
      var { v4: uuidv4 } = require('uuid');
      var ipAddress = req.ip || req.connection.remoteAddress || '';
      var userAgent = req.get('user-agent') || '';

      await execute('\n      INSERT INTO pre_launch_leads (\n        id, name, email, phone, language,\n        service_interest, case_description,\n        source, ip_address, user_agent\n      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)\n    ', [
        uuidv4(), name, email, phone || null, language || 'en',
        service_interest || 'all', case_description || null,
        'coming_soon_page', ipAddress, userAgent
      ]);

      console.log('[PRE-LAUNCH] New lead: %s <%s> - interested in: %s', name, email, service_interest || 'all services');

      return res.json({ success: true, message: 'Thank you for your interest! We will notify you when we launch.' });
    } catch (error) {
      console.error('[PRE-LAUNCH] Error saving lead:', error);
      return res.status(500).json({ success: false, error: 'Failed to save your information. Please try again.' });
    }
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
