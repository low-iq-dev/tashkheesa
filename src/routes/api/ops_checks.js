/**
 * POST /api/v1/ops/checks — the check registry's write door (6 Oct 2026, watchtower).
 *
 * For machines, not people: the Mac mini, Tash, a cron job. Authenticated by a
 * shared bearer key, OPS_CHECKS_KEY, and nothing else.
 *
 *   FAIL CLOSED. With OPS_CHECKS_KEY unset the route answers 503 and reads
 *   nothing — no body, no header. An unset key must never mean "open".
 *
 *   CONSTANT TIME. Both sides are hashed to a fixed length before
 *   timingSafeEqual, so neither the comparison nor the length check leaks
 *   anything about the key.
 *
 *   RATE LIMITED, per IP, ahead of the key check — so guessing is limited too.
 *
 *   NOTHING SENSITIVE IS ECHOED OR LOGGED. The key is never returned or
 *   written anywhere; `detail` is stored and never logged.
 *
 * Writing a row is ALL this route does. Whether a status change is pushed is
 * decided by the system_checks worker from the row itself, so a check written
 * here and one written by plain SQL behave identically
 * (services/system_checks.js).
 *
 * Mounted in routes/api_v1.js ahead of the JWT gates. CSRF does not apply:
 * middleware/csrf.js exempts every /api/v1 path (no cookie is involved).
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

function keysMatch(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerOf(req) {
  const h = String(req.get('authorization') || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

module.exports = function (deps) {
  const router = express.Router();
  const d = deps || {};

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    validate: false,
    message: { success: false, error: 'Too many requests. Slow down.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/', function failClosed(req, res, next) {
    // Read per request, so setting or rotating the key needs no deploy.
    const expected = String(process.env.OPS_CHECKS_KEY || '').trim();
    if (!expected) {
      return res.fail('Check intake is not configured', 503, 'OPS_CHECKS_DISABLED');
    }
    req._opsChecksKey = expected;
    return next();
  }, limiter, async function (req, res) {
    const presented = bearerOf(req);
    if (!presented || !keysMatch(presented, req._opsChecksKey)) {
      return res.fail('Unauthorized', 401, 'UNAUTHORIZED');
    }

    const sc = d.systemChecks || require('../../services/system_checks');
    const v = sc.validateBody(req.body);
    if (!v.ok) {
      const body = { success: false, error: v.error, code: 'VALIDATION_FAILED' };
      if (v.errors) body.errors = v.errors;
      return res.status(400).json(body);
    }

    try {
      await sc.upsertChecks(v.checks);
    } catch (err) {
      // The message only — never the body, whose `detail` may carry anything.
      console.error('[ops/checks] write failed:', err && err.message);
      return res.fail('Could not record checks', 500, 'CHECKS_WRITE_FAILED');
    }
    return res.ok({
      accepted: v.checks.length,
      checks: v.checks.map(function (c) { return { check_key: c.check_key, status: c.status }; }),
    });
  });

  return router;
};

module.exports.keysMatch = keysMatch;
