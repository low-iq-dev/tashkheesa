// src/middleware/csrf.js
// CSRF token generation, validation, and middleware.

var { randomBytes } = require('crypto');
var path = require('path');
var logger = require('../logger');
var logMajor = logger.major;

// AUDIT-2026-08-22: the CSRF failure log below printed req.originalUrl raw.
// Reset / magic-login / set-password / welcome tokens travel as PATH SEGMENTS
// (GET /reset-password/<token>), and those routes DO reach CSRF enforcement —
// so a single failed POST wrote a live, still-redeemable credential to stdout
// and, via logMajor, to anywhere logs are shipped. src/logger.js already
// defines the canonical redactor for exactly these four prefixes and the
// access logger uses it, but it is not on logger.js's module.exports today, so
// prefer the export when it appears and otherwise apply the same pattern here.
// Keep this regex identical to SENSITIVE_PATH_PATTERN in src/logger.js.
var SENSITIVE_PATH_PATTERN = /\/(reset-password|magic-login|set-password|welcome)\/[^/?#]+/gi;
var scrubUrl = (typeof logger.scrubUrl === 'function')
  ? logger.scrubUrl
  : function(url) {
      if (!url) return url;
      return String(url).replace(SENSITIVE_PATH_PATTERN, '/$1/[REDACTED]');
    };

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
    if (req.originalUrl && req.originalUrl.startsWith('/api/v1')) {
      return next();
    }
    // Public marketing-site intake endpoint. The caller is cross-origin
    // and cannot read the httpOnly csrf_token cookie. Auth/abuse defense
    // lives in the dedicated /api/cases rate limiter (src/middleware.js).
    // AUDIT-P0-7: narrowed from the '/api/cases/' PREFIX to the exact intake
    // path. The prefix also matched cookie-authenticated, state-changing routes
    // registered in routes/order_flow.js — POST /api/cases/:id/request-files
    // (now deleted) and POST /api/cases/:id/intelligence/reprocess — leaving
    // them with no CSRF protection at all.
    // req.path preserves a trailing slash, so the exact-match form alone 403'd
    // a cross-origin POST to '/api/cases/intake/' — which Express itself routes
    // to the same handler (strict routing is off). Enumerate both spellings
    // rather than reverting to a startsWith() prefix: the prefix is exactly
    // what AUDIT-P0-7 removed, because it also swallowed
    // POST /api/cases/:id/intelligence/reprocess.
    if (p === '/api/cases/intake' || p === '/api/cases/intake/') {
      return next();
    }
    if (p === '/callback' || p.startsWith('/portal/video/payment/callback') || p.startsWith('/payments/callback')) {
      return next();
    }
    // Signed provider webhooks. Exempt because they are server-to-server POSTs
    // carrying no cookie, so a CSRF token is meaningless — and safe to exempt
    // ONLY because each verifies a cryptographic signature over the raw body
    // before reading it (routes/webhooks_resend.js -> lib/svix_verify.js). An
    // unsigned or unverifiable request writes nothing and returns 401.
    if (p === '/webhooks/resend') {
      return next();
    }
    // OpenClaw opt-out / opt-in. Same category as the webhook above: a
    // server-to-server POST from the WhatsApp gateway on the Mac mini, which
    // holds no cookie and so can never present a CSRF token. Both routes
    // authenticate on the shared `x-openclaw-key` header before writing
    // anything (routes/openclaw-api.js), and a request without it gets 401.
    //
    // 2026-08-30 — until this exemption, a patient replying STOP was honoured
    // by the gateway's own mirror but never reached `users.notify_whatsapp`:
    // the callback died on 403 CSRF, so the portal kept enqueuing messages the
    // gateway then refused one by one. It failed closed, which is the right
    // direction, but it surfaced as a stream of failed notifications rather
    // than an unsubscribe, and the patient's stated wish was recorded nowhere
    // the rest of the platform could see.
    if (p === '/api/openclaw/opt-out' || p === '/api/openclaw/opt-in') {
      return next();
    }
    // Machine-to-machine ops agent endpoints. Authentication for these
    // lives in src/routes/ops.js#requireAgentKeyOptional (Theme 3 Stage 1;
    // promoted to required in Stage 2 — see
    // docs/runbooks/THEME_03_OPS_AGENT_KEY_CUTOVER.md). The toggle and
    // cleanup routes deliberately fall through to CSRF enforcement —
    // they run inside an authenticated ops browser session.
    if (p === '/ops/agent/ping' || p === '/ops/agent/log-tokens') {
      return next();
    }
    if (
      p === '/ops/login' ||
      p.startsWith('/ops/errors/')
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
      var msg = '[CSRF] ' + CSRF_MODE + ' missing/invalid token for ' + req.method + ' ' + scrubUrl(req.originalUrl || req.url) + ' req=' + req.requestId;
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
