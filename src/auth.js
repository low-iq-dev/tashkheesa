const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// P0-C FIX: Use async bcrypt — sync blocks the event loop ~100ms per call
async function hash(password) {
  return await bcrypt.hash(password, 10);
}

async function check(password, passwordHash) {
  return await bcrypt.compare(password, passwordHash);
}

function sign(user) {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    lang: user.lang || 'en',
    country_code: user.country_code || user.countryCode || null,
    // P0-FORM-1: phone is read by requirePhone() middleware to gate
    // patient access when missing. Embedded in JWT (not DB-fetched per
    // request) per the FIX #12 no-per-request-DB-query principle.
    // Routes that mutate users.phone MUST re-sign + reset the cookie.
    phone: user.phone || null
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
}

function verify(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// -----------------------------
// Centralized auth middleware
// -----------------------------

function getTokenFromRequest(req) {
  if (!req) return null;

  // Authorization: Bearer <token>
  const authz = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (authz && typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }

  // Cookie-based tokens (support common names)
  const c = req.cookies || {};

  // Prefer the configured session cookie name used by the portal
  const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
  if (c[sessionCookieName]) return c[sessionCookieName];

  return (
    c.token ||
    c.auth ||
    c.jwt ||
    c.access_token ||
    c.accessToken ||
    null
  );
}

// Attaches req.user when a valid JWT is present.
// Does NOT force login — safe to apply globally.
function attachUser(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    const payload = token ? verify(token) : null;
    if (payload && typeof payload === 'object') {
      req.user = payload;

      // Keep lang consistent across templates
      const lang = (payload.lang || (req.cookies && req.cookies.lang) || 'en').toString().toLowerCase() === 'ar' ? 'ar' : 'en';
      if (res && res.locals) res.locals.lang = lang;
    } else {
      // Fall back to cookie lang even if not logged in
      const lang = ((req.cookies && req.cookies.lang) || 'en').toString().toLowerCase() === 'ar' ? 'ar' : 'en';
      if (res && res.locals && !res.locals.lang) res.locals.lang = lang;
    }
  } catch (e) {
    // swallow — never block requests
  }
  return next();
}

function requireAuth(req, res, next) {
  if (req && req.user) return next();
  return res.redirect(302, '/login');
}

function requireRole(...roles) {
  const allowed = new Set((roles || []).flat().map(r => String(r).toLowerCase().trim()).filter(Boolean));
  return function (req, res, next) {
    if (!req || !req.user) return res.redirect(302, '/login');

    const role = String(req.user.role || req.user.user_type || req.user.type || '').toLowerCase().trim();
    if (!role) return res.status(403).send('Forbidden');

    // If no roles were provided, default to allow any authenticated user.
    if (allowed.size === 0) return next();

    if (allowed.has(role)) return next();

    return res.status(403).send('Forbidden');
  };
}

// Convenience guards
const requireDoctor = requireRole('doctor', 'admin', 'superadmin');
const requireAdmin = requireRole('admin', 'superadmin');
const requireSuperadmin = requireRole('superadmin');

// P0-FORM-1: re-issue the session cookie with a fresh JWT after a route
// mutates a payload field (currently used for `phone`, but suitable for
// any of the fields embedded in sign(): name, lang, country_code, phone).
// Without this, the next request still carries the old payload and the
// requirePhone() gate would re-fire after a successful save.
function refreshSessionCookie(res, user) {
  if (!res || !user) return;
  const token = sign(user);
  const isProd = process.env.NODE_ENV === 'production';
  const isStaging = process.env.RENDER_SERVICE_NAME && /staging/i.test(process.env.RENDER_SERVICE_NAME);
  const cookieName = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!(isProd || isStaging),
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

module.exports = {
  hash,
  check,
  sign,
  verify,
  refreshSessionCookie,

  // middleware
  getTokenFromRequest,
  attachUser,
  requireAuth,
  requireRole,
  requireDoctor,
  requireAdmin,
  requireSuperadmin
};