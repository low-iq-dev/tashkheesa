// src/routes/auth.js
const express = require('express');
const { db } = require('../db');
const { hash, check } = require('../auth');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { queueNotification } = require('../notify');
const { sendEmail } = require('../services/emailService');
const { logErrorToDb } = require('../logger');
require('dotenv').config();

const NODE_ENV = String(process.env.NODE_ENV || '').toLowerCase();
const MODE = String(process.env.MODE || NODE_ENV || 'development').toLowerCase();
const IS_PROD = NODE_ENV === 'production' || MODE === 'production';
const IS_STAGING = MODE === 'staging';
const COOKIE_SECURE = IS_PROD || IS_STAGING;

const router = express.Router();
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
const LANG_COOKIE = process.env.LANG_COOKIE_NAME || 'lang';
const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
const RESET_EXPIRY_HOURS = 2;
const MAGIC_LINK_EXPIRY_MINUTES = 60;
const ALLOWED_COUNTRY_CODES = new Set(['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM']);

function getReqLang(req) {
  const q = (req.query && String(req.query.lang || '').toLowerCase()) || '';
  const b = (req.body && String(req.body.lang || '').toLowerCase()) || '';
  const c = (req.cookies && String((req.cookies[LANG_COOKIE]) || '').toLowerCase()) || '';
  const h = String(req.get && req.get('accept-language') || '').toLowerCase();
  const lang = (q || b || c || (h.startsWith('ar') ? 'ar' : 'en'));
  return (lang === 'ar') ? 'ar' : 'en';
}

function setLangCookie(res, lang) {
  const v = (String(lang || '').toLowerCase() === 'ar') ? 'ar' : 'en';
  // Not httpOnly so templates/client-side can read it if needed; harmless if not used.
  res.cookie(LANG_COOKIE, v, {
    httpOnly: false,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: LANG_COOKIE_MAX_AGE,
  });
}

function authCopy(req) {
  const isAr = getReqLang(req) === 'ar';
  return {
    isAr,
    login_required: isAr ? 'البريد الإلكتروني وكلمة المرور مطلوبان.' : 'Email and password are required.',
    login_invalid: isAr ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' : 'Invalid email or password.',
    login_doctor_pending: isAr ? 'طلبك ما زال قيد المراجعة.' : 'Your application is still under review.',
    login_doctor_inactive: isAr ? 'حسابك غير مفعل. تواصل مع الدعم.' : 'Your account is inactive. Contact support.',
    login_unexpected: isAr ? 'حدث خطأ غير متوقع أثناء تسجيل الدخول. حاول مرة أخرى.' : 'Unexpected error during login. Please try again.',

    forgot_info: isAr ? 'إذا كان هناك حساب بهذا البريد الإلكتروني، ستصلك رسالة لإعادة تعيين كلمة المرور.' : 'If an account exists for this email, you will receive a reset link.',

    reset_pw_invalid: isAr ? 'رابط إعادة تعيين كلمة المرور غير صالح أو منتهي.' : 'Reset link invalid or expired.',
    reset_pw_rule: isAr ? 'يجب أن تتطابق كلمتا المرور وأن تكون كلمة المرور 8 أحرف على الأقل.' : 'Passwords must match and be at least 8 characters.',
    reset_pw_success: isAr ? 'تم تغيير كلمة المرور بنجاح. الرجاء تسجيل الدخول.' : 'Password reset successful. Please log in.',

    register_required: isAr ? 'الاسم والبريد الإلكتروني وكلمة المرور والدولة مطلوبة.' : 'Name, email, password, and country are required.',
    register_country_invalid: isAr ? 'يرجى اختيار دولة صحيحة.' : 'Please select a valid country.',
    register_email_exists: isAr ? 'هذا البريد الإلكتروني مسجل بالفعل.' : 'Email already registered.',

    doctor_signup_required: isAr ? 'يرجى تعبئة جميع الحقول المطلوبة.' : 'Please fill all required fields.',
    doctor_signup_pw_short: isAr ? 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' : 'Password must be at least 6 characters.',
    doctor_signup_email_exists: isAr ? 'هذا البريد الإلكتروني مسجل بالفعل.' : 'Email already registered.',
    doctor_signup_specialty_invalid: isAr ? 'يرجى اختيار تخصص صحيح.' : 'Please select a valid specialty.'
  };
}

function renderLogin(req, res, { error = null } = {}) {
  const copy = authCopy(req);
  const { isAr } = copy;
  const lang = isAr ? 'ar' : 'en';
  setLangCookie(res, lang);
  const next = safeNextPath((req.body && req.body.next) || (req.query && req.query.next));
  return res.render('login', { error, next, lang, isAr, copy, _lang: lang });
}

function renderForgot(req, res, { info = null, error = null } = {}) {
  const copy = authCopy(req);
  const { isAr } = copy;
  const lang = isAr ? 'ar' : 'en';
  setLangCookie(res, lang);
  return res.render('forgot_password', { info, error, lang, isAr, copy, _lang: lang });
}

function signUserToken(user) {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    lang: user.lang || 'en',
    country_code: user.country_code || null
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function getBaseUrl(req) {
  const envUrl = String(process.env.BASE_URL || '').trim();
  if (envUrl) return envUrl;

  try {
    // Support common proxy headers (even if trust proxy isn't configured yet)
    const protoRaw = (req.get('x-forwarded-proto') || req.protocol || 'http');
    const proto = String(protoRaw).split(',')[0].trim() || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) return `${proto}://${host}`;
  } catch (_) {
    // fall through
  }

  // Never leak localhost in production. In dev, localhost is fine.
  return IS_PROD ? '' : 'http://localhost:3000';
}

function createMagicLoginToken(userId) {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).run(randomUUID(), userId, token, expiresAt, now.toISOString());
  return token;
}

function sendMagicLoginLink({ user, req }) {
  if (!user || !user.id) return null;
  const token = createMagicLoginToken(user.id);
  const baseUrl = getBaseUrl(req);
  const link = baseUrl ? `${baseUrl}/magic-login/${token}` : null;

  if (!IS_PROD && link) {
    // eslint-disable-next-line no-console
    console.log('[MAGIC LOGIN LINK]', link);
  }

  try {
    queueNotification({
      toUserId: user.id,
      channel: 'email',
      template: 'magic_login_link',
      status: 'queued',
      response: { magic_login_url: link }
    });
  } catch (_) {}

  return link;
}

function getHomeByRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'superadmin') return '/superadmin';
  if (r === 'admin') return '/admin';
  if (r === 'doctor') return '/portal/doctor'; // canonical
  if (r === 'patient') return '/dashboard';
  return '/login';
}

// Prevent open redirects — allow ONLY same-site relative paths
function safeNextPath(candidate) {
  if (!candidate) return null;
  const raw = String(candidate).trim();
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  // Block obvious protocol attempts
  if (/^\/\/(?:https?:)?/i.test(raw)) return null;
  if (/^https?:/i.test(raw)) return null;
  return raw;
}

// ============================================
// GET /login
// ============================================
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(getHomeByRole(req.user.role));
  setLangCookie(res, getReqLang(req));
  return renderLogin(req, res, { error: null });
});

// ============================================
// POST /login
// ============================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_required });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(normalizedEmail);

    if (!user) {
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_invalid });
    }

    if (user.role === 'patient' && !user.password_hash) {
      sendMagicLoginLink({ user, req });
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_invalid });
    }

    const ok = await check(password, user.password_hash);
    if (!ok) {
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_invalid });
    }

    if (user.role === 'doctor') {
      if (user.pending_approval) {
        const c = authCopy(req);
        return renderLogin(req, res, { error: c.login_doctor_pending });
      }
      if (!user.is_active) {
        const c = authCopy(req);
        return renderLogin(req, res, { error: c.login_doctor_inactive });
      }
    }

    // Create session
    const token = signUserToken(user);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    setLangCookie(res, user.lang || getReqLang(req));

    // === PHASE 3: FIX #12 - PASSWORD CHECK AT LOGIN ===
    // For patients who somehow have a valid token without a password,
    // redirect to set-password page (moved from middleware check on every request)
    if (user.role === 'patient' && !user.password_hash) {
      return res.redirect('/set-password');
    }

    // Safe next redirect (same-site only)
    const next = safeNextPath((req.body && req.body.next) || (req.query && req.query.next));
    if (next) return res.redirect(next);

    // Role-based redirects
    return res.redirect(getHomeByRole(user.role));
  } catch (err) {
    console.error('Login error:', err);
    const c = authCopy(req);
    return renderLogin(req, res, { error: c.login_unexpected });
  }
});

// ============================================
// GET /forgot-password
// ============================================
router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/');
  setLangCookie(res, getReqLang(req));
  return renderForgot(req, res, { info: null, error: null });
});

// ============================================
// POST /forgot-password
// ============================================
router.post('/forgot-password', (req, res) => {
  const email = (req.body && req.body.email ? req.body.email.trim().toLowerCase() : '');
  const user = email
    ? db.prepare("SELECT * FROM users WHERE email = ? AND role = 'patient' AND is_active = 1").get(email)
    : null;

  if (user) {
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    ).run(randomUUID(), user.id, token, expiresAt, now.toISOString());

    // Security: do NOT print reset links in production logs.
    // In development, printing helps you test without email integration.
    const baseUrl = getBaseUrl(req);
    const lang = getReqLang(req);
    const resetLink = baseUrl ? `${baseUrl}/reset-password/${token}?lang=${lang}` : null;
    if (!IS_PROD && resetLink) {
      // eslint-disable-next-line no-console
      console.log('[RESET LINK]', resetLink);
    }
  }

  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  return renderForgot(req, res, { info: c.forgot_info, error: null });
});

// ============================================
// GET /magic-login/:token
// ============================================
router.get('/magic-login/:token', (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return renderLogin(req, res, { error: c.login_invalid });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(tokenRow.user_id);
  if (!user) {
    const c = authCopy(req);
    return renderLogin(req, res, { error: c.login_invalid });
  }

  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE password_reset_tokens
     SET used_at = ?
     WHERE token = ?`
  ).run(nowIso, token);

  const sessionToken = signUserToken(user);
  res.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  setLangCookie(res, user.lang || getReqLang(req));

  if (!user.password_hash) {
    return res.redirect('/set-password');
  }

  return res.redirect(getHomeByRole(user.role));
});

function findValidToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT *
       FROM password_reset_tokens
       WHERE token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.used_at) return null;
  if (!row.expires_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// ============================================
// GET /set-password
// ============================================
router.get('/set-password', (req, res) => {
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';
  setLangCookie(res, lang);

  if (!req.user) return res.redirect('/login');

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.user.id);
  if (!user) return res.redirect('/login');
  if (user.password_hash) return res.redirect(getHomeByRole(user.role));

  return res.render('set_password', { error: null, success: null, lang, _lang: lang, isAr: c.isAr, copy: c });
});

// ============================================
// POST /set-password
// ============================================
router.post('/set-password', (req, res) => {
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';
  setLangCookie(res, lang);

  if (!req.user) return res.redirect('/login');

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.user.id);
  if (!user) return res.redirect('/login');
  if (user.password_hash) return res.redirect(getHomeByRole(user.role));

  const password = (req.body && req.body.password) || '';
  const confirm = (req.body && req.body.confirm_password) || '';
  if (password.length < 8 || password !== confirm) {
    return res.status(400).render('set_password', {
      error: c.reset_pw_rule,
      success: null,
      lang,
      _lang: lang,
      isAr: c.isAr,
      copy: c
    });
  }

  const nowIso = new Date().toISOString();
  const passwordHash = hash(password);

  db.transaction(() => {
    db.prepare(
      `UPDATE users
       SET password_hash = ?, is_active = 1
       WHERE id = ?`
    ).run(passwordHash, user.id);

    db.prepare(
      `UPDATE password_reset_tokens
       SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`
    ).run(nowIso, user.id);
  })();

  return res.redirect(getHomeByRole(user.role));
});

// ============================================
// GET /reset-password/:token
// ============================================
router.get('/reset-password/:token', (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(tokenRow.user_id);
  if (!user) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }
  const c = authCopy(req);
  return res.render('reset_password', { token, error: null, success: null, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
});

// ============================================
// POST /reset-password/:token
// ============================================
router.post('/reset-password/:token', (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(tokenRow.user_id);
  if (!user) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }

  const password = (req.body && req.body.password) || '';
  const confirm = (req.body && req.body.confirm_password) || '';
  if (password.length < 8 || password !== confirm) {
    const c = authCopy(req);
    return res.status(400).render('reset_password', {
      token,
      error: c.reset_pw_rule,
      success: null,
      lang: c.isAr ? 'ar' : 'en',
      _lang: c.isAr ? 'ar' : 'en',
      isAr: c.isAr,
      copy: c
    });
  }

  const nowIso = new Date().toISOString();
  const passwordHash = hash(password);

  db.transaction(() => {
    db.prepare(
      `UPDATE users
       SET password_hash = ?, is_active = 1
       WHERE id = ?`
    ).run(passwordHash, user.id);

    db.prepare(
      `UPDATE password_reset_tokens
       SET used_at = ?
       WHERE token = ?`
    ).run(nowIso, token);

    db.prepare(
      `UPDATE password_reset_tokens
       SET used_at = ?
       WHERE user_id = ? AND used_at IS NULL`
    ).run(nowIso, user.id);
  })();

  const c = authCopy(req);
  return res.render('reset_password', {
    token: null,
    error: null,
    success: c.reset_pw_success,
    lang: c.isAr ? 'ar' : 'en',
    _lang: c.isAr ? 'ar' : 'en',
    isAr: c.isAr,
    copy: c
  });
});

// ============================================
// GET /register (patient signup)
// ============================================
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  res.render('register', { error: null, form: {}, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
});

// ============================================
// POST /register
// ============================================
router.post('/register', (req, res) => {
  /*
    Manual test:
    - GET /register -> country select is required; submitting without it shows error.
    - POST /register with invalid country_code -> error; name/email/country preserved.
    - POST /register with valid country_code -> user row has country_code; /login returns req.user.country_code.
  */
  const { name, email, password, country_code } = req.body || {};
  const normalizedCountry = String(country_code || '').trim().toUpperCase();
  const form = { name, email, country_code: normalizedCountry || '' };
  const c = authCopy(req);

  if (!email || !password || !name || !normalizedCountry) {
    return res
      .status(400)
      .render('register', { error: c.register_required, form, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
  }

  if (!ALLOWED_COUNTRY_CODES.has(normalizedCountry)) {
    return res
      .status(400)
      .render('register', { error: c.register_country_invalid, form, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) {
    return res
      .status(400)
      .render('register', { error: c.register_email_exists, form, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
  }

  const id = randomUUID();
  const passwordHash = hash(password);
  const lang = c.isAr ? 'ar' : 'en';

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, lang, country_code)
    VALUES (?, ?, ?, ?, 'patient', ?, ?)
  `).run(id, normalizedEmail, passwordHash, name, lang, normalizedCountry);

  const user = {
    id,
    email: normalizedEmail,
    password_hash: passwordHash,
    name,
    role: 'patient',
    lang: lang,
    country_code: normalizedCountry
  };

  const token = signUserToken(user);

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  setLangCookie(res, lang);

  // Send welcome email (fire-and-forget)
  try {
    var APP_URL = process.env.APP_URL || 'https://tashkheesa.com';
    sendEmail({
      to: normalizedEmail,
      subject: lang === 'ar' ? 'مرحباً بك في تشخيصة' : 'Welcome to Tashkheesa',
      template: 'welcome',
      lang: lang,
      data: { patientName: name, dashboardUrl: APP_URL + '/dashboard' }
    }).catch(function() { /* fire and forget */ });
  } catch (e) {
    // Never block registration for email failure
  }

  // Redirect new patients to onboarding wizard
  return res.redirect('/portal/patient/onboarding');
});

// ============================================
// GET /doctor/signup
// ============================================
router.get('/doctor/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  setLangCookie(res, getReqLang(req));
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const c = authCopy(req);
  res.render('doctor_signup', { error: null, specialties, form: {}, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
});

// ============================================
// POST /doctor/signup
// ============================================
router.post('/doctor/signup', (req, res) => {
  setLangCookie(res, getReqLang(req));
  const { name, email, password, specialty_id, phone, notes } = req.body || {};
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';

  if (!name || !email || !password || !specialty_id) {
    return res.status(400).render('doctor_signup', {
      error: c.doctor_signup_required,
      specialties,
      form: req.body || {},
      lang,
      _lang: lang,
      isAr: c.isAr,
      copy: c
    });
  }

  if (password.length < 6) {
    return res.status(400).render('doctor_signup', {
      error: c.doctor_signup_pw_short,
      specialties,
      form: req.body || {},
      lang,
      _lang: lang,
      isAr: c.isAr,
      copy: c
    });
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) {
    return res.status(400).render('doctor_signup', {
      error: c.doctor_signup_email_exists,
      specialties,
      form: req.body || {},
      lang,
      _lang: lang,
      isAr: c.isAr,
      copy: c
    });
  }

  const specialtyValid = db.prepare('SELECT 1 FROM specialties WHERE id = ?').get(specialty_id);
  if (!specialtyValid) {
    return res.status(400).render('doctor_signup', {
      error: c.doctor_signup_specialty_invalid,
      specialties,
      form: req.body || {},
      lang,
      _lang: lang,
      isAr: c.isAr,
      copy: c
    });
  }

  const id = randomUUID();
  const passwordHash = hash(password);
  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, pending_approval, is_active, approved_at, rejection_reason, signup_notes, created_at)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, ?, 1, 0, NULL, NULL, ?, ?)`
  ).run(id, normalizedEmail, passwordHash, name, specialty_id, phone || null, lang, notes || null, nowIso);

  const superadmin = db.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY created_at ASC LIMIT 1").get();
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
  const notifyUser = superadmin || admin;
  if (notifyUser) {
    queueNotification({
      orderId: null,
      toUserId: notifyUser.id,
      channel: 'internal',
      template: 'doctor_signup_pending',
      status: 'queued'
    });
  }

  const c2 = authCopy(req);
  return res.render('doctor_signup_submitted', { lang: c2.isAr ? 'ar' : 'en', _lang: c2.isAr ? 'ar' : 'en', isAr: c2.isAr, copy: c2 });
});

// ============================================
// GET /register/doctor — alias for /doctor/signup
// ============================================
router.get('/register/doctor', (req, res) => {
  return res.redirect('/doctor/signup');
});

// ============================================
// GET /logout (safe browser logout button)
// ============================================
router.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect(`/login?lang=${getReqLang(req)}`);
});

// ============================================
// POST /logout (form submissions)
// ============================================
router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect(`/login?lang=${getReqLang(req)}`);
});

module.exports = router;
