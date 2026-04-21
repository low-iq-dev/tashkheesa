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

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
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
 */
function generateTokens(user) {
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return { accessToken, refreshToken };
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
  verifyRefreshToken,
  JWT_SECRET,
};
