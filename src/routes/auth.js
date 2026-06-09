// src/routes/auth.js
const express = require('express');
const { queryOne, queryAll, execute, withTransaction } = require('../pg');
const { hash, check } = require('../auth');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { queueNotification } = require('../notify');
const { sendEmail } = require('../services/emailService');
const { logErrorToDb } = require('../logger');
const { isLaunchMarket } = require('../launch-market');
const rateLimit = require('express-rate-limit');
const { sendOtpViaTwilio, verifyOtpCode } = require('../services/twilio_verify');
const { validatePhoneE164 } = require('../validators/phone');
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
    otp_invalid: isAr ? 'رمز التحقق غير صحيح أو منتهي.' : 'The verification code is incorrect or expired.',

    forgot_info: isAr ? 'إذا كان هناك حساب بهذا البريد الإلكتروني، ستصلك رسالة لإعادة تعيين كلمة المرور.' : 'If an account exists for this email, you will receive a reset link.',
    forgot_success_title: isAr ? 'تحقق من بريدك الإلكتروني' : 'Check your inbox',
    forgot_success_expiry: isAr ? 'تنتهي صلاحية الرابط خلال ساعتين.' : 'The link expires in 2 hours.',
    forgot_back_to_login: isAr ? 'العودة لتسجيل الدخول' : 'Back to login',
    forgot_sending: isAr ? 'جارٍ الإرسال…' : 'Sending…',
    forgot_email_placeholder: isAr ? 'you@example.com' : 'you@example.com',

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

function renderForgot(req, res, { info = null, error = null, submittedEmail = null } = {}) {
  const copy = authCopy(req);
  const { isAr } = copy;
  const lang = isAr ? 'ar' : 'en';
  setLangCookie(res, lang);
  return res.render('forgot_password', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', info, error, submittedEmail, lang, isAr, copy, _lang: lang });
}

function signUserToken(user) {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    lang: user.lang || 'en',
    country_code: user.country_code || null,
    // P0-FORM-1: phone is read by requirePhone() middleware. Embedded in
    // JWT so the gate doesn't require a per-request DB query (FIX #12).
    phone: user.phone || null,
    // P3-AUTH-1: specialty_id (doctors only) is read by doctor.js queue/
    // dashboard handlers to filter unassigned-pool cases by specialty.
    // Kept in lockstep with src/auth.js sign() — both must carry the
    // same field set, or refreshSessionCookie() rotations would silently
    // strip fields. Login query at line 210 uses SELECT * so the field
    // is always present on the user object.
    specialty_id: user.specialty_id || null
  };

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// Establishes the SAME authenticated web session as password login: the signed
// `tashkheesa_portal` JWT cookie. Used by POST /login and the web phone-OTP
// verify route so both paths produce a byte-identical session.
function establishWebSession(res, user) {
  res.cookie(SESSION_COOKIE, signUserToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
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

async function createMagicLoginToken(userId) {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [randomUUID(), userId, token, expiresAt, now.toISOString()]
  );
  return token;
}

async function sendMagicLoginLink({ user, req }) {
  if (!user || !user.id) return null;
  const token = await createMagicLoginToken(user.id);
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
    const user = await queryOne('SELECT * FROM users WHERE email = $1', [normalizedEmail]);

    if (!user) {
      const c = authCopy(req);
      return renderLogin(req, res, { error: c.login_invalid });
    }

    if (user.role === 'patient' && !user.password_hash) {
      await sendMagicLoginLink({ user, req });
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
        return res.redirect('/doctor/pending-approval');
      }
      if (!user.is_active) {
        const c = authCopy(req);
        return renderLogin(req, res, { error: c.login_doctor_inactive });
      }
    }

    // Create session (shared helper — the phone-OTP verify route uses the same one)
    establishWebSession(res, user);

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
// Phone-OTP login (web) — an ALTERNATIVE to email/password.
// Reuses the proven Twilio Verify service (src/services/twilio_verify.js) and
// establishes the SAME web session as password login (establishWebSession).
// Signup-by-phone: unknown numbers are created as patients via find-or-use-
// existing, race/constraint-safe under the users(phone) partial unique index
// (migration 069). These routes are under '/', so the global CSRF middleware
// applies — the browser sends the token via the `x-csrf-token` header.
// ============================================

// Normalize countryCode+phone to E.164 ONCE, up front, for both the handler and
// the per-phone rate-limit keys. Uses the same validatePhoneE164 the mobile
// /api/v1/auth/otp/verify path uses, so web and mobile store identical strings.
// Never rejects (anti-enumeration): an unparseable number still flows through
// and /request masks as success.
function parseOtpPhone(req, res, next) {
  const cc = String((req.body && req.body.countryCode) || '').trim();
  const ph = String((req.body && req.body.phone) || '').trim();
  const full = (cc + ph).replace(/\s+/g, '');
  const chk = validatePhoneE164(full, getReqLang(req));
  req.otpPhone = {
    normalized: chk.ok ? chk.normalized : null,
    key: chk.ok ? chk.normalized : ('raw:' + full.replace(/[^0-9]/g, '').slice(0, 18)),
  };
  return next();
}

const otpPhoneKey = (req) => (req.otpPhone && req.otpPhone.key) || 'unknown';
const otpRlMsg = { ok: false, error: 'too_many_requests' };

// Per-IP across the whole web OTP door (request + verify share this instance).
const otpIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, validate: false,
  standardHeaders: true, legacyHeaders: false, message: otpRlMsg,
});
// Per-phone: 60s cooldown between sends (server-authoritative; UI mirrors it).
const otpSendCooldown = rateLimit({
  windowMs: 60 * 1000, max: 1, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: { ok: false, error: 'cooldown' },
});
// Per-phone: cap total sends per window (SMS-cost / bombing guard).
const otpSendCap = rateLimit({
  windowMs: 15 * 60 * 1000, max: 3, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});
// Per-phone: cap verify attempts per window.
const otpVerifyCap = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, validate: false,
  standardHeaders: false, legacyHeaders: false,
  keyGenerator: otpPhoneKey, message: otpRlMsg,
});

// POST /login/otp/request — send a code via Twilio Verify.
// Anti-enumeration: ALWAYS returns { ok: true }, regardless of whether the
// number is registered or even valid, so the UI advances to code entry
// uniformly and reveals nothing about which numbers have accounts.
router.post('/login/otp/request', parseOtpPhone, otpIpLimiter, otpSendCooldown, otpSendCap, async (req, res) => {
  try {
    if (req.otpPhone.normalized) {
      await sendOtpViaTwilio(req.otpPhone.normalized);
    }
  } catch (err) {
    console.error('[otp/request] send failed:', err && err.message);
  }
  return res.json({ ok: true });
});

// POST /login/otp/verify — check the code, find-or-create the patient, and set
// the SAME session cookie as password login, then return the role-based redirect.
router.post('/login/otp/verify', parseOtpPhone, otpIpLimiter, otpVerifyCap, async (req, res) => {
  const c = authCopy(req);
  try {
    const otp = String((req.body && req.body.otp) || '').trim();
    if (!/^\d{6}$/.test(otp) || !req.otpPhone.normalized) {
      return res.status(400).json({ ok: false, error: c.otp_invalid });
    }
    const phone = req.otpPhone.normalized;

    const result = await verifyOtpCode(phone, otp);
    if (!result || !result.valid) {
      return res.status(401).json({ ok: false, error: c.otp_invalid });
    }
    // Twilio Verify owns its own state; clear any dev/fallback otp_codes row.
    try { await execute('DELETE FROM otp_codes WHERE phone = $1', [phone]); } catch (_) {}

    // Find-or-use-existing (signup-by-phone). The ON CONFLICT DO NOTHING + re-SELECT
    // is race/constraint-safe under the users(phone) WHERE phone IS NOT NULL
    // partial unique index (migration 069) — two concurrent verifies converge on
    // one row. Stores the SAME normalized E.164 string the mobile path stores.
    let user = await queryOne('SELECT * FROM users WHERE phone = $1', [phone]);
    if (!user) {
      await execute(
        // country_code='EG' (not just country) so signUserToken() embeds it in the JWT,
        // matching password-registered patients (FIX #12 — avoids a per-request lookup).
        `INSERT INTO users (id, phone, role, country, country_code, lang, created_at)
         VALUES ($1, $2, 'patient', 'EG', 'EG', $3, NOW())
         ON CONFLICT (phone) WHERE phone IS NOT NULL DO NOTHING`,
        [randomUUID(), phone, getReqLang(req)]
      );
      user = await queryOne('SELECT * FROM users WHERE phone = $1', [phone]);
    }
    if (!user) {
      return res.status(500).json({ ok: false, error: c.login_unexpected });
    }

    // Replay the SAME post-auth gates as password login.
    if (user.role === 'doctor') {
      if (user.pending_approval) return res.json({ ok: true, redirect: '/doctor/pending-approval' });
      if (!user.is_active) return res.status(403).json({ ok: false, error: c.login_doctor_inactive });
    }

    establishWebSession(res, user);
    setLangCookie(res, user.lang || getReqLang(req));

    if (user.role === 'patient' && !user.password_hash) {
      return res.json({ ok: true, redirect: '/set-password' });
    }
    const next = safeNextPath(req.body && req.body.next);
    return res.json({ ok: true, redirect: next || getHomeByRole(user.role) });
  } catch (err) {
    console.error('[otp/verify] error:', err && err.message);
    return res.status(500).json({ ok: false, error: c.login_unexpected });
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
router.post('/forgot-password', async (req, res) => {
  const email = (req.body && req.body.email ? req.body.email.trim().toLowerCase() : '');
  const user = email
    ? await queryOne("SELECT * FROM users WHERE email = $1 AND role IN ('patient', 'doctor') AND is_active = true", [email])
    : null;

  if (user) {
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
    await execute(
      `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [randomUUID(), user.id, token, expiresAt, now.toISOString()]
    );

    const baseUrl = getBaseUrl(req);
    const emailLang = (user.lang === 'ar' || getReqLang(req) === 'ar') ? 'ar' : 'en';
    const resetLink = baseUrl ? `${baseUrl}/reset-password/${token}?lang=${emailLang}` : null;

    // Security: do NOT print reset links in production logs.
    // In development, printing helps you test without email integration.
    if (!IS_PROD && resetLink) {
      // eslint-disable-next-line no-console
      console.log('[RESET LINK]', resetLink);
    }

    // Fire-and-forget — failures are logged but never surface to the user
    // (don't leak whether the email exists). The transporter is recipientGuard-wrapped.
    if (resetLink) {
      sendEmail({
        to: user.email,
        subject: emailLang === 'ar' ? 'إعادة تعيين كلمة مرور تشخيصة' : 'Reset your Tashkheesa password',
        template: 'password-reset',
        lang: emailLang,
        data: {
          patientName: user.name || (emailLang === 'ar' ? 'عميلنا العزيز' : 'there'),
          resetLink: resetLink,
          expiryHours: RESET_EXPIRY_HOURS
        }
      }).catch(function (err) {
        console.error('[forgot-password] email send failed:', err && err.message);
      });
    }
  }

  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  return renderForgot(req, res, { info: c.forgot_info, error: null, submittedEmail: email || null });
});

// ============================================
// GET /magic-login/:token
// ============================================
// P1-NOTIF-5: this route + /set-password (GET+POST) + /reset-password
// (GET+POST) all widened from `role = 'patient'` to
// `role IN ('patient', 'doctor')` so the doctor-approval welcome flow
// (admin clicks Approve → 7-day magic link emailed → doctor clicks →
// optional /set-password if no password_hash → portal session) works
// end-to-end. Token-binding to user_id is the security boundary; the
// role filter was redundant defense-in-depth. Without this widen, the
// new doctor magic-link flow + the existing admin-create-doctor
// reset-link flow at superadmin.js:2017+ both render "invalid token"
// for any doctor user.
router.get('/magic-login/:token', async (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = await findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return renderLogin(req, res, { error: c.login_invalid });
  }

  const user = await queryOne("SELECT * FROM users WHERE id = $1 AND role IN ('patient', 'doctor')", [tokenRow.user_id]);
  if (!user) {
    const c = authCopy(req);
    return renderLogin(req, res, { error: c.login_invalid });
  }

  const nowIso = new Date().toISOString();
  await execute(
    `UPDATE password_reset_tokens
     SET used_at = $1
     WHERE token = $2`,
    [nowIso, token]
  );

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

async function findValidToken(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT *
     FROM password_reset_tokens
     WHERE token = $1`,
    [token]
  );
  if (!row) return null;
  if (row.used_at) return null;
  if (!row.expires_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// ============================================
// GET /set-password
// ============================================
router.get('/set-password', async (req, res) => {
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';
  setLangCookie(res, lang);

  if (!req.user) return res.redirect('/login');

  const user = await queryOne("SELECT * FROM users WHERE id = $1 AND role IN ('patient', 'doctor')", [req.user.id]);
  if (!user) return res.redirect('/login');
  if (user.password_hash) return res.redirect(getHomeByRole(user.role));

  return res.render('set_password', { error: null, success: null, lang, _lang: lang, isAr: c.isAr, copy: c });
});

// ============================================
// POST /set-password
// ============================================
router.post('/set-password', async (req, res) => {
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';
  setLangCookie(res, lang);

  if (!req.user) return res.redirect('/login');

  const user = await queryOne("SELECT * FROM users WHERE id = $1 AND role IN ('patient', 'doctor')", [req.user.id]);
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
  const passwordHash = await hash(password);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users
       SET password_hash = $1, is_active = true
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = $1
       WHERE user_id = $2 AND used_at IS NULL`,
      [nowIso, user.id]
    );
  });

  return res.redirect(getHomeByRole(user.role));
});

// ============================================
// GET /reset-password/:token
// ============================================
router.get('/reset-password/:token', async (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = await findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }
  const user = await queryOne("SELECT * FROM users WHERE id = $1 AND role IN ('patient', 'doctor')", [tokenRow.user_id]);
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
router.post('/reset-password/:token', async (req, res) => {
  setLangCookie(res, getReqLang(req));
  const token = req.params.token;
  const tokenRow = await findValidToken(token);
  if (!tokenRow) {
    const c = authCopy(req);
    return res.render('reset_password_invalid', { lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, error: c.reset_pw_invalid, copy: c });
  }

  const user = await queryOne("SELECT * FROM users WHERE id = $1 AND role IN ('patient', 'doctor')", [tokenRow.user_id]);
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
  const passwordHash = await hash(password);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users
       SET password_hash = $1, is_active = true
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = $1
       WHERE token = $2`,
      [nowIso, token]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = $1
       WHERE user_id = $2 AND used_at IS NULL`,
      [nowIso, user.id]
    );
  });

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

// Side issue #74 — /signup 404'd today; the actual route is /register.
// 302 (temporary) so browsers don't cache if the canonical route ever moves.
router.get('/signup', (req, res) => res.redirect(302, '/register'));

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  var detectedCountry = res.locals.detectedCountry || 'EG';
  res.render('register', { error: null, form: { country_code: detectedCountry }, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
});

// ============================================
// POST /register
// ============================================
router.post('/register', async (req, res) => {
  /*
    Manual test:
    - GET /register -> country select is required; submitting without it shows error.
    - POST /register with invalid country_code -> error; name/email/country preserved.
    - POST /register with valid country_code -> user row has country_code; /login returns req.user.country_code.
  */
  const { name, email, password, country_code, phone } = req.body || {};
  const normalizedCountry = String(country_code || '').trim().toUpperCase();
  const form = { name, email, phone, country_code: normalizedCountry || '' };
  const c = authCopy(req);
  const langForMsg = c.isAr ? 'ar' : 'en';

  if (!email || !password || !name || !normalizedCountry) {
    return res
      .status(400)
      .render('register', { error: c.register_required, form, lang: langForMsg, _lang: langForMsg, isAr: c.isAr, copy: c });
  }

  if (!isLaunchMarket(normalizedCountry)) {   // LAUNCH GATE (src/launch-market.js): EG-only at launch
    return res
      .status(400)
      .render('register', { error: c.register_country_invalid, form, lang: langForMsg, _lang: langForMsg, isAr: c.isAr, copy: c });
  }

  // P0-FORM-1: phone required + E.164 enforced. Was optional with no
  // format check, which produced the 78%-no-phone + truncated-format
  // mess that broke WhatsApp lifecycle dispatch (P1-NOTIF-1).
  const { validatePhoneE164 } = require('../validators/phone');
  const phoneCheck = validatePhoneE164(phone, langForMsg);
  if (!phoneCheck.ok) {
    return res
      .status(400)
      .render('register', { error: phoneCheck.error, form, lang: langForMsg, _lang: langForMsg, isAr: c.isAr, copy: c });
  }
  const normalizedPhone = phoneCheck.normalized;

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const exists = await queryOne('SELECT 1 FROM users WHERE email = $1', [normalizedEmail]);
  if (exists) {
    return res
      .status(400)
      .render('register', { error: c.register_email_exists, form, lang: c.isAr ? 'ar' : 'en', _lang: c.isAr ? 'ar' : 'en', isAr: c.isAr, copy: c });
  }

  const id = randomUUID();
  const passwordHash = await hash(password);
  const lang = c.isAr ? 'ar' : 'en';

  try {
    await execute(`
      INSERT INTO users (id, email, password_hash, name, role, lang, country_code, phone, is_active, created_at)
      VALUES ($1, $2, $3, $4, 'patient', $5, $6, $7, true, $8)
    `, [id, normalizedEmail, passwordHash, name, lang, normalizedCountry, normalizedPhone, new Date().toISOString()]);
  } catch (dbErr) {
    console.error('[REGISTER] DB insert failed:', dbErr.message);
    return res.status(500).render('register', {
      error: c.isAr ? 'حدث خطأ أثناء إنشاء الحساب. حاول مرة أخرى.' : 'Error creating account. Please try again.',
      form,
      lang: c.isAr ? 'ar' : 'en',
      _lang: c.isAr ? 'ar' : 'en',
      isAr: c.isAr,
      copy: c
    });
  }

  const user = {
    id,
    email: normalizedEmail,
    password_hash: passwordHash,
    name,
    role: 'patient',
    lang: lang,
    country_code: normalizedCountry,
    phone: normalizedPhone   // P0-FORM-1: include phone so JWT carries it (gate clears immediately)
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
    // P1-NOTIF-4: warmed subject mirrors notification_titles.js
    // welcome_patient entry. Direct path (registration) bypasses the
    // worker, so the subject must be set inline here. Falls back to
    // the unwarmed form if name is missing — keeps the trailing
    // ", {patientName}" from rendering as "Welcome to Tashkheesa, ".
    var welcomeSubject = name && String(name).trim()
      ? (lang === 'ar' ? 'مرحباً بك في تشخيصة، ' + name : 'Welcome to Tashkheesa, ' + name)
      : (lang === 'ar' ? 'مرحباً بك في تشخيصة' : 'Welcome to Tashkheesa');
    sendEmail({
      to: normalizedEmail,
      subject: welcomeSubject,
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
// GET /doctor/login — warm-clinical doctor variant
// (POST still hits /login; same backend, just a doctor-tinted form)
// ============================================
router.get('/doctor/login', (req, res) => {
  if (req.user && req.user.role === 'doctor') return res.redirect('/portal/doctor/today');
  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';
  const next = req.query && req.query.next ? String(req.query.next) : '';
  return res.render('doctor_login_v2', {
    error: req.query && req.query.error ? String(req.query.error) : null,
    next,
    lang,
    _lang: lang,
    isAr: c.isAr,
    copy: c,
    brand: process.env.BRAND_NAME || 'Tashkheesa'
  });
});

// /portal/doctor/pending — friendly URL for warm-clinical pending-approval page
router.get('/portal/doctor/pending', (req, res) => {
  return res.redirect('/doctor/pending-approval');
});

// ============================================
// GET /doctor/signup
//
// Renders the 3-step doctor signup form. Pre-loads the specialty list +
// services-grouped-by-specialty so step 3 can render the services grid
// for the picked specialty without an extra round-trip.
// ============================================
router.get('/doctor/signup', async (req, res) => {
  if (req.user) return res.redirect('/');
  setLangCookie(res, getReqLang(req));

  const specialties = await queryAll(
    "SELECT id, name, name_ar FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC"
  );

  // Build services-by-specialty payload for the step-3 service-checkbox grid.
  // Pre-rendering all groups (and JS-toggling the picked one) avoids a second
  // round-trip when the doctor moves to step 3. Total payload is ~92 services
  // × ~50 chars ≈ 5KB — small enough to inline.
  const services = await queryAll(
    "SELECT id, name, specialty_id FROM services WHERE COALESCE(is_visible, true) = true ORDER BY specialty_id ASC, name ASC"
  );
  const servicesBySpecialty = specialties.map(function (sp) {
    return {
      specialtyId: sp.id,
      specialtyName: sp.name,
      specialtyNameAr: sp.name_ar || null,
      services: services
        .filter(function (sv) { return sv.specialty_id === sp.id; })
        .map(function (sv) { return { id: sv.id, name: sv.name }; })
    };
  });

  const c = authCopy(req);
  return res.render('doctor_signup', {
    cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
    error: null,
    specialties,
    servicesBySpecialty,
    form: {},
    lang: c.isAr ? 'ar' : 'en',
    _lang: c.isAr ? 'ar' : 'en',
    isAr: c.isAr,
    copy: c
  });
});

// ============================================
// POST /doctor/signup
//
// Validates the multi-step payload (synchronous shape checks + async DB
// FK checks), encrypts national_id with pgcrypto's pgp_sym_encrypt(),
// and inserts the doctor + their specialty + service preferences in a
// single transaction. Fails closed if NATIONAL_ID_ENCRYPTION_KEY is
// missing — never inserts NULL or plaintext for the encrypted column.
// ============================================
router.post('/doctor/signup', async (req, res) => {
  setLangCookie(res, getReqLang(req));
  const c = authCopy(req);
  const lang = c.isAr ? 'ar' : 'en';

  // Helper closure for the early-exit re-render path. Specialties +
  // servicesBySpecialty are loaded lazily and reused across error renders.
  let _specialtiesCache = null;
  let _servicesGroupedCache = null;
  async function loadSpecialtyData() {
    if (_specialtiesCache && _servicesGroupedCache) {
      return { specialties: _specialtiesCache, servicesBySpecialty: _servicesGroupedCache };
    }
    const sp = await queryAll(
      "SELECT id, name, name_ar FROM specialties WHERE COALESCE(is_visible, true) = true ORDER BY name ASC"
    );
    const svs = await queryAll(
      "SELECT id, name, specialty_id FROM services WHERE COALESCE(is_visible, true) = true ORDER BY specialty_id ASC, name ASC"
    );
    _specialtiesCache = sp;
    _servicesGroupedCache = sp.map(function (s) {
      return {
        specialtyId: s.id,
        specialtyName: s.name,
        specialtyNameAr: s.name_ar || null,
        services: svs.filter(function (sv) { return sv.specialty_id === s.id; })
                     .map(function (sv) { return { id: sv.id, name: sv.name }; })
      };
    });
    return { specialties: _specialtiesCache, servicesBySpecialty: _servicesGroupedCache };
  }

  function rerender(status, errorMsg, formValues) {
    return loadSpecialtyData().then(function (data) {
      return res.status(status).render('doctor_signup', {
        error: errorMsg,
        specialties: data.specialties,
        servicesBySpecialty: data.servicesBySpecialty,
        form: formValues || req.body || {},
        lang,
        _lang: lang,
        isAr: c.isAr,
        copy: c
      });
    });
  }

  // ─── 1. Encryption key precondition (fail-closed) ─────────────────
  // We refuse to proceed without the key — better to 500 than to write
  // NULL or, worse, silently fail-open and store plaintext.
  const encryptionKey = String(process.env.NATIONAL_ID_ENCRYPTION_KEY || '').trim();
  if (!encryptionKey) {
    logErrorToDb(new Error('NATIONAL_ID_ENCRYPTION_KEY missing'), {
      requestId: req.requestId,
      url: req.originalUrl,
      method: req.method,
      context: 'doctor_signup.config'
    });
    return res.status(500).type('text/plain').send(
      lang === 'ar'
        ? 'تعذّر إكمال الطلب — إعدادات الخادم غير مكتملة. الرجاء التواصل مع الدعم.'
        : 'Could not complete signup — server configuration incomplete. Please contact support.'
    );
  }

  // ─── 2. Synchronous validator (B10 matrix) ────────────────────────
  const { validateDoctorSignup } = require('../validators/doctor_signup');
  const v = validateDoctorSignup(req.body, lang);
  if (!v.ok) {
    return rerender(400, v.errors[0], v.normalized);
  }
  const n = v.normalized;

  // ─── 3. Async DB checks (email unique, FK existence) ──────────────
  const existing = await queryOne('SELECT 1 FROM users WHERE email = $1', [n.email]);
  if (existing) {
    return rerender(400, c.doctor_signup_email_exists, n);
  }

  const specialtyRow = await queryOne(
    'SELECT 1 FROM specialties WHERE id = $1 AND COALESCE(is_visible, true) = true',
    [n.specialty_id]
  );
  if (!specialtyRow) {
    return rerender(400, c.doctor_signup_specialty_invalid, n);
  }

  if (n.secondary_specialty_ids.length > 0) {
    const secRows = await queryAll(
      'SELECT id FROM specialties WHERE id = ANY($1::text[])',
      [n.secondary_specialty_ids]
    );
    if (secRows.length !== n.secondary_specialty_ids.length) {
      return rerender(400, c.doctor_signup_specialty_invalid, n);
    }
  }

  if (n.service_ids.length > 0) {
    const svcRows = await queryAll(
      'SELECT id FROM services WHERE id = ANY($1::text[]) AND specialty_id = $2',
      [n.service_ids, n.specialty_id]
    );
    const okIds = new Set(svcRows.map(function (r) { return r.id; }));
    const bogus = n.service_ids.filter(function (id) { return !okIds.has(id); });
    if (bogus.length > 0) {
      return rerender(
        400,
        lang === 'ar' ? 'بعض الخدمات المختارة لا تتبع التخصص الرئيسي.' : 'Some selected services do not belong to your primary specialty.',
        n
      );
    }
  }

  // ─── 4. Insert in a single transaction ─────────────────────────────
  const newDoctorId = randomUUID();
  const passwordHash = await hash(n.password);
  const nowIso = new Date().toISOString();

  try {
    await withTransaction(async (client) => {
      // 4a. users — main row, with national_id encrypted via pgp_sym_encrypt
      // at SQL parameter time. Plaintext is parameterized ($24), encryption
      // key is parameterized ($25) — neither value appears in the query
      // text so they don't land in pg_stat_statements or query logs.
      await client.query(
        `INSERT INTO users (
           id, email, password_hash, name, name_ar, role, specialty_id,
           phone, lang, country_code, date_of_birth, gender,
           bio, bio_ar,
           medical_license_number, license_country, medical_school,
           graduation_year, years_of_experience,
           sub_specialties, spoken_languages, affiliations, certifications,
           sla_tiers_supported,
           national_id_encrypted,
           pending_approval, is_active, onboarding_complete,
           created_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'doctor', $6,
           $7, $8, $9, $10, $11,
           $12, $13,
           $14, $15, $16,
           $17, $18,
           $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb,
           $23::jsonb,
           pgp_sym_encrypt($24, $25),
           true, false, true,
           $26
         )`,
        [
          newDoctorId, n.email, passwordHash, n.name, n.name_ar || null, n.specialty_id,
          n.phone, lang, n.country_code, n.date_of_birth || null, n.gender || null,
          n.bio || null, n.bio_ar || null,
          n.medical_license_number, n.license_country, n.medical_school,
          n.graduation_year, n.years_of_experience,
          JSON.stringify(n.sub_specialties),
          JSON.stringify(n.spoken_languages),
          JSON.stringify(n.affiliations),
          JSON.stringify(n.certifications),
          JSON.stringify(n.sla_tiers_supported),
          n.national_id, encryptionKey,
          nowIso
        ]
      );

      // 4b. doctor_specialties — primary first, then each secondary.
      const specRows = [n.specialty_id].concat(n.secondary_specialty_ids);
      for (const specId of specRows) {
        await client.query(
          `INSERT INTO doctor_specialties (id, doctor_id, specialty_id, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [randomUUID(), newDoctorId, specId]
        );
      }

      // 4c. doctor_services — every selected service id (validated above
      // to belong to the picked primary specialty). ON CONFLICT DO NOTHING
      // because the PK is (doctor_id, service_id); guards against the
      // submitted list having duplicates.
      for (const svcId of n.service_ids) {
        await client.query(
          `INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2)
           ON CONFLICT (doctor_id, service_id) DO NOTHING`,
          [newDoctorId, svcId]
        );
      }
    });
  } catch (err) {
    // The transaction rolled back; nothing was committed. Don't leak the
    // SQL error to the user — log it and re-render with a generic message.
    logErrorToDb(err, {
      requestId: req.requestId,
      url: req.originalUrl,
      method: req.method,
      context: 'doctor_signup.transaction'
    });
    return rerender(
      500,
      lang === 'ar' ? 'تعذّر إنشاء الحساب. حاول مرة أخرى أو تواصل مع الدعم.' : 'Could not create account. Please try again or contact support.',
      n
    );
  }

  // ─── 5. Notify a superadmin/admin (existing pattern) ───────────────
  const superadmin = await queryOne("SELECT id FROM users WHERE role = 'superadmin' ORDER BY created_at ASC LIMIT 1");
  const admin = await queryOne("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
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

  return res.render('doctor_signup_submitted', {
    lang, _lang: lang, isAr: c.isAr, copy: c
  });
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
