'use strict';

// src/middleware/api_rate_limits.js
//
// The /api/v1 rate limiters, in one place so they can be exercised without
// booting the server (tests/core/api-rate-limits.test.js). Mounted by
// src/routes/api_v1.js.
//
// 2026-10-11 — what changed and why. On 7 Oct the patient app showed
// "Request failed (status 429)" on Home and Messages, a "No internet" pill
// while online, and could not load the profile. Three separate causes:
//
//   1. The app-wide limiter in src/middleware.js (100 / minute / IP) sits in
//      front of /api/v1 and answers in plain text, which is what the app
//      printed as "Request failed (status 429)". It now skips /api/v1; this
//      file is the API's whole budget.
//   2. Every "per IP" key was an edge address, not the caller (see
//      ./client_ip.js). All keys here go through clientIpKey().
//   3. POST /auth/refresh shared the 20-per-15-minutes sign-in bucket. Access
//      tokens live 15 minutes, so every open app spends one refresh per
//      window: twenty patients behind one carrier address filled the bucket
//      with no one typing a password, and the twenty-first could neither
//      refresh nor sign in. Refresh and sign-out now have their own budget,
//      keyed on the token being presented.
//
// Brute-force protection is tighter, not looser: the sign-in bucket is keyed on
// the real address, wrong passwords are now also counted per ACCOUNT, and the
// per-phone OTP caps (./otp_phone_limits.js) are untouched.

const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { clientIpKey } = require('./client_ip');

const WINDOW_MS = 15 * 60 * 1000;

const RATE_LIMITED_BODY = { success: false, error: 'Too many requests. Slow down.', code: 'RATE_LIMITED' };
const AUTH_LIMITED_BODY = { success: false, error: 'Too many attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

const bearerOf = (req) => {
  const h = String((req.headers && req.headers.authorization) || '');
  return /^Bearer\s+\S{20,}/i.test(h) ? h.slice(7).trim() : '';
};

/**
 * 429 as JSON, always with Retry-After. express-rate-limit only sets that
 * header when one of its own header families is on, and the app's wait-and-
 * retry needs it from every limiter here.
 */
function jsonLimitHandler(body) {
  return (req, res) => {
    if (!res.getHeader('Retry-After')) {
      const reset = req.rateLimit && req.rateLimit.resetTime;
      const secs = reset ? Math.ceil((reset.getTime() - Date.now()) / 1000) : Math.ceil(WINDOW_MS / 1000);
      res.setHeader('Retry-After', String(Math.max(1, secs)));
    }
    return res.status(429).json(body);
  };
}

function buildApiLimiters() {
  // Abuse backstop per address. Also bounds anyone minting throwaway
  // Authorization headers to collect fresh per-token buckets.
  const ipCeilingLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 3000,
    validate: false,
    keyGenerator: (req) => 'ip:' + clientIpKey(req),
    handler: jsonLimitHandler(RATE_LIMITED_BODY),
    standardHeaders: false,
    legacyHeaders: false,
  });

  // Per signed-in caller: 600 (40/min sustained). Anonymous, per address: 300.
  const callerLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: (req) => (bearerOf(req) ? 600 : 300),
    validate: false,
    keyGenerator: (req) => {
      const t = bearerOf(req);
      return t ? 'tok:' + sha(t) : 'ip:' + clientIpKey(req);
    },
    handler: jsonLimitHandler(RATE_LIMITED_BODY),
    standardHeaders: true,
    legacyHeaders: false,
  });

  const apiLimiter = (req, res, next) =>
    ipCeilingLimiter(req, res, (err) => (err ? next(err) : callerLimiter(req, res, next)));

  // Token maintenance is not a sign-in attempt. Mounted on /auth, /admin/auth
  // and /doctor/auth, where req.path is relative to the mount.
  const isTokenMaintenance = (req) =>
    req.method === 'POST' && (req.path === '/refresh' || req.path === '/logout');

  // Sign-in, sign-up, OTP and password-reset attempts, per address. Unchanged
  // at 20 / 15 min; it now counts the caller rather than an edge address, and
  // no longer counts refresh or sign-out.
  const authLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 20,
    validate: false,
    keyGenerator: (req) => 'ip:' + clientIpKey(req),
    skip: isTokenMaintenance,
    handler: jsonLimitHandler(AUTH_LIMITED_BODY),
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Refresh / sign-out. Keyed on the refresh token presented, so patients who
  // share a carrier address do not share a bucket. A token rotates on every
  // successful refresh, so one key only ever sees retries of one token; a
  // forged token fails its signature check before any database work. Requests
  // with no usable token fall back to the address. The anonymous per-address
  // bucket in apiLimiter (300) still sits in front of this.
  const tokenLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: (req) => (refreshKey(req) ? 20 : 60),
    validate: false,
    keyGenerator: (req) => refreshKey(req) || 'ip:' + clientIpKey(req),
    skip: (req) => !isTokenMaintenance(req),
    handler: jsonLimitHandler(RATE_LIMITED_BODY),
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Wrong passwords per ACCOUNT (patient door). Ten failures in 15 minutes
  // lock that e-mail's password door for the rest of the window, whatever
  // address they came from — a botnet no longer gets 20 guesses per address
  // against one patient. Successful sign-ins are not counted. The phone-code
  // door is separate (5 verifies / 15 min per phone), so a patient locked out
  // here by someone else's guessing can still sign in with a code.
  const loginAccountLimiter = rateLimit({
    windowMs: WINDOW_MS,
    max: 10,
    validate: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const email = accountEmail(req.body && req.body.email);
      return email ? 'acct:' + sha(email) : 'ip:' + clientIpKey(req);
    },
    handler: jsonLimitHandler(AUTH_LIMITED_BODY),
    standardHeaders: false,
    legacyHeaders: false,
  });

  return { apiLimiter, authLimiter, tokenLimiter, loginAccountLimiter };
}

// The same normalisation the sign-in handler applies (express-validator's
// normalizeEmail), so "V.ictim+x@Gmail.com" and "victim@gmail.com" — one
// account — are one key and not a way to collect extra guesses.
let normalizeEmail = null;
try { normalizeEmail = require('validator').normalizeEmail; } catch (_) { /* fall back to lower-case */ }
function accountEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s.indexOf('@') < 1) return '';
  const n = normalizeEmail ? normalizeEmail(s) : s;
  return n || s;
}

function refreshKey(req) {
  const t = req.body && req.body.refreshToken;
  if (typeof t === 'string' && t.length >= 20) return 'rt:' + sha(t);
  // Sign-out authenticates with the access token.
  const b = bearerOf(req);
  return b ? 'tok:' + sha(b) : '';
}

module.exports = { buildApiLimiters, jsonLimitHandler, RATE_LIMITED_BODY, AUTH_LIMITED_BODY };
