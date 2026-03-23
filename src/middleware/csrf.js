// src/middleware/csrf.js
// CSRF token generation, validation, and middleware.

var { randomBytes } = require('crypto');
var path = require('path');
var { major: logMajor } = require('../logger');

var EXEMPT_PATHS = new Set(['/health', '/status', '/healthz', '/__version']);
var ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.map'
]);

function isAssetRequest(reqPath) {
  if (!reqPath) return false;
  if (reqPath.startsWith('/public/') || reqPath.startsWith('/assets/')) return true;
  if (reqPath === '/favicon.ico') return true;
  var ext = path.extname(reqPath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function setupCsrf(app, opts) {
  var MODE = opts.MODE;
  var COOKIE_SECURE = opts.COOKIE_SECURE;
  var COOKIE_SAMESITE = opts.COOKIE_SAMESITE;

  var CSRF_MODE = String(process.env.CSRF_MODE || (MODE === 'production' || MODE === 'staging' ? 'enforce' : 'log'))
    .trim()
    .toLowerCase();
  var CSRF_COOKIE = 'csrf_token';

  function ensureCsrfCookie(req, res) {
    var existing = req.cookies && req.cookies[CSRF_COOKIE];
    if (existing && String(existing).length >= 16) return String(existing);
    var token = randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: COOKIE_SAMESITE,
      secure: COOKIE_SECURE,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return token;
  }

  function isSafeMethod(m) {
    return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  }

  function readCsrfToken(req) {
    var h = req.get('x-csrf-token');
    if (h && String(h).trim()) return String(h).trim();
    var b = req.body && (req.body._csrf || req.body.csrf);
    if (b && String(b).trim()) return String(b).trim();
    return '';
  }

  function csrfFail(req, res) {
    var requestId = req.requestId;
    var wantsJson = (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(403).json({ ok: false, error: 'CSRF', requestId: requestId });
    }
    return res.status(403).type('text/plain').send('Forbidden (CSRF). requestId=' + requestId);
  }

  app.use(function(req, res, next) {
    if (CSRF_MODE === 'off') {
      if (res && res.locals) {
        res.locals.csrfToken = null;
        res.locals.csrfField = function() { return ''; };
      }
      return next();
    }

    var p = req.path || '';
    if (EXEMPT_PATHS.has(p) || isAssetRequest(p)) {
      return next();
    }
    if (p === '/callback' || p.startsWith('/portal/video/payment/callback') || p.startsWith('/payments/webhook')) {
      return next();
    }
    if (p.startsWith('/ops/agent/')) {
      return next();
    }
    if (
      p === '/ops/login' ||
      p.startsWith('/ops/errors/') ||
      p === '/ops/agent/toggle' ||
      p === '/ops/agent/status' ||
      p === '/ops/agent/ping' ||
      p === '/ops/agent/log-tokens' ||
      p === '/ops/agent/cleanup'
    ) {
      return next();
    }

    var cookieToken = ensureCsrfCookie(req, res);

    if (res && res.locals) {
      res.locals.csrfToken = cookieToken;
      res.locals.csrfField = function() { return '<input type="hidden" name="_csrf" value="' + cookieToken + '">'; };
    }

    if (isSafeMethod(req.method)) return next();

    var provided = readCsrfToken(req);
    var ok = provided && provided === cookieToken;

    if (!ok) {
      var msg = '[CSRF] ' + CSRF_MODE + ' missing/invalid token for ' + req.method + ' ' + (req.originalUrl || req.url) + ' req=' + req.requestId;
      if (CSRF_MODE === 'enforce') {
        logMajor(msg);
        return csrfFail(req, res);
      }
      logMajor(msg);
    }

    return next();
  });

  return CSRF_MODE;
}

module.exports = { setupCsrf: setupCsrf, isAssetRequest: isAssetRequest, EXEMPT_PATHS: EXEMPT_PATHS };
