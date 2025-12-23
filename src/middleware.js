const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { verify } = require('./auth');
const { t: translate } = require('./i18n');
const dayjs = require('dayjs');
require('dotenv').config();

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

function baseMiddlewares(app) {
  app.use(helmet());
  app.use(cookieParser());
  app.use(require('express').urlencoded({ extended: true }));
  app.use(require('express').json());

  // Rate limiter
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Stricter rate limits for auth endpoints (brute-force protection)
  // Applies to both GET+POST on these paths (cheap + safe), but primarily protects POST attempts.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many attempts. Please wait 15 minutes and try again.'
  });

  // Covers: /login, /forgot-password, /reset-password/:token
  app.use(['/login', '/forgot-password', '/reset-password'], authLimiter);

  // Attach user + language to locals
  app.use((req, res, next) => {
    const token = req.cookies[SESSION_COOKIE];
    let user = null;

    if (token) user = verify(token);
    req.user = user || null;

    const normalizeLang = (v) => (String(v || '').toLowerCase() === 'ar' ? 'ar' : 'en');

    // Priority: explicit ?lang= > session > cookie > default
    const lang = normalizeLang(
      (req.query && req.query.lang) ||
      (req.session && req.session.lang) ||
      (req.cookies && req.cookies.lang) ||
      'en'
    );

    // Keep session in sync if sessions are enabled
    if (req.session) req.session.lang = lang;

    res.locals.lang = lang;
    res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
    res.locals.user = user;
    res.locals.brand = process.env.BRAND_NAME || 'Tashkheesa';
    res.locals.formatEventDate = (iso) => {
      if (!iso) return '';
      const d = dayjs(iso);
      if (!d.isValid()) return '';
      return d.format('DD/MM/YYYY — hh:mm A');
    };
    res.locals.t = (key) => translate(key, lang);
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

    return next();
  };
}

module.exports = {
  baseMiddlewares,
  requireAuth,
  requireRole
};
