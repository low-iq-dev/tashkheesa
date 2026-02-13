// src/routes/onboarding.js
// Patient onboarding wizard (Phase 5)

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../middleware');
const { sanitizeString, sanitizePhone } = require('../validators/sanitize');
const { logErrorToDb } = require('../logger');

const router = express.Router();

// GET /portal/patient/onboarding — Show onboarding wizard
router.get('/portal/patient/onboarding', requireRole('patient'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var user = req.user;

    // If already onboarded, redirect to dashboard
    var dbUser = db.prepare('SELECT onboarding_complete, name, phone, date_of_birth, gender, lang FROM users WHERE id = ?').get(user.id);
    if (dbUser && dbUser.onboarding_complete === 1) {
      return res.redirect('/dashboard');
    }

    res.render('patient_onboarding', {
      user: user,
      dbUser: dbUser || {},
      lang: lang,
      isAr: isAr,
      pageTitle: isAr ? 'إكمال الملف الشخصي' : 'Complete Your Profile'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
});

// POST /portal/patient/onboarding/profile — Save Step 1 (profile)
router.post('/portal/patient/onboarding/profile', requireRole('patient'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var userId = req.user.id;

    var name = sanitizeString(req.body.name || '', 200).trim();
    var phone = sanitizePhone(req.body.phone || '');
    var dateOfBirth = sanitizeString(req.body.date_of_birth || '', 10).trim();
    var gender = sanitizeString(req.body.gender || '', 10).trim();
    var preferredLang = (req.body.preferred_lang === 'ar') ? 'ar' : 'en';

    var errors = [];
    if (!name) errors.push(isAr ? 'الاسم الكامل مطلوب' : 'Full name is required');
    if (!phone) errors.push(isAr ? 'رقم الهاتف مطلوب' : 'Phone number is required');

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, errors: errors });
    }

    // Validate gender
    if (gender && !['male', 'female'].includes(gender)) {
      gender = '';
    }

    // Validate date format (YYYY-MM-DD)
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      dateOfBirth = '';
    }

    db.prepare(
      'UPDATE users SET name = ?, phone = ?, date_of_birth = ?, gender = ?, lang = ? WHERE id = ?'
    ).run(name, phone, dateOfBirth || null, gender || null, preferredLang, userId);

    return res.json({ ok: true, message: isAr ? 'تم حفظ البيانات' : 'Profile saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/medical-history — Save Step 2
router.post('/portal/patient/onboarding/medical-history', requireRole('patient'), function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var userId = req.user.id;

    var knownConditions = sanitizeString(req.body.known_conditions || '', 2000).trim();
    var currentMedications = sanitizeString(req.body.current_medications || '', 5000).trim();
    var allergies = sanitizeString(req.body.allergies || '', 2000).trim();
    var previousSurgeries = sanitizeString(req.body.previous_surgeries || '', 2000).trim();
    var familyHistory = sanitizeString(req.body.family_history || '', 2000).trim();

    db.prepare(
      'UPDATE users SET known_conditions = ?, current_medications = ?, allergies = ?, previous_surgeries = ?, family_history = ? WHERE id = ?'
    ).run(
      knownConditions || null,
      currentMedications || null,
      allergies || null,
      previousSurgeries || null,
      familyHistory || null,
      userId
    );

    return res.json({ ok: true, message: isAr ? 'تم حفظ التاريخ الطبي' : 'Medical history saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/complete — Mark onboarding as done
router.post('/portal/patient/onboarding/complete', requireRole('patient'), function(req, res) {
  try {
    var userId = req.user.id;
    db.prepare('UPDATE users SET onboarding_complete = 1 WHERE id = ?').run(userId);
    return res.json({ ok: true, redirect: '/dashboard' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/skip — Skip onboarding
router.post('/portal/patient/onboarding/skip', requireRole('patient'), function(req, res) {
  try {
    // Don't mark as complete, just redirect
    return res.json({ ok: true, redirect: '/dashboard' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
