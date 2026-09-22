/**
 * JWT Authentication Middleware
 *
 * Verifies the Bearer token from the Authorization header.
 * Used for all /api/v1/ routes except auth endpoints.
 *
 * Expects: Authorization: Bearer <token>
 * Sets:    req.user = { id, email, role, ... }
 */

const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

// Single source of truth for JWT signing/verification. The previous SESSION_SECRET
// fallback was removed in Theme 4 Sub-issue C — it was undocumented, masked by
// the validateCriticalEnvVars IIFE in src/server.js (which exits boot when
// JWT_SECRET is unset, so the fallback was already dead code), and inconsistent
// with src/auth.js / src/routes/auth.js / src/routes/ops.js which all read
// JWT_SECRET directly. The IIFE remains the canonical boot guard; this throw is
// a defence-in-depth backstop in case this module is loaded from a context that
// bypasses server.js.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not set');

/**
 * Verify JWT and attach user to request.
 * Returns 401 if token is missing/invalid/expired.
 */
function requireJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.fail('Authentication required', 401, 'AUTH_REQUIRED');
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // A4 (AUDIT 2026-09-09) — refuse a token minted BEFORE the account's
    // revocation cut (deactivate / reject / password change). Fail-open cache
    // (src/services/access_revocation) — a lookup that cannot run never blocks a
    // valid session.
    try {
      if (require('../services/access_revocation').isTokenStale(decoded.id, decoded.iat)) {
        return res.fail('Session revoked', 401, 'TOKEN_REVOKED');
      }
    } catch (_) { /* fail open */ }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.fail('Token expired', 401, 'TOKEN_EXPIRED');
    }
    return res.fail('Invalid token', 401, 'INVALID_TOKEN');
  }
}

/**
 * Require a specific role (used after requireJWT).
 * For the patient app, this is always 'patient'.
 */
function requireRole(role) {
  return function (req, res, next) {
    if (!req.user) {
      return res.fail('Authentication required', 401, 'AUTH_REQUIRED');
    }
    if (req.user.role !== role) {
      return res.fail('Access denied', 403, 'FORBIDDEN');
    }
    next();
  };
}

/**
 * Generate access + refresh token pair.
 *
 * C1 (Batch C, 2026-09-22): `sessionId` — when given, both tokens carry it as
 * the `sid` claim. Refresh/logout/push-registration use it to target the
 * DEVICE the token belongs to (user_sessions row, migration 110). It also
 * makes two same-second token pairs for one user distinct strings, which the
 * unique user_sessions.refresh_token index relies on. Omitting it (older
 * call sites, tests) mints a sid-less pair — those are treated as 'legacy'
 * sessions by the consumers.
 */
function generateTokens(user, sessionId) {
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      ...(sessionId ? { sid: sessionId } : {}),
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  // `jti` — a JWT signs the same claims to the same string, so two mints in
  // the same second (a refresh right after sign-in) used to produce an
  // IDENTICAL refresh token: "rotation" then rotated a token onto itself and
  // the old string stayed valid. A per-mint jti makes every refresh token a
  // distinct string, which the unique user_sessions.refresh_token index and
  // the rotation contract both rely on.
  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh', jti: randomUUID(), ...(sessionId ? { sid: sessionId } : {}) },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
}

/**
 * Generate a SHORT-LIVED access + refresh token pair for the superadmin
 * Command app. Access TTL matches the patient app (15m); the refresh TTL is
 * deliberately tighter (12h vs the patient 30d) — biometric-on-resume is the
 * real second factor, and there is no "remember me" for the keys-to-the-castle
 * account. See docs/COMMAND_APP_PHASE0_AUDIT.md §2 (decision 2).
 */
function generateAdminTokens(user, sessionId) {
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      ...(sessionId ? { sid: sessionId } : {}),
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  // Same per-mint jti as generateTokens — see the comment there.
  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh', jti: randomUUID(), ...(sessionId ? { sid: sessionId } : {}) },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  return { accessToken, refreshToken };
}

/**
 * C2 (Batch C, 2026-09-22): doctor token pair — access 15m like everyone,
 * refresh 12h like the superadmin Command app, NOT the patient 30d. A doctor
 * session carries other people's medical records; the brief's decision is the
 * tight lifetime. Shape is otherwise identical to generateAdminTokens (same
 * `sid` semantics as generateTokens above).
 */
function generateDoctorTokens(user, sessionId) {
  return generateAdminTokens(user, sessionId);
}

/**
 * Verify a refresh token.
 * Returns decoded payload or null.
 */
function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'refresh') return null;
    return decoded;
  } catch {
    return null;
  }
}

module.exports = {
  requireJWT,
  requireRole,
  generateTokens,
  generateAdminTokens,
  generateDoctorTokens,
  verifyRefreshToken,
  JWT_SECRET,
};
