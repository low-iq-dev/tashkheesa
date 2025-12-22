// src/routes/auth.js
const express = require('express');
const { db } = require('../db');
const { hash, check, sign } = require('../auth');
const { randomUUID } = require('crypto');
const { queueNotification } = require('../notify');
require('dotenv').config();

const NODE_ENV = String(process.env.NODE_ENV || '').toLowerCase();
const MODE = String(process.env.MODE || NODE_ENV || 'development').toLowerCase();
const IS_PROD = NODE_ENV === 'production' || MODE === 'production';
const IS_STAGING = MODE === 'staging';
const COOKIE_SECURE = IS_PROD || IS_STAGING;

const router = express.Router();
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
const RESET_EXPIRY_HOURS = 2;

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
  // Pass through next if present (view may ignore; POST handler also reads query)
  const next = safeNextPath(req.query && req.query.next);
  res.render('login', { error: null, next });
});

// ============================================
// POST /login
// ============================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.render('login', { error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(normalizedEmail);

    if (!user) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    const ok = await check(password, user.password_hash);
    if (!ok) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    if (user.role === 'doctor') {
      if (user.pending_approval) {
        return res.render('login', { error: 'Your application is still under review.' });
      }
      if (!user.is_active) {
        return res.render('login', { error: 'Your account is inactive. Contact support.' });
      }
    }

    // Create session
    const token = sign(user);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Safe next redirect (same-site only)
    const next = safeNextPath((req.body && req.body.next) || (req.query && req.query.next));
    if (next) return res.redirect(next);

    // Role-based redirects
    return res.redirect(getHomeByRole(user.role));
  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', {
      error: 'Unexpected error during login. Please try again.'
    });
  }
});

// ============================================
// GET /forgot-password
// ============================================
router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('forgot_password', { info: null, error: null });
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
    const resetLink = baseUrl ? `${baseUrl}/reset-password/${token}` : null;
    if (!IS_PROD && resetLink) {
      // eslint-disable-next-line no-console
      console.log('[RESET LINK]', resetLink);
    }
  }

  return res.render('forgot_password', {
    info: 'If an account exists for this email, you will receive a reset link.',
    error: null
  });
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
// GET /reset-password/:token
// ============================================
router.get('/reset-password/:token', (req, res) => {
  const token = req.params.token;
  const tokenRow = findValidToken(token);
  if (!tokenRow) {
    return res.render('reset_password_invalid');
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(tokenRow.user_id);
  if (!user) {
    return res.render('reset_password_invalid');
  }
  return res.render('reset_password', { token, error: null, success: null });
});

// ============================================
// POST /reset-password/:token
// ============================================
router.post('/reset-password/:token', (req, res) => {
  const token = req.params.token;
  const tokenRow = findValidToken(token);
  if (!tokenRow) {
    return res.render('reset_password_invalid');
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(tokenRow.user_id);
  if (!user) {
    return res.render('reset_password_invalid');
  }

  const password = (req.body && req.body.password) || '';
  const confirm = (req.body && req.body.confirm_password) || '';
  if (password.length < 8 || password !== confirm) {
    return res.status(400).render('reset_password', {
      token,
      error: 'Passwords must match and be at least 8 characters.',
      success: null
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

  return res.render('reset_password', {
    token: null,
    error: null,
    success: 'Password reset successful. Please log in.'
  });
});

// ============================================
// GET /register (patient signup)
// ============================================
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { error: null });
});

// ============================================
// POST /register
// ============================================
router.post('/register', (req, res) => {
  const { name, email, password } = req.body || {};

  if (!email || !password || !name) {
    return res
      .status(400)
      .render('register', { error: 'All fields are required.' });
  }

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) {
    return res
      .status(400)
      .render('register', { error: 'Email already registered.' });
  }

  const id = randomUUID();
  const passwordHash = hash(password);

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, lang)
    VALUES (?, ?, ?, ?, 'patient', 'en')
  `).run(id, email, passwordHash, name);

  const user = {
    id,
    email,
    password_hash: passwordHash,
    name,
    role: 'patient',
    lang: 'en',
  };

  const token = sign(user);

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.redirect('/dashboard');
});

// ============================================
// GET /doctor/signup
// ============================================
router.get('/doctor/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  res.render('doctor_signup', { error: null, specialties, form: {} });
});

// ============================================
// POST /doctor/signup
// ============================================
router.post('/doctor/signup', (req, res) => {
  const { name, email, password, specialty_id, phone, notes } = req.body || {};

  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();

  if (!name || !email || !password || !specialty_id) {
    return res.status(400).render('doctor_signup', {
      error: 'Please fill all required fields.',
      specialties,
      form: req.body || {}
    });
  }

  if (password.length < 6) {
    return res.status(400).render('doctor_signup', {
      error: 'Password must be at least 6 characters.',
      specialties,
      form: req.body || {}
    });
  }

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (exists) {
    return res.status(400).render('doctor_signup', {
      error: 'Email already registered.',
      specialties,
      form: req.body || {}
    });
  }

  const specialtyValid = db.prepare('SELECT 1 FROM specialties WHERE id = ?').get(specialty_id);
  if (!specialtyValid) {
    return res.status(400).render('doctor_signup', {
      error: 'Please select a valid specialty.',
      specialties,
      form: req.body || {}
    });
  }

  const id = randomUUID();
  const passwordHash = hash(password);
  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, pending_approval, is_active, approved_at, rejection_reason, signup_notes, created_at)
     VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', 1, 0, NULL, NULL, ?, ?)`
  ).run(id, email.trim().toLowerCase(), passwordHash, name, specialty_id, phone || null, notes || null, nowIso);

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

  return res.render('doctor_signup_submitted');
});

// ============================================
// GET /logout (safe browser logout button)
// ============================================
router.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect('/login');
});

// ============================================
// POST /logout (form submissions)
// ============================================
router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.redirect('/login');
});

module.exports = router;
