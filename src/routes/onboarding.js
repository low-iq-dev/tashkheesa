// src/routes/onboarding.js
// Patient onboarding wizard (Phase 5)

const express = require('express');
const { queryOne, execute } = require('../pg');
const { requireRole } = require('../middleware');
const { sanitizeString } = require('../validators/sanitize');
const { validatePhoneE164 } = require('../validators/phone');
const { refreshSessionCookie } = require('../auth');
const { logErrorToDb } = require('../logger');

const router = express.Router();

// P0-FORM-1: only allow ?next= redirects to in-app paths to prevent
// open-redirect via /portal/patient/onboarding?next=https://evil.com.
function _safeNext(raw) {
  if (!raw) return null;
  var s = String(raw);
  // Must be a same-origin absolute path. Reject //evil.com, http://, etc.
  if (s.length > 500) return null;
  if (s.charAt(0) !== '/' || s.charAt(1) === '/') return null;
  return s;
}

// GET /portal/patient/onboarding — Show onboarding wizard
async function _handleOnboardingGet(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var user = req.user;

    var dbUser = await queryOne(
      'SELECT onboarding_complete, name, phone, date_of_birth, gender, lang FROM users WHERE id = $1',
      [user.id]
    );

    var forcePhone = String(req.query.force_phone || '') === '1';
    var nextPath = _safeNext(req.query.next);

    // P0-FORM-1: allow re-entry into the wizard when phone is missing,
    // even if onboarding_complete=true. The original early-exit only
    // checked onboarding_complete, which trapped the 29 existing
    // patients without phone outside the wizard.
    var hasPhone = !!(dbUser && dbUser.phone && String(dbUser.phone).trim().length > 0);
    if (dbUser && dbUser.onboarding_complete === true && hasPhone) {
      // P0-FORM-1 self-heal: a patient with phone in DB but a stale JWT
      // (issued before phone was added to the payload) would loop here.
      // Detect the mismatch and re-issue the cookie before bouncing back
      // to /dashboard. Loop breaks on the very next request.
      if (!user.phone || String(user.phone).trim().length === 0) {
        refreshSessionCookie(res, Object.assign({}, user, { phone: dbUser.phone, name: dbUser.name || user.name, lang: dbUser.lang || user.lang }));
      }
      return res.redirect(nextPath || '/dashboard');
    }

    res.render('patient_onboarding', {
      user: user,
      dbUser: dbUser || {},
      lang: lang,
      isAr: isAr,
      forcePhone: forcePhone || !hasPhone, // implicit force when phone missing
      nextPath: nextPath,
      pageTitle: isAr ? 'إكمال الملف الشخصي' : 'Complete Your Profile'
    });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).send('Server error');
  }
}
router.get('/portal/patient/onboarding', requireRole('patient'), _handleOnboardingGet);

// POST /portal/patient/onboarding/profile — Save Step 1 (profile)
router.post('/portal/patient/onboarding/profile', requireRole('patient'), async function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var userId = req.user.id;

    var name = sanitizeString(req.body.name || '', 200).trim();
    var dateOfBirth = sanitizeString(req.body.date_of_birth || '', 10).trim();
    var gender = sanitizeString(req.body.gender || '', 10).trim();
    var preferredLang = (req.body.preferred_lang === 'ar') ? 'ar' : 'en';

    // P0-FORM-1: enforce E.164 via shared validator. Was sanitizePhone()
    // (digits-only normalizer) + bare notEmpty check, which accepted
    // truncated values like "+2010".
    var phoneCheck = validatePhoneE164(req.body.phone, lang);
    var errors = [];
    if (!name) errors.push(isAr ? 'الاسم الكامل مطلوب' : 'Full name is required');
    if (!phoneCheck.ok) errors.push(phoneCheck.error);

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, errors: errors });
    }
    var phone = phoneCheck.normalized;

    // Validate gender
    if (gender && !['male', 'female'].includes(gender)) {
      gender = '';
    }

    // Validate date format (YYYY-MM-DD)
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      dateOfBirth = '';
    }

    await execute(
      'UPDATE users SET name = $1, phone = $2, date_of_birth = $3, gender = $4, lang = $5 WHERE id = $6',
      [name, phone, dateOfBirth || null, gender || null, preferredLang, userId]
    );

    // P0-FORM-1: re-sign the session cookie with the freshly saved phone
    // so the requirePhone() gate clears on the very next request. Without
    // this the user would loop back to the wizard once after saving.
    refreshSessionCookie(res, Object.assign({}, req.user, { name: name, phone: phone, lang: preferredLang }));

    // P0-FORM-1: honor ?next so backfill-redirected users land back at
    // their original destination (e.g. /portal/patient/orders/:id).
    var nextPath = _safeNext(req.body.next || req.query.next);
    return res.json({ ok: true, redirect: nextPath || undefined, message: isAr ? 'تم حفظ البيانات' : 'Profile saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/medical-history — Save Step 2
router.post('/portal/patient/onboarding/medical-history', requireRole('patient'), async function(req, res) {
  try {
    var lang = res.locals.lang || 'en';
    var isAr = lang === 'ar';
    var userId = req.user.id;

    var knownConditions = sanitizeString(req.body.known_conditions || '', 2000).trim();
    var currentMedications = sanitizeString(req.body.current_medications || '', 5000).trim();
    var allergies = sanitizeString(req.body.allergies || '', 2000).trim();
    var previousSurgeries = sanitizeString(req.body.previous_surgeries || '', 2000).trim();
    var familyHistory = sanitizeString(req.body.family_history || '', 2000).trim();

    await execute(
      'UPDATE users SET known_conditions = $1, current_medications = $2, allergies = $3, previous_surgeries = $4, family_history = $5 WHERE id = $6',
      [
        knownConditions || null,
        currentMedications || null,
        allergies || null,
        previousSurgeries || null,
        familyHistory || null,
        userId
      ]
    );

    return res.json({ ok: true, message: isAr ? 'تم حفظ التاريخ الطبي' : 'Medical history saved' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/complete — Mark onboarding as done
router.post('/portal/patient/onboarding/complete', requireRole('patient'), async function(req, res) {
  try {
    var userId = req.user.id;
    await execute('UPDATE users SET onboarding_complete = true WHERE id = $1', [userId]);
    return res.json({ ok: true, redirect: '/dashboard' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /portal/patient/onboarding/skip — Skip onboarding (medical-history step)
router.post('/portal/patient/onboarding/skip', requireRole('patient'), async function(req, res) {
  try {
    // P0-FORM-1: skip is only allowed if the user has a phone. The
    // backfill flow MUST collect phone — letting the user click "Skip
    // for now" on step 1 would defeat the gate. If they have a phone
    // already, this skip applies to step 2 (medical history) and the
    // existing behavior stands.
    var dbUser = await queryOne('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    var hasPhone = !!(dbUser && dbUser.phone && String(dbUser.phone).trim().length > 0);
    if (!hasPhone) {
      return res.status(400).json({
        ok: false,
        error: (res.locals.lang === 'ar')
          ? 'رقم الهاتف مطلوب لمتابعة استخدام تشخيصة.'
          : 'Phone number is required to continue using Tashkheesa.'
      });
    }
    return res.json({ ok: true, redirect: '/dashboard' });
  } catch (err) {
    logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
// Test seam — exposed so unit tests can invoke the handler with stub req/res
// without booting the full express app. See tests/auth/onboarding-self-heal.test.js.
module.exports._handleOnboardingGet = _handleOnboardingGet;
