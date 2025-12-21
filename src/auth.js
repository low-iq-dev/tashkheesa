const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

function hash(password) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(password, salt);
}

function check(password, passwordHash) {
  return bcrypt.compareSync(password, passwordHash);
}

function sign(user) {
  const payload = {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    lang: user.lang || 'en'
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

module.exports = {
  hash,
  check,
  sign,
  verify,

  // middleware
  getTokenFromRequest,
  attachUser,
  requireAuth,
  requireRole,
  requireDoctor,
  requireAdmin,
  requireSuperadmin
};