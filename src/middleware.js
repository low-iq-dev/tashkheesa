const { addNonceMiddleware } = require('./middleware-nonce-fix');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { verify } = require('./auth');
const { t: translate } = require('./i18n');
const { normalizeLang, getDir } = require('./utils/lang');
const fmt = require('./utils/formatNumber');
const dayjs = require('dayjs');
require('dotenv').config();

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

function baseMiddlewares(app) {
  // Helmet (CSP configured to allow Uploadcare widget + CDN assets)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // Keep defaults, but allow Uploadcare scripts/styles/assets
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://ucarecdn.com',
            'https://uploadcare.com',
            'https://media.twiliocdn.com', '/js/availability-form.js', '/js/booking-form.js'
          ],
          'style-src': [
            "'self'",
            "'unsafe-inline'",
            'https://ucarecdn.com',
            'https://uploadcare.com'
          ],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://ucarecdn.com'
          ],
          'font-src': [
            "'self'",
            'data:',
            'https://ucarecdn.com'
          ],
          'connect-src': [
            "'self'",
            'https://upload.uploadcare.com',
            'https://api.uploadcare.com',
            'https://ucarecdn.com',
            'wss://*.twilio.com',
            'https://*.twilio.com'
          ],
          'media-src': [
            "'self'",
            'blob:'
          ],
          'frame-src': [
            "'self'",
            'https://uploadcare.com',
            'https://ucarecdn.com'
          ],
          'worker-src': [
            "'self'",
            'blob:'
          ]
        }
      },
      // Avoid blocking third-party resources used by widgets/CDNs
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(cookieParser());
  app.use(require('express').urlencoded({ extended: true, limit: '1mb' }));
  app.use(require('express').json({ limit: '1mb' }));

  // Rate limiter
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Stricter rate limits for auth endpoints (brute-force protection)
  // Applies to both GET+POST on these paths (cheap + safe), but primarily protects POST attempts.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // per IP per window
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many attempts. Please wait 15 minutes and try again.'
  });

  // Covers: /login, /forgot-password, /reset-password/:token
  app.use(['/login', '/forgot-password', '/reset-password'], authLimiter);

  // === PHASE 2: FIX #9 - RATE LIMITING FOR SENSITIVE ENDPOINTS ===
  // Rate limit file downloads to prevent bandwidth abuse
  const fileDownloadLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 50, // 50 downloads per minute per IP
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many download requests. Please wait a moment and try again.',
    skip: (req) => {
      // Skip rate limiting for health checks and assets
      const p = req.path || '';
      return p.startsWith('/health') || p.startsWith('/public') || p.startsWith('/assets');
    }
  });
  app.use('/files', fileDownloadLimiter);

  // Rate limit internal/admin endpoints to prevent DoS
  const internalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute per IP
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests to internal endpoints. Please try again later.'
  });
  app.use('/internal', internalLimiter);
  app.use('/verify', internalLimiter);

  // Rate limit case submission — prevents queue flooding (5 per 15 min per IP)
  const newCaseLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many case submissions. Please wait 15 minutes and try again.'
  });
  app.use('/portal/patient/new-case', newCaseLimiter);
  app.use('/patient/new-case', newCaseLimiter);

  // Rate limit payment callbacks — Paymob fires one webhook per payment; cap at 20/min per IP
  const paymentCallbackLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many payment callback requests.'
  });
  app.use('/callback', paymentCallbackLimiter);
  app.use('/portal/video/payment/callback', paymentCallbackLimiter);

  // Rate limit referral endpoints — prevents brute-force code enumeration (10/min per IP)
  const referralLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many referral requests. Please wait a moment and try again.'
  });
  app.use('/api/referral', referralLimiter);

  // P1-A FIX: Rate limit doctor signup and pre-launch interest (no limit existed before)
  app.use('/doctor/signup', authLimiter);
  app.use('/api/pre-launch-interest', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many submissions. Please wait 15 minutes and try again.'
  }));

  // Public website intake (marketing landing page → /api/cases/intake).
  // CSRF-exempt at src/middleware/csrf.js because the caller is cross-origin
  // and cannot read the httpOnly csrf_token cookie. Rate-limit-then-fail-closed
  // is the abuse defense. Per OQ-1 the HMAC option is deferred — revisit when
  // a third-party caller is exposed.
  app.use('/api/cases', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many case submissions. Please wait 15 minutes and try again.'
  }));

  // App waitlist — 10 submissions per IP per hour
  app.use('/app/waitlist', rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    validate: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many waitlist submissions. Please try again later.'
  }));

  // Attach user + language to locals
  app.use((req, res, next) => {
    const token = req.cookies[SESSION_COOKIE];
    let user = null;

    if (token) user = verify(token);
    req.user = user || null;

    // === PHASE 3: FIX #11 - USE CENTRALIZED LANGUAGE NORMALIZATION ===
    // Priority: explicit ?lang= > session > cookie > default
    const lang = normalizeLang(
      (req.query && req.query.lang) ||
      (req.session && req.session.lang) ||
      (req.cookies && req.cookies.lang) ||
      'en'
    );

    // Keep session in sync if sessions are enabled
    if (req.session) req.session.lang = lang;

    // Persist ?lang= query param as cookie so it sticks across pages
    if (req.query && req.query.lang) {
      res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: false });
    }

    res.locals.lang = lang;
    res.locals.dir = getDir(lang);
    res.locals.user = user;
    res.locals.brand = process.env.BRAND_NAME || 'Tashkheesa';
    res.locals.formatEventDate = (iso) => {
      if (!iso) return '';
      const d = dayjs(iso);
      if (!d.isValid()) return '';
      return d.format('DD/MM/YYYY — hh:mm A');
    };
    // Theme 10b Sub-issue C — locale-aware helpers (OQ-2 hybrid policy).
    res.locals.formatNumber   = (n, opts)           => fmt.formatNumber(n, lang, opts);
    res.locals.formatMoney    = (amount, currency)  => fmt.formatMoney(amount, currency, lang);
    res.locals.formatDate     = (iso, opts)         => fmt.formatDate(iso, lang, opts);
    res.locals.formatDateTime = (iso, opts)         => fmt.formatDateTime(iso, lang, opts);
    res.locals.t = (key) => translate(key, lang);

    // Canonical translation helper: tt(key, enFallback, arFallback).
    // Single source of truth per Theme 10 §4.B. Lookup order:
    //   1. If `key` resolves in src/i18n.js catalog for the active locale,
    //      return the catalog value.
    //   2. Otherwise return `enFallback` (EN mode) or `arFallback` (AR mode).
    //   3. If both fallbacks are missing, return the trimmed key, then ''.
    // Contract: never throws, never returns undefined.
    //
    // NOTE on legacy 2-arg call sites (`tt(enText, arText)`): these predate
    // the canonical signature. They render the same way as the prior fallback
    // implementation in server.js (preserved verbatim here). They are
    // tracked as Phase 2 migration debt in
    // docs/audits/THEME_10_VIEW_INVENTORY.md.
    res.locals.tt = function (key, enFallback, arFallback) {
      const isAr = lang === 'ar';
      // Trim at the entry point: src/i18n.js#t also trims keys before lookup,
      // so without this, a key with edge whitespace (common when migration
      // promotes an EN string to a key) would catalog-miss and i18n.t() would
      // return the *trimmed* key — which differs from `k` and would be
      // mistakenly treated as a catalog hit, returning the EN string in AR
      // mode. Trimming `k` here keeps the comparison consistent.
      const k = (typeof key === 'string') ? key.trim() : '';
      if (k) {
        const fromCatalog = translate(k, lang);
        if (fromCatalog && fromCatalog !== k) return fromCatalog;
      }
      if (isAr) return arFallback || enFallback || k || '';
      return enFallback || k || '';
    };

    next();
  });
}

function requireAuth() {
  return (req, res, next) => {
    if (req.user) return next();
    const nextUrl = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(`/login?next=${nextUrl}`);
  };
}

// Backwards compatible:
// - requireRole('patient') works
// - requireRole('admin','superadmin') works
// - requireRole(['admin','superadmin']) works
function requireRole(...roles) {
  // Flatten + normalize
  const allowed = roles
    .flat()
    .filter(Boolean)
    .map((r) => String(r).toLowerCase());

  return (req, res, next) => {
    if (!req.user) {
      const nextUrl = encodeURIComponent(req.originalUrl || req.url || '/');
      return res.redirect(`/login?next=${nextUrl}`);
    }

    if (allowed.length === 0) return next();

    const role = String(req.user.role || '').toLowerCase();
    if (!allowed.includes(role)) {
      return res.status(403).type('text/plain').send('Forbidden');
    }

    // === PHASE 3: FIX #12 - MOVED PASSWORD CHECK TO LOGIN ONLY ===
    // Removed per-request DB query for patient password_hash check.
    // This check now happens only in auth.js login flow (not on every request).
    // If a patient somehow gets a token without a password, the /set-password
    // route will catch them. Eliminates 1000s of unnecessary DB queries.

    return next();
  };
}

module.exports = {
  baseMiddlewares,
  requireAuth,
  requireRole
};
