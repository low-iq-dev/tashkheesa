require('dotenv').config();
var path = require('path');
var fs = require('fs');
var { bootCheck } = require('./bootCheck');
var ROOT = path.resolve(__dirname, '..');
var pkg = require('../package.json');
var SERVER_STARTED_AT = Date.now();
var SERVER_STARTED_AT_ISO = new Date(SERVER_STARTED_AT).toISOString();

function getGitSha() {
  var envSha = String(
    process.env.GIT_SHA ||
      process.env.COMMIT_SHA ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.RENDER_COMMIT ||
      ''
  ).trim();
  if (envSha) return envSha;
  try {
    var { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

var GIT_SHA = getGitSha();

var express = require('express');
var { randomUUID, randomBytes } = require('crypto');
var { pool, queryOne, queryAll, execute, withTransaction, migrate } = require('./db');
var { hash, attachUser } = require('./auth');
var { queueNotification } = require('./notify');
var { logOrderEvent } = require('./audit');
var { issueBreachRefundSafe } = require('./services/sla_breach');
var { baseMiddlewares, requireRole } = require('./middleware');
var i18n = require('./i18n');
var {
  MODE,
  verbose: logVerbose,
  major: logMajor,
  fatal: logFatal,
  attachRequestId,
  accessLogger,
  logError,
  logErrorToDb
} = require('./logger');
bootCheck({ ROOT: ROOT, MODE: MODE });

// === ENVIRONMENT VARIABLE VALIDATION ===
// Three tiers:
//   `alwaysRequired` — fatal in every environment (dev/staging/prod). These
//     are vars without which the server cannot boot meaningfully.
//   `prodRequired`   — fatal in staging/production, warn-only in development
//     so a fresh clone can `npm test` without setting every secret. Each entry
//     pairs the var name with an actionable hint shown alongside the FATAL.
//     Pattern matches Theme 5's DATABASE_URL_DIRECT fail-fast in job_queue.js.
//   `prodWarn`       — warn in staging/production, silent in development. For
//     vars whose absence degrades a non-critical feature (e.g. crash alerts)
//     but does not break patient flows. Surfaces in deploy logs so ops can
//     fix at leisure without blocking deploy.
(function validateCriticalEnvVars() {
  var mode = String(process.env.MODE || process.env.NODE_ENV || 'development').toLowerCase();
  var isDev = mode === 'development';

  var alwaysRequired = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];

  var prodRequired = {
    RESEND_API_KEY:
      'Set RESEND_API_KEY on Render to a Resend API key from https://resend.com → API Keys. ' +
      'Without it, transactional email (case lifecycle notifications, password reset, ' +
      'payment receipts) silently stubs and templated email throws fatally on first send.',
    BASE_URL:
      'Set BASE_URL on Render to the canonical site origin without trailing slash ' +
      '(e.g. https://tashkheesa.com). Used to construct absolute URLs for Paymob ' +
      'callbacks, video appointment return URLs, and JSON-LD schema. Without it, ' +
      'redirect URLs are broken and SEO/social shares regress to relative paths.',
    APP_URL:
      'Set APP_URL on Render to the canonical app origin without trailing slash ' +
      '(typically the same as BASE_URL). Used by email templates and notification ' +
      'workers to build absolute links to the dashboard and case views. Without it, ' +
      'every reader falls back to the hardcoded https://tashkheesa.com — incorrect ' +
      'on staging or any non-prod deploy.',
    UPLOADCARE_PUBLIC_KEY:
      'Set UPLOADCARE_PUBLIC_KEY on Render to the public key from your Uploadcare ' +
      'project (https://uploadcare.com → Project → API keys). The patient new-case ' +
      'wizard and doctor signup load the Uploadcare widget with this key; without it ' +
      'the widget renders unconfigured and patients cannot upload medical photos.',
    // UPLOADCARE_SECRET_KEY is intentionally NOT validated. docs/INTEGRATIONS.md:166
    // describes it as "required for server-side ops", but no such ops exist in code
    // today — there are no signed-URL generators, deletion endpoints, webhook
    // signature verifiers, or REST-API calls to api.uploadcare.com. Adding it to
    // prodRequired would emit a false signal, leading future maintainers to assume
    // the secret key powers something real. Threshold for adding it: when a real
    // server-side Uploadcare consumer (signed uploads, secure delivery, file delete)
    // ships and reads process.env.UPLOADCARE_SECRET_KEY. Investigation logged in
    // docs/audits/THEME_04_ENV_VAR_FIX_PLAN.md Phase 4 review notes.

    // R2 (Cloudflare object storage) — all four vars below are required together.
    // Active readers: prescription PDFs (writer + reader), case reports, patient
    // case-file uploads, doctor profile photos + signatures, mobile API downloads,
    // generic /files/:id signed-URL serve. Without any one of them, src/storage.js
    // initialises an S3Client with undefined credentials; the first upload/download
    // throws inside the request handler and the patient sees "File temporarily
    // unavailable". src/storage.js:19 already warns at module-load; this validator
    // promotes the warn to a hard exit in staging/production.
    R2_ENDPOINT:
      'Set R2_ENDPOINT to the Cloudflare R2 S3-API endpoint for your bucket ' +
      '(looks like https://<account-id>.r2.cloudflarestorage.com — visible on ' +
      'Cloudflare → R2 → <bucket> → Settings → "S3 API" endpoint). Required ' +
      'together with R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.',
    R2_ACCESS_KEY_ID:
      'Set R2_ACCESS_KEY_ID to the access key ID from a Cloudflare R2 Account ' +
      'API Token (Cloudflare → R2 → Manage R2 API Tokens → Create Account API ' +
      'Token, admin read+write on the bucket). Required together with ' +
      'R2_SECRET_ACCESS_KEY (issued at the same time, same token).',
    R2_SECRET_ACCESS_KEY:
      'Set R2_SECRET_ACCESS_KEY to the secret access key issued alongside ' +
      'R2_ACCESS_KEY_ID. Treat as a credential — never commit; rotate via the ' +
      'Cloudflare R2 token page if leaked.',
    R2_BUCKET_NAME:
      'Set R2_BUCKET_NAME to the name of the Cloudflare R2 bucket (visible on ' +
      'the R2 dashboard). The bucket must exist before the API token is scoped ' +
      'to it; the token must grant read + write + delete (used by ' +
      'src/routes/doctor.js for profile-photo replacement).'
  };

  var prodWarn = {
    ADMIN_PHONE:
      'crash-alert WhatsApp messages will silently no-op. Set on Render to ' +
      'digits-with-country-code (no +) to receive critical alerts. Requires ' +
      'WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN to also be set. ' +
      'Patient flows are unaffected; only ops visibility into crashes degrades.'
  };

  var missing = [];

  alwaysRequired.forEach(function(varName) {
    var value = process.env[varName];
    if (!value || String(value).trim() === '') {
      missing.push(varName);
    }
  });

  Object.keys(prodRequired).forEach(function(varName) {
    var value = process.env[varName];
    if (value && String(value).trim() !== '') return;
    if (isDev) {
      console.warn('⚠️  ' + varName + ' missing — degraded mode (development only)');
    } else {
      missing.push(varName);
    }
  });

  Object.keys(prodWarn).forEach(function(varName) {
    var value = process.env[varName];
    if (value && String(value).trim() !== '') return;
    if (!isDev) {
      console.warn('⚠️  ' + varName + ' missing — ' + prodWarn[varName]);
    }
  });

  if (missing.length > 0) {
    var hintLines = missing
      .filter(function(v) { return prodRequired[v]; })
      .map(function(v) { return '  → ' + v + ': ' + prodRequired[v]; });
    var msg = 'FATAL: Missing required environment variables: ' + missing.join(', ');
    if (hintLines.length) msg += '\n' + hintLines.join('\n');
    logFatal(msg);
    process.exit(1);
  }

  logVerbose('All required env vars present: ' + alwaysRequired.concat(Object.keys(prodRequired)).join(', '));
})();

// Centralized config
var CONFIG = Object.freeze({
  ROOT: ROOT,
  MODE: MODE,
  SLA_MODE: String(
    process.env.SLA_MODE || (MODE === 'development' ? 'primary' : 'passive')
  ).trim(),
  PORT: Number(process.env.PORT || 3000),
  BASIC_AUTH_USER: process.env.BASIC_AUTH_USER || process.env.STAGING_USER || '',
  BASIC_AUTH_PASS: process.env.BASIC_AUTH_PASS || process.env.STAGING_PASS || ''
});

logMajor(
  'Boot config: MODE=' + CONFIG.MODE + ' SLA_MODE=' + CONFIG.SLA_MODE + ' PORT=' + CONFIG.PORT +
    ' DB=' + (process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//<credentials>@')
);

if (CONFIG.SLA_MODE === 'primary') {
  logMajor('SLA_MODE=primary — ensure ONLY ONE server instance runs in primary');
}
var { safeAll, safeGet, tableExists } = require('./sql-utils');

// Route imports
var authRoutes = require('./routes/auth');
var aiAssistantRoutes = require('./routes/ai_assistant');
var doctorRoutes = require('./routes/doctor');
var patientRoutes = require('./routes/patient');
var superadminRoutes = require('./routes/superadmin').router;
var exportRoutes = require('./routes/exports');
var adminRoutes = require('./routes/admin');
var publicOrdersRoutes = require('./routes/public_orders');
var intakeRoutes = require('./routes/intake');
var orderFlowRoutes = require('./routes/order_flow');
// Side issue #47 — sla_worker.js + sla_watcher.js removed. Their
// runSlaSweep was already a `return;` no-op; case_sla_worker.js is
// the canonical sweep worker.
var paymentRoutes = require('./routes/payments');
var videoRoutes = require('./routes/video');
var addonRoutes = require('./routes/addons');
var appointmentRoutes = require('./routes/appointments');
var annotationRoutes = require('./routes/annotations');
var analyticsRoutes = require('./routes/analytics');
var reportRoutes = require('./routes/reports');
var reviewRoutes = require('./routes/reviews');
var onboardingRoutes = require('./routes/onboarding');
var messagingRoutes = require('./routes/messaging');
var prescriptionRoutes = require('./routes/prescriptions');
var tashApiRoutes = require('./routes/tash-api');
var openclawApiRoutes = require('./routes/openclaw-api');
var medicalRecordsRoutes = require('./routes/medical_records');
var referralRoutes = require('./routes/referrals');
var campaignRoutes = require('./routes/campaigns');
var helpRoutes = require('./routes/help');
var appLandingRoutes = require('./routes/app_landing');
var opsRoutes = require('./routes/ops');
var instagramRoutes = require('./instagram/routes');
var { InstagramScheduler } = require('./instagram/scheduler');
var { startVideoScheduler } = require('./video_scheduler');
var { startCaseSlaWorker } = require('./case_sla_worker');
var { startAcceptanceWatcher } = require('./workers/acceptance_watcher');
var caseLifecycle = require('./case_lifecycle');
var dispatchUnpaidCaseReminders = caseLifecycle.dispatchUnpaidCaseReminders;

// Extracted modules
var { setupStagingAuth } = require('./middleware/staging-auth');
var { setupCsrf, isAssetRequest, EXEMPT_PATHS } = require('./middleware/csrf');
var { setupHealthRoutes } = require('./routes/health');
var { setupVerifyRoutes } = require('./routes/verify');
var { setupStaticPages } = require('./routes/static-pages');
var { setupLangRoutes } = require('./routes/lang');

var app = express();

require('express-async-errors');

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Baseline security headers
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  var isVideoCallPage = (req.path || '').startsWith('/portal/video/call/');
  var camMic = isVideoCallPage ? 'self' : '';
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(' + camMic + '), camera=(' + camMic + ')');
  return next();
});

var COOKIE_SECURE = MODE === 'production' || MODE === 'staging';
var COOKIE_SAMESITE = 'lax';

// Request correlation + access logs
app.use(attachRequestId);
app.use(accessLogger());

// Staging Basic Auth
setupStagingAuth(app, CONFIG);

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
var marketingSiteDir = path.join(__dirname, '..', 'public', 'site');
var marketingStaticDir = fs.existsSync(marketingSiteDir)
  ? marketingSiteDir
  : path.join(__dirname, '..', 'public');
app.use('/site', express.static(marketingStaticDir));
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js')));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use('/styles.css', express.static(path.join(__dirname, '..', 'public', 'styles.css')));
app.use('/favicon.ico', express.static(path.join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/favicon.svg', express.static(path.join(__dirname, '..', 'public', 'assets', 'favicon.svg')));
app.use('/annotator.html', express.static(path.join(__dirname, '..', 'public', 'annotator.html')));

// ----------------------------------------------------
// CRASH GUARDRAILS
// ----------------------------------------------------
var { sendCriticalAlert } = require('./critical-alert');

process.on('unhandledRejection', function(reason) {
  var msg = reason instanceof Error ? reason.message : String(reason);
  try {
    logFatal('UNHANDLED_REJECTION', reason);
    logErrorToDb(reason instanceof Error ? reason : new Error(msg), { type: 'unhandledRejection', level: 'fatal' });
    sendCriticalAlert('UNHANDLED_REJECTION: ' + msg);
  } catch (e) {
    console.error('UNHANDLED_REJECTION', reason);
  } finally {
    setTimeout(function() { process.exit(1); }, 500).unref();
  }
});

process.on('uncaughtException', function(err) {
  var msg = err && err.message ? err.message : String(err);
  try {
    logFatal('UNCAUGHT_EXCEPTION', err);
    logErrorToDb(err, { type: 'uncaughtException', level: 'fatal' });
    sendCriticalAlert('UNCAUGHT_EXCEPTION: ' + msg);
  } catch (e) {
    console.error('UNCAUGHT_EXCEPTION', err);
  } finally {
    setTimeout(function() { process.exit(1); }, 500).unref();
  }
});

// Core middlewares (helmet, cookies, rate limit, i18n, user from JWT)
baseMiddlewares(app);

// P0-FORM-1: Backfill gate for patients without a phone. Self-gates on
// req.user.role === 'patient' so it's a no-op for everyone else; safe to
// mount globally. See src/middleware/requirePhone.js for the exempt list.
var { requirePhone } = require('./middleware/requirePhone');
app.use(requirePhone());

// CSP nonce
app.use(function(req, res, next) {
  try {
    var nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    req.cspNonce = nonce;

    var csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob: https://ucarecdn.com https://res.cloudinary.com https://api.qrserver.com",
      "font-src 'self' data: https://ucarecdn.com https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://ucarecdn.com https://fonts.googleapis.com",
      // 'unsafe-eval' is required by Uploadcare File Uploader 3.x — it compiles
      // its template/parser layer via new Function() at runtime. Source allow-list
      // ('self' + nonce + host-sources) still gates which code can RUN; this only
      // relaxes the eval() *function*. Tracked for migration to Uploadcare Blocks
      // v1.x (CSP-strict compatible) in a follow-up.
      "script-src 'self' 'unsafe-eval' 'nonce-" + nonce + "' https://ucarecdn.com https://cdn.jsdelivr.net https://media.twiliocdn.com https://unpkg.com",
      "connect-src 'self' https://upload.uploadcare.com https://api.uploadcare.com https://ucarecdn.com",
      "frame-src 'self' https://uploadcare.com https://ucarecdn.com",
    ].join('; ');

    res.setHeader('Content-Security-Policy', csp);
  } catch (e) {}
  next();
});

// i18n middleware
try {
  var mw =
    (typeof i18n === 'function' && i18n) ||
    (i18n && typeof i18n.middleware === 'function' && i18n.middleware) ||
    (i18n && typeof i18n.i18nMiddleware === 'function' && i18n.i18nMiddleware) ||
    null;
  if (mw) app.use(mw);
} catch (e) {}

// Fallback translation helpers — defense-in-depth.
// Canonical t/tt are set in src/middleware.js (Theme 10 §4.B); these only
// fire if a route bypasses baseMiddlewares (none do today, but kept so
// res.locals.t/tt are guaranteed to be functions before any render).
app.use(function(req, res, next) {
  if (res && res.locals) {
    if (typeof res.locals.t !== 'function') {
      res.locals.t = function(key, fallback) { return fallback || key; };
    }
    if (typeof res.locals.tt !== 'function') {
      res.locals.tt = function(key, enFallback, arFallback) {
        var lang = res.locals.lang || (req.session && req.session.lang) || (req.cookies && req.cookies.lang) || 'en';
        var isAr = lang === 'ar';
        var fromT = (typeof res.locals.t === 'function') ? res.locals.t(key, '') : '';
        if (fromT && fromT !== key) return fromT;
        return isAr ? (arFallback || enFallback || key) : (enFallback || key);
      };
    }
  }
  return next();
});

// Fallback lang/dir
app.use(function(req, res, next) {
  if (res && res.locals) {
    if (!res.locals.lang) {
      var lang = (req.session && req.session.lang) || (req.cookies && req.cookies.lang) || 'en';
      res.locals.lang = lang;
    }
    if (!res.locals.dir) {
      res.locals.dir = (res.locals.lang === 'ar') ? 'rtl' : 'ltr';
    }
    if (typeof res.locals.isAr !== 'boolean') {
      res.locals.isAr = res.locals.lang === 'ar';
    }
  }
  return next();
});

// Current URL for templates
app.use(function(req, res, next) {
  res.locals.currentUrl = req.originalUrl || req.url || '/';
  next();
});

// Attach user from JWT
app.use(attachUser);
app.use(function(req, res, next) {
  if (res && res.locals) {
    res.locals.user = req.user || null;
  }
  return next();
});

// Auto-detect country
app.use(function(req, res, next) {
  try {
    var geo = require('./geo');
    var country = geo.detectCountry(req);
    res.locals.detectedCountry = country;
    res.locals.detectedCurrency = geo.countryToCurrency(country);
  } catch (_) {}
  return next();
});

// ----------------------------------------------------
// AUTH-GATED FILE DOWNLOADS (PHI)
// ----------------------------------------------------
var UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');

function isHttpUrl(s) {
  var v = String(s || '').trim();
  return v.startsWith('http://') || v.startsWith('https://');
}

function safeFilename(name) {
  var raw = String(name || '').trim();
  if (!raw) return 'download';
  return raw.replace(/[/\\]/g, '_').slice(0, 180);
}

function sendErrorResponse(res, status, error, reqPath, method, requestId) {
  var statusCode = status || 500;
  var errorType = error && error.message ? error.message : String(error || 'Unknown error');
  var acceptJson = (res.get('accept') || '').includes('application/json');
  if (acceptJson) {
    return res.status(statusCode).json({
      ok: false, error: errorType, path: reqPath, method: method, requestId: requestId, status: statusCode
    });
  }
  return res.status(statusCode).type('text/plain').send(
    'Error: ' + errorType + '\nPath: ' + reqPath + '\nRequest: ' + requestId
  );
}

// Theme 13 Sub-issue C2.E — unified file reader walks THREE tables in order:
//   1. order_files                — canonical case files (existing)
//   2. messages                   — message-attached files (NEW C2.E)
//   3. order_additional_files     — patient additional uploads (NEW C2.E)
// Per-source auth (per THEME_13_C2_FIX_PLAN.md §8 Q4):
//   order_files / order_additional_files: admin/super always; patient if
//     order.patient_id === user; doctor if assigned + accepted_at IS NOT NULL.
//   messages: admin/super always; patient or doctor if member of the
//     conversation containing the message (no accepted_at gate — the
//     conversation can't exist before assignment, so the gate would never
//     reject a legitimate doctor).
// Per-source URL/key resolution (dual-mode):
//   file_url HTTP URL → 302 direct redirect (legacy Uploadcare path)
//   file_key R2 key   → 302 to signed URL (1h expiry)
//   neither           → 404
app.get('/files/:fileId', async function(req, res) {
  var fileId = String(req.params.fileId || '').trim();
  if (!fileId) {
    return sendErrorResponse(res, 400, 'Missing file ID', req.originalUrl, req.method, req.requestId);
  }
  if (!req.user) {
    var next = encodeURIComponent(req.originalUrl || '/files/' + fileId);
    return res.redirect('/login?next=' + next);
  }

  // ── Lookup chain (stop at first match) ────────────────────────────────
  var source = null;       // 'order_files' | 'messages' | 'order_additional_files'
  var fileUrl = '';        // legacy HTTP URL (any table)
  var fileKey = '';        // R2 key (messages + order_additional_files only post-C2.A)
  var fileLabel = '';      // for Content-Disposition
  var order = null;        // populated for order_files + order_additional_files
  var conversation = null; // populated for messages

  // 1. order_files (canonical — highest traffic, fastest path)
  var ofRow = await safeGet('SELECT id, order_id, url, label FROM order_files WHERE id = $1 LIMIT 1', [fileId], null);
  if (ofRow) {
    source = 'order_files';
    fileUrl = String(ofRow.url || '').trim();
    fileLabel = ofRow.label || '';
    order = await safeGet('SELECT id, patient_id, doctor_id, accepted_at, status FROM orders_active WHERE id = $1 LIMIT 1', [ofRow.order_id], null);
  }

  // 2. messages (post-C2.A has file_key column; pre-C2.A only file_url)
  if (!source) {
    var msgRow = await safeGet(
      'SELECT id, conversation_id, file_url, file_key, file_name FROM messages ' +
      'WHERE id = $1 AND (file_url IS NOT NULL OR file_key IS NOT NULL) LIMIT 1',
      [fileId], null
    );
    if (msgRow) {
      source = 'messages';
      fileUrl = String(msgRow.file_url || '').trim();
      fileKey = String(msgRow.file_key || '').trim();
      fileLabel = msgRow.file_name || '';
      conversation = await safeGet('SELECT id, patient_id, doctor_id FROM conversations WHERE id = $1 LIMIT 1', [msgRow.conversation_id], null);
    }
  }

  // 3. order_additional_files (post-C2.A has file_key column; pre-C2.A only file_url)
  if (!source) {
    var adfRow = await safeGet('SELECT id, order_id, file_url, file_key, label FROM order_additional_files WHERE id = $1 LIMIT 1', [fileId], null);
    if (adfRow) {
      source = 'order_additional_files';
      fileUrl = String(adfRow.file_url || '').trim();
      fileKey = String(adfRow.file_key || '').trim();
      fileLabel = adfRow.label || '';
      order = await safeGet('SELECT id, patient_id, doctor_id, accepted_at, status FROM orders_active WHERE id = $1 LIMIT 1', [adfRow.order_id], null);
    }
  }

  if (!source) {
    return sendErrorResponse(res, 404, 'File not found: ' + fileId, req.originalUrl, req.method, req.requestId);
  }

  // ── Per-source auth ───────────────────────────────────────────────────
  var role = String(req.user.role || '').toLowerCase();
  var userId = String(req.user.id || '');
  var allowed = false;

  // Response-code policy (per THEME_13_C2_FIX_PLAN.md §8 Q-B):
  //   - 404 → reserved strictly for "fileId does not exist in any of the
  //     three tables" (handled by the !source branch above).
  //   - 403 → every auth-failure case AND every parent-row-missing case
  //     (no order for order_files / order_additional_files, no conversation
  //     for messages). Uniform response code prevents leaking row-existence
  //     details to attackers.
  if (role === 'superadmin' || role === 'admin') {
    allowed = true;
  } else if (source === 'messages') {
    // Admin already handled above. Patient/doctor must be a conversation member.
    // Conversation lookup may fail if the message references a deleted convo —
    // falls through to 403 below (the `if (conversation)` guard never sets
    // allowed=true so the default `allowed = false` stays).
    //
    // INVARIANT: conversations cannot exist before the doctor's
    // accepted_at is set (enforced by case_lifecycle.js).
    // If this invariant changes (e.g. pre-acceptance messaging is
    // added), restore an accepted_at gate here for doctor access.
    if (conversation) {
      allowed = (userId === String(conversation.patient_id || '')) || (userId === String(conversation.doctor_id || ''));
    }
  } else {
    // order_files OR order_additional_files: same auth model as pre-C2.E.
    // Missing order row falls through to 403 (the `if (order)` guard never
    // sets allowed=true so the default `allowed = false` stays).
    if (order) {
      if (role === 'patient') {
        allowed = !!order.patient_id && String(order.patient_id) === userId;
      } else if (role === 'doctor') {
        var isAssigned = !!order.doctor_id && String(order.doctor_id) === userId;
        var isAccepted = !!order.accepted_at;
        allowed = isAssigned && isAccepted;
      }
    }
  }

  if (!allowed) {
    logMajor('[FILES] blocked role=' + role + ' user=' + userId + ' source=' + source + ' file=' + fileId + ' req=' + req.requestId);
    return res.status(403).type('text/plain').send('Forbidden');
  }

  // ── Resolve URL or key (dual-mode) ────────────────────────────────────
  // Legacy HTTP URL: redirect directly. Applies to order_files.url stored as
  // a CDN URL (pre-Phase-2 Uploadcare path) AND to messages.file_url /
  // order_additional_files.file_url stored as Uploadcare CDN URLs.
  if (fileUrl && isHttpUrl(fileUrl)) {
    return res.redirect(302, fileUrl);
  }

  // R2 key: prefer file_key (the post-C2.A column), fall back to file_url
  // (where order_files stores the wizard's R2 key as `url`). Pre-migration
  // synthetic local paths resolve to a signed URL pointing to a non-existent
  // R2 object — unrecoverable (disk wiped on prior Render deploy).
  var r2Key = fileKey || fileUrl;
  if (!r2Key) return res.status(404).type('text/plain').send('File missing');

  try {
    var storage = require('./storage');
    var downloadName = safeFilename(fileLabel || path.basename(r2Key));
    var signedUrl = await storage.getSignedDownloadUrl(r2Key, 3600, { downloadName: downloadName });
    return res.redirect(302, signedUrl);
  } catch (err) {
    logMajor('[FILES] R2 signed URL failed source=' + source + ' file=' + fileId + ' key=' + r2Key + ' err=' + (err && err.message ? err.message : String(err)) + ' req=' + req.requestId);
    return res.status(500).type('text/plain').send('File temporarily unavailable');
  }
});

// CSRF middleware
var CSRF_MODE = setupCsrf(app, { MODE: MODE, COOKIE_SECURE: COOKIE_SECURE, COOKIE_SAMESITE: COOKIE_SAMESITE });

// Remember last visited page
app.use(function(req, res, next) {
  try {
    if (req.method === 'GET') {
      var p = req.path || '/';
      // Only remember real page navigations. Background fetches / XHR (e.g. the
      // notification bell polling /portal/patient/alerts.json) must not clobber
      // last_path, or the language toggle would bounce back to the JSON URL.
      var wantsHtml = String(req.get('accept') || '').includes('text/html');
      var isJsonPath = p.endsWith('.json');
      if (wantsHtml && !isJsonPath && !p.startsWith('/lang/') && !EXEMPT_PATHS.has(p) && !isAssetRequest(p)) {
        res.cookie('last_path', req.originalUrl || '/', {
          httpOnly: false,
          sameSite: COOKIE_SAMESITE,
          secure: COOKIE_SECURE,
          maxAge: 7 * 24 * 60 * 60 * 1000
        });
      }
    }
  } catch (e) {}
  next();
});

// Health endpoints
app.use('/', setupHealthRoutes({
  MODE: MODE, CONFIG: CONFIG, pool: pool, pkg: pkg,
  GIT_SHA: GIT_SHA, SERVER_STARTED_AT: SERVER_STARTED_AT, SERVER_STARTED_AT_ISO: SERVER_STARTED_AT_ISO
}));

// Verify endpoints
app.use('/', setupVerifyRoutes({
  MODE: MODE, CONFIG: CONFIG, GIT_SHA: GIT_SHA,
  SERVER_STARTED_AT: SERVER_STARTED_AT, SERVER_STARTED_AT_ISO: SERVER_STARTED_AT_ISO,
  CSRF_MODE: CSRF_MODE, safeAll: safeAll, safeGet: safeGet, tableExists: tableExists
}));

// Database initialization
var _dbReady = (async function initDatabase() {
  try {
    await migrate();
    logMajor('Database migration complete');
  } catch (err) {
    logFatal('DB migrate failed — refusing to start', err);
    process.exit(1);
  }

  // Catalog B seeder DISABLED (April 2026).
  // src/seed_specialties.js produces "spec-*" demo specialty/service rows that
  // were deleted from production via scripts/delete_catalog_b.js. Re-enabling
  // this call will recreate the same 47 demo rows on every boot. The canonical
  // catalog (lowercase specialty_ids, stable IDs like card_echo / rad_mri_review)
  // is seeded elsewhere — see src/db.js seedPricingData() and the pricing CSV
  // import in scripts/. See the warning header in src/seed_specialties.js.
  //
  // try {
  //   var { seedSpecialtiesAndServices } = require('./seed_specialties');
  //   await seedSpecialtiesAndServices();
  // } catch (err) {
  //   console.error('[seed] Failed to seed specialties:', err.message);
  // }

  if (MODE === 'staging') {
    if (String(process.env.SEED_DEMO_DATA || '').trim() === '1') {
      try {
        await seedDemoData();
      } catch (err) {
        logFatal('Demo seed failed', err);
      }
    } else {
      logMajor('Demo seed skipped (set SEED_DEMO_DATA=1 to seed demo users/orders in staging).');
    }
  }
})();

// Home / role redirects
var homepageLocals = {
  businessEmail: process.env.BUSINESS_EMAIL || 'info@tashkheesa.com',
  businessPhone: process.env.BUSINESS_PHONE || '+20 110 200 9886',
  businessAddress: process.env.BUSINESS_ADDRESS || 'Cairo, Egypt',
  priceRangeMin: process.env.PRICE_RANGE_MIN || '200',
  priceRangeMax: process.env.PRICE_RANGE_MAX || '18,250',
  currency: 'EGP'
};

function renderHomepage(req, res) {
  return res.render('index', homepageLocals);
}

app.get('/index.html', function(req, res) { return res.redirect('/'); });
app.get('/site', function(req, res) { return res.redirect('/'); });
app.get('/site/', function(req, res) { return res.redirect('/'); });

app.get('/', function(req, res) {
  if (!req.user) return renderHomepage(req, res);
  switch (req.user.role) {
    case 'patient': return res.redirect('/dashboard');
    case 'doctor': return res.redirect('/portal/doctor');
    case 'admin': return res.redirect('/admin');
    case 'superadmin': return res.redirect('/superadmin');
    default: return res.redirect('/login');
  }
});

// Static pages, contact form, pre-launch, .html redirects
app.use('/', setupStaticPages({ execute: execute, safeAll: safeAll }));

// Profile redirect
app.get('/profile', function(req, res) {
  if (!req.user) return res.redirect('/login');
  var role = String(req.user.role || '').toLowerCase();
  switch (role) {
    case 'patient': return res.redirect('/patient/profile');
    case 'doctor': return res.redirect('/portal/doctor/profile');
    case 'admin': return res.redirect('/admin/profile');
    case 'superadmin': return res.redirect('/superadmin/profile');
    default: return res.redirect('/login');
  }
});

// Convenience aliases
app.get('/patient', function(req, res) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'patient') return res.redirect('/dashboard');
  switch (req.user.role) {
    case 'doctor': return res.redirect('/portal/doctor');
    case 'admin': return res.redirect('/admin');
    case 'superadmin': return res.redirect('/superadmin');
    default: return res.redirect('/dashboard');
  }
});

app.get('/patient/orders', function(req, res) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'patient') return res.redirect('/dashboard');
  switch (req.user.role) {
    case 'doctor': return res.redirect('/portal/doctor');
    case 'admin': return res.redirect('/admin');
    case 'superadmin': return res.redirect('/superadmin');
    default: return res.redirect('/dashboard');
  }
});

app.get('/portal/admin', function(req, res) { return res.redirect('/admin'); });
app.get('/portal/superadmin', function(req, res) { return res.redirect('/superadmin'); });
app.get('/portal/patient/dashboard', function(req, res) { return res.redirect('/dashboard'); });
app.get('/admin/referrals', function(req, res) { return res.redirect('/portal/admin/referrals'); });
app.get('/admin/campaigns', function(req, res) { return res.redirect('/portal/admin/campaigns'); });
app.get('/doctor/queue', function(req, res) { return res.redirect('/portal/doctor/dashboard'); });
app.get('/doctor/alerts', function(req, res) { return res.redirect('/portal/doctor/alerts'); });
app.get('/case/new', function(req, res) { return res.redirect('/login'); });

// Language switch
app.use('/', setupLangRoutes({ COOKIE_SECURE: COOKIE_SECURE, COOKIE_SAMESITE: COOKIE_SAMESITE }));

// ----------------------------------------------------
// PORTAL ROUTE GUARDRAILS (role boundaries)
// ----------------------------------------------------
function roleHome(role) {
  switch (role) {
    case 'patient': return '/dashboard';
    case 'doctor': return '/portal/doctor';
    case 'admin': return '/admin';
    case 'superadmin': return '/superadmin';
    default: return '/login';
  }
}

function denyOrRedirect(req, res, target) {
  var method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return res.status(403).type('text/plain').send('Forbidden');
  }
  return res.redirect(target);
}

app.use(function(req, res, next) {
  var p = req.path || '';
  var areas = [
    { name: 'patient', match: function(x) { return x === '/dashboard' || x.startsWith('/patient'); }, roles: ['patient'] },
    { name: 'doctor', match: function(x) { return x.startsWith('/portal/doctor'); }, roles: ['doctor'] },
    { name: 'admin', match: function(x) { return x.startsWith('/admin'); }, roles: ['admin', 'superadmin'] },
    { name: 'superadmin', match: function(x) { return x.startsWith('/superadmin'); }, roles: ['superadmin'] }
  ];

  var area = null;
  for (var ai = 0; ai < areas.length; ai++) {
    if (areas[ai].match(p)) { area = areas[ai]; break; }
  }
  if (!area) return next();

  if (!req.user) {
    var loginTarget = '/login?next=' + encodeURIComponent(req.originalUrl || p || '/');
    return denyOrRedirect(req, res, loginTarget);
  }

  var role = String(req.user.role || '').toLowerCase();
  if (area.roles.indexOf(role) === -1) {
    var home = roleHome(role);
    logMajor('[RBAC] blocked role=' + role + ' from ' + p + ' (area=' + area.name + ') req=' + req.requestId);
    return denyOrRedirect(req, res, home);
  }

  return next();
});

// SLA enforcement config
var SLA_ENFORCEMENT_ENABLED = String(process.env.SLA_ENFORCEMENT_ENABLED || '1') === '1';

// SLA hybrid enforcement (event-based trigger)
app.use(function(req, res, next) {
  res.on('finish', function() {
    if (CONFIG.SLA_MODE !== 'primary') return;
    if (!SLA_ENFORCEMENT_ENABLED) return;
    var method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (res.statusCode && res.statusCode >= 400) return;
    var p = String(req.originalUrl || req.url || '');
    var isOrderMutation =
      /^\/(admin|superadmin)\/orders\b/i.test(p) ||
      /^\/portal\/doctor\b/i.test(p) ||
      /^\/doctor\b/i.test(p) ||
      /^\/patient\/orders\b/i.test(p);
    if (!isOrderMutation) return;
    setTimeout(function() {
      try { runSlaEnforcementSweep('event:' + method + ' ' + p); } catch (e) {}
    }, 0);
  });
  next();
});

// Routes
app.use('/', aiAssistantRoutes);
app.use('/', authRoutes);
app.use('/', doctorRoutes);
app.use('/', patientRoutes);

// Theme 13 Sub-issue A — patient direct-to-R2 upload endpoint (replaces the
// Uploadcare widget on patient_new_case.ejs / patient_order.ejs). Mounted
// only when UPLOAD_R2_DIRECT_ENABLED === 'true' so cutover is a flag flip,
// not a deploy. Rollback path: flip flag to 'false' and the legacy Uploadcare
// widget continues to render. See docs/audits/THEME_13_R2_MIGRATION_FIX_PLAN.md §7.
if (String(process.env.UPLOAD_R2_DIRECT_ENABLED || '').toLowerCase() === 'true') {
  app.use('/', require('./routes/patient_files'));
  console.log('[theme13] UPLOAD_R2_DIRECT_ENABLED=true — patient_files route mounted at /portal/patient/files');
}
app.use('/', superadminRoutes);
app.use('/', exportRoutes);
app.use('/', adminRoutes);
app.use('/', publicOrdersRoutes);
app.use('/', intakeRoutes);
app.use('/', orderFlowRoutes);
app.use('/payments', paymentRoutes);
app.use('/', videoRoutes);
app.use('/', addonRoutes);
app.use('/', appointmentRoutes);
app.use('/', annotationRoutes);
app.use('/', analyticsRoutes);
app.use('/', reportRoutes);
app.use('/', reviewRoutes);
app.use('/', onboardingRoutes);
app.use('/', messagingRoutes);
app.use('/', prescriptionRoutes);
app.use('/', tashApiRoutes);
app.use('/', openclawApiRoutes);
app.use('/', medicalRecordsRoutes);
app.use('/', referralRoutes);
app.use('/', campaignRoutes);
app.use('/', helpRoutes);
app.use('/', appLandingRoutes);
app.use('/ops', opsRoutes);
app.use('/api/admin/instagram', requireRole('superadmin'), instagramRoutes);

// Internal SLA triggers
function requireOpsRole(req, res) {
  if (!req.user) return { ok: false, res: res.redirect('/login') };
  var role = String(req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'superadmin') return { ok: false, res: res.status(403).type('text/plain').send('Forbidden') };
  return { ok: true };
}

app.get('/internal/run-sla-check', function(req, res) {
  var gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;
  // Legacy runSlaSweep() disabled — case_sla_worker handles SLA sweeps.
  try { runSlaEnforcementSweep('manual:run-sla-check'); } catch (e) {}
  return res.redirect(req.user.role === 'superadmin' ? '/superadmin?sla_ran=1' : '/admin?sla_ran=1');
});

app.get('/internal/run-sla-enforcement', function(req, res) {
  var gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;
  try { runSlaEnforcementSweep('manual:run-sla-enforcement'); } catch (e) {}
  return res.redirect(req.user.role === 'superadmin' ? '/superadmin?sla_ran=1' : '/admin?sla_ran=1');
});

// ─── Mobile API ────────────────────────────────────────────
// Mounts /api/v1/* for the React Native patient app.
// Does NOT affect any existing portal routes.

// OTP delivery via Twilio Verify (SMS). Replaces the WhatsApp Cloud API
// approach (src/services/whatsapp_otp.js) which required template approval.
// Twilio Verify sends SMS to any number including Egypt (+20) without A2P
// registration. The WhatsApp adapter is kept as a backup but is no longer wired.
var { sendOtpViaTwilio } = require('./services/twilio_verify');

// Mobile API auth route (src/routes/api/auth.js) imports emailService directly
// for password-reset emails — no helper injection needed.

var apiV1 = require('./routes/api_v1')(pool, {
  safeGet: safeGet,
  safeAll: safeAll,
  safeRun: execute,
  sendOtpViaTwilio: sendOtpViaTwilio,
});
app.use('/api/v1', apiV1);

// Public website intake (anonymous, no auth)
app.use('/api/cases', require('./routes/api/cases_intake'));

// Heuristic: is this request "patient context" — i.e., should the error page
// use the patient v2 chrome rather than the generic Tashkheesa error template?
// Match on URL prefix OR authenticated role. Order is intentional: prefix wins
// for unauthed visits to patient routes, role catches authenticated patients
// hitting deep links that don't match the prefixes (rare but possible).
function isPatientContext(req) {
  try {
    var path = String(req.originalUrl || req.url || '');
    if (path.startsWith('/dashboard') ||
        path.startsWith('/patient/') ||
        path.startsWith('/portal/patient/') ||
        path.startsWith('/portal/case/')) return true;
    if (req.user && String(req.user.role || '').toLowerCase() === 'patient') return true;
    return false;
  } catch (_) { return false; }
}

function patientLangLocals(req, res) {
  var lang = (res.locals && res.locals.lang) ||
             (req.session && req.session.lang) ||
             (req.cookies && req.cookies.lang) || 'en';
  return { lang: lang, isAr: String(lang).toLowerCase() === 'ar', user: req.user || {} };
}

// 404 handler
app.use(function(req, res) {
  var requestId = req.requestId;
  var pathStr = req.originalUrl || req.url;
  var wantsJson =
    (req.get('accept') || '').includes('application/json') ||
    pathStr.startsWith('/api/') ||
    pathStr.startsWith('/internal/');

  if (wantsJson) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND', path: pathStr, requestId: requestId });
  }

  // Patient context → V2 chrome 404. Otherwise legacy generic 404.
  if (isPatientContext(req)) {
    try {
      return res.status(404).render('patient_404', patientLangLocals(req, res));
    } catch (e) { /* fall through to legacy */ }
  }
  try {
    return res.status(404).render('404', { title: '404', brand: 'Tashkheesa' });
  } catch (e) {
    return res.status(404).type('text/plain').send('Not found');
  }
});

// Error handler
app.use(function(err, req, res, next) {
  var status = err.status || 500;
  var errorId = logError(err, {
    requestId: req.requestId, method: req.method,
    path: req.originalUrl || req.url,
    userId: req.user && req.user.id, role: req.user && req.user.role
  });

  logErrorToDb(err, {
    errorId: errorId, requestId: req.requestId,
    url: req.originalUrl || req.url, method: req.method,
    userId: req.user && req.user.id, role: req.user && req.user.role
  });

  // Patient context → V2 chrome 500. Verbose dev message ONLY when not in
  // production. Patient-side users in production never see stack traces /
  // SQL errors / route names regardless of what blew up.
  if (isPatientContext(req)) {
    try {
      var pl = patientLangLocals(req, res);
      return res.status(status).render('patient_500', {
        lang: pl.lang,
        isAr: pl.isAr,
        user: pl.user,
        errorId: errorId,
        verbose: MODE !== 'production',
        message: MODE !== 'production' ? (err.message || 'Internal Server Error') : ''
      });
    } catch (renderErr) {
      // Fall through to legacy template / plain text below.
    }
  }

  try {
    return res.status(status).render('error', {
      message: MODE === 'production' ? 'Something went wrong' : (err.message || 'Internal Server Error'),
      errorId: errorId, status: status
    });
  } catch (renderErr) {
    if (MODE === 'production') {
      return res.status(status).type('text/plain').send('An unexpected error occurred. Error ID: ' + errorId);
    }
    return res.status(status).type('text/plain').send('Error ID: ' + errorId + '\n\n' + (err.stack || 'Internal Server Error'));
  }
});

// ----------------------------------------------------
// SLA SINGLE WRITER MODE
// ----------------------------------------------------
var slaSweepIntervalId = null;
var slaEnforcementRunning = false;
var slaUnlabeledSweepWarned = false;
var SLA_ENFORCEMENT_INTERVAL_MS = Number(process.env.SLA_ENFORCEMENT_INTERVAL_MS || 5 * 60 * 1000);

// Theme 6 §4-A (Sub-issue A) — every long-lived setInterval id registered
// on boot is pushed here so gracefulShutdown can clear them. Without this,
// SIGTERM hits the 10s force-exit timer on every Render redeploy because
// every worker except slaSweepIntervalId pinned the event loop.
var intervalIds = [];
// Track the IG scheduler instance for shutdown cleanup (it owns its own
// interval inside instagram/scheduler.js and exposes a .stop() method).
var igSchedulerInstance = null;

async function runSlaEnforcementSweep(source) {
  if (CONFIG.SLA_MODE !== 'primary') return;
  var srcLabel = source ? String(source) : 'unlabeled';
  if (srcLabel === 'unlabeled' && !slaUnlabeledSweepWarned) {
    slaUnlabeledSweepWarned = true;
    try {
      var stack = (new Error('unlabeled SLA sweep')).stack || '';
      logMajor('[SLA] WARNING: enforcement sweep called without source label. Stack:\n' + stack);
    } catch (e) {}
  }
  if (!SLA_ENFORCEMENT_ENABLED) return;
  if (slaEnforcementRunning) return;
  slaEnforcementRunning = true;

  try {
    // Theme 6 §4-B (Sub-issue B): every sub-sweep below is async — the
    // previous sync try/catch caught only the synchronous portion up to
    // the first await inside each fn, and any rejection past that escaped
    // as unhandledRejection. The inner try/catches are now effective
    // because we await each call before the catch can fire.
    // Side issue #47 — runWatcherSweep call removed; the underlying
    // runSlaSweep was a no-op stub. case_sla_worker.runCaseSlaSweep
    // (registered via pg-boss) is the canonical SLA sweep path.
    try { await runSlaReminderJob(); } catch (err) { logFatal('SLA reminder job error', err); }
    try { await dispatchUnpaidCaseReminders(); } catch (err) { logFatal('Unpaid reminder sweep error', err); }
    try {
      if (typeof caseLifecycle.sweepExpiredDoctorAccepts === 'function') {
        await caseLifecycle.sweepExpiredDoctorAccepts();
      }
    } catch (err) { logFatal('Doctor accept sweep failed', err); }
    try { logVerbose('[SLA] enforcement sweep ran (' + srcLabel + ')'); } catch (e) {}
  } catch (err) {
    logFatal('SLA enforcement sweep failed', err);
  } finally {
    slaEnforcementRunning = false;
  }
}

var { startJobQueue, stopJobQueue, scheduleSlaSweep, scheduleAiCanary } = require('./job_queue');

// Boot: wait for DB migration before starting workers
_dbReady.then(async function() {
  // Start pg-boss job queue (handles case-intelligence, auto-assign, reprocess)
  try {
    await startJobQueue();
  } catch (jqErr) {
    logMajor('Job queue start failed (falling back to direct execution): ' + jqErr.message);
  }
  // AI-health canary — singleton probe (every AI_CANARY_CRON, default 3h),
  // independent of SLA_MODE. Trips/clears the AI-billing flag + keeps the
  // staleness heartbeat fresh before any patient hits a dead AI call.
  try { await scheduleAiCanary(); } catch (e) {
    logMajor('AI canary schedule failed: ' + e.message);
  }
  if (CONFIG.SLA_MODE === 'primary') {
    logMajor('SLA MODE: primary (single writer enabled)');
    // startSlaWorker() disabled — consolidated on case_sla_worker.js
    // Prefer pg-boss singleton to prevent duplicate sweeps across Render instances.
    // Falls back to in-process setInterval if pg-boss is unavailable.
    var slaBoss = false;
    try { slaBoss = await scheduleSlaSweep(); } catch (e) {
      logMajor('pg-boss SLA schedule failed, falling back to setInterval: ' + e.message);
    }
    if (!slaBoss) {
      // Theme 6 §4-B: capture the in-process fallback interval id for shutdown.
      var caseSlaWorkerId = startCaseSlaWorker();
      if (caseSlaWorkerId) intervalIds.push(caseSlaWorkerId);
    }
    startVideoScheduler();

    // Theme 6 §4-A (OQ-4): capture acceptance_watcher's interval id for shutdown.
    var acceptanceWatcherId = startAcceptanceWatcher();
    if (acceptanceWatcherId) {
      if (acceptanceWatcherId.unref) acceptanceWatcherId.unref();
      intervalIds.push(acceptanceWatcherId);
    }

    setTimeout(function() {
      try { runSlaEnforcementSweep('boot'); } catch (e) {}
    }, 1000);

    slaSweepIntervalId = setInterval(function() {
      runSlaEnforcementSweep('interval');
    }, SLA_ENFORCEMENT_INTERVAL_MS);
    if (slaSweepIntervalId.unref) slaSweepIntervalId.unref();

    logMajor('Payment reminders dispatched via SLA sweep (every 5 min)');

    // ─── Theme 6 §4-A — primary-only worker registrations ────────────
    // All workers below were previously registered outside this block
    // and ran on every Render instance. Production is currently a
    // single-instance Render service (disk-attached services don't
    // support scale-out), but the gate prevents future regressions if
    // a passive instance is ever added.

    // Auto-close stale conversations
    try {
      var closeStaleConversations = require('./routes/messaging').closeStaleConversations;
      var ccBoot = setTimeout(function() { try { closeStaleConversations(); } catch (_) {} }, 5000);
      if (ccBoot && ccBoot.unref) ccBoot.unref();
      var ccInterval = setInterval(function() { try { closeStaleConversations(); } catch (_) {} }, 24 * 60 * 60 * 1000);
      if (ccInterval && ccInterval.unref) ccInterval.unref();
      intervalIds.push(ccInterval);
      logMajor('Conversation auto-close registered (daily, primary-only)');
    } catch (e) {
      logMajor('Conversation auto-close registration failed: ' + e.message);
    }

    // Appointment reminder cron
    try {
      var cron = require('node-cron');
      var runAppointmentReminders = require('./jobs/appointment_reminders').runAppointmentReminders;
      cron.schedule('*/15 * * * *', function() {
        try { runAppointmentReminders(); } catch (_) {}
      });
      logMajor('Appointment reminder cron registered (every 15 min, primary-only)');
    } catch (cronErr) {
      logMajor('Appointment reminder cron registration failed: ' + cronErr.message);
    }

    // Theme 9 Sub-issue A: WhatsApp 401-detector cron. Reads error_logs for
    // category='whatsapp_send' rows with statusCode=401 in the last 15min;
    // fires sendCriticalAlert if any are found. Alerting plumbing only —
    // actual WhatsApp delivery is gated on CRITICAL_ALERT_TEMPLATE_NAME
    // (Meta verification clearance).
    try {
      var whatsappHealthCron = require('node-cron');
      var checkWhatsAppHealth = require('./jobs/whatsapp_health_check').checkWhatsAppHealth;
      whatsappHealthCron.schedule('*/15 * * * *', function() {
        try { checkWhatsAppHealth(); } catch (_) {}
      });
      logMajor('WhatsApp 401-detector cron registered (every 15 min, primary-only)');
    } catch (waHealthErr) {
      logMajor('WhatsApp health cron registration failed: ' + waHealthErr.message);
    }

    // Side issue #50: error-rate cron. Runs the same baseline-vs-current
    // query that /ops Widget 4 surfaces; fires sendCriticalAlert with
    // alertKey='error_rate_5x' when current-hour error_logs count is
    // >=5 absolute AND >=5x the trailing 7-day hourly baseline. DB-backed
    // _shouldSend throttle keeps a sustained spike from spamming admin.
    try {
      var errorRateCron = require('node-cron');
      var checkErrorRate = require('./jobs/error_rate_check').checkErrorRate;
      errorRateCron.schedule('*/15 * * * *', function() {
        try { checkErrorRate(); } catch (_) {}
      });
      logMajor('Error-rate 5x cron registered (every 15 min, primary-only)');
    } catch (errRateErr) {
      logMajor('Error-rate cron registration failed: ' + errRateErr.message);
    }

    // Campaign cron
    try {
      var campaignCron = require('node-cron');
      var processCampaign = require('./routes/campaigns').processCampaign;
      campaignCron.schedule('*/5 * * * *', async function() {
        try {
          var now = new Date().toISOString();
          // B2 (April 29 audit): require human approval. Cron only fires
          // campaigns that have been explicitly approved via
          // POST /portal/admin/campaigns/:id/approve (sets approved_by).
          var scheduled = await safeAll(
            "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND approved_by IS NOT NULL AND scheduled_at <= $1",
            [now], []
          );
          // Theme 6 §4-C (Sub-issue C):
          //   (1) `var ci` was hoisted, so every setImmediate captured the
          //       SAME `ci` binding — by fire time `ci === scheduled.length`,
          //       calling processCampaign(undefined). `let ci` gives each
          //       iteration its own binding. We also hoist the id into a
          //       const inside the loop to make the closure intent explicit.
          //   (2) rowCount guard (P3-WORKER-N1): the UPDATE
          //       `... WHERE status='scheduled'` is a write-once race. If a
          //       second instance ever runs this cron, only one instance's
          //       UPDATE matches; without the rowCount check, BOTH would
          //       still call processCampaign and double-send. Skip when
          //       rowCount === 0.
          //   (3) Replace bare `try { processCampaign(); } catch (_) {}`
          //       (which can't catch async rejections) with `.catch()` —
          //       same pattern as Sub-issue B.
          for (let ci = 0; ci < scheduled.length; ci++) {
            const campaignId = scheduled[ci].id;
            try {
              const result = await execute(
                "UPDATE email_campaigns SET status = 'sending' WHERE id = $1 AND status = 'scheduled' AND approved_by IS NOT NULL",
                [campaignId]
              );
              if (result && result.rowCount > 0) {
                setImmediate(function() {
                  processCampaign(campaignId).catch(function(err) {
                    console.error('[campaigns] processCampaign failed for ' + campaignId, err && err.message);
                  });
                });
              }
            } catch (_) {}
          }
          if (scheduled.length > 0) {
            logMajor('[campaigns] Triggered ' + scheduled.length + ' scheduled campaign(s)');
          }
        } catch (_) {}
      });
      logMajor('Campaign scheduler cron registered (every 5 min, primary-only)');
    } catch (campaignCronErr) {
      logMajor('Campaign scheduler cron registration failed: ' + campaignCronErr.message);
    }

    // Instagram scheduler
    try {
      igSchedulerInstance = new InstagramScheduler();
      igSchedulerInstance.start();
    } catch (igErr) {
      logMajor('Instagram scheduler start failed: ' + igErr.message);
    }

    // Notification worker
    var runNotificationWorker = require('./notification_worker').runNotificationWorker;
    var nwInterval = setInterval(async function() {
      try { await runNotificationWorker(50); } catch (err) { console.error('[notify-worker] interval error', err); }
    }, 30000);
    if (nwInterval && nwInterval.unref) nwInterval.unref();
    intervalIds.push(nwInterval);
    var nwBoot = setTimeout(async function() {
      try { await runNotificationWorker(50); console.log('[notify-worker] initial run complete'); } catch (err) { console.error('[notify-worker] initial run error', err); }
    }, 5000);
    if (nwBoot && nwBoot.unref) nwBoot.unref();
    logMajor('Notification worker registered (every 30s, primary-only)');

    // #66: Unpaid payment-reminder sweep. Previously registered only in
    // the non-primary `else` branch below, which never executes on
    // single-instance Render deploys (SLA_MODE=primary). The only firing
    // path was the boot-time call at runSlaEnforcementSweep — i.e. once
    // per deploy — explaining the trickle of failed payment_reminder
    // sends in production. Moving the interval into the primary branch
    // alongside the other mutating workers (notification, mac-mini probe).
    var unpaidReminderInterval = setInterval(function() {
      dispatchUnpaidCaseReminders().catch(function(err) {
        console.error('[payment-reminders] error', err);
      });
    }, 15 * 60 * 1000);
    if (unpaidReminderInterval && unpaidReminderInterval.unref) unpaidReminderInterval.unref();
    intervalIds.push(unpaidReminderInterval);
    logMajor('Payment reminders registered (every 15 min, primary-only)');

    // Mac-mini SSH probe (P3-WORKER-N5) — was registered at module-require time
    // in routes/ops.js; now started explicitly here so it's gated and tracked.
    try {
      var startMacMiniProbe = require('./routes/ops').startMacMiniProbe;
      if (typeof startMacMiniProbe === 'function') {
        var probeId = startMacMiniProbe();
        if (probeId) intervalIds.push(probeId);
        logMajor('Mac-mini SSH probe registered (every 2 min, primary-only)');
      }
    } catch (probeErr) {
      logMajor('Mac-mini probe registration failed: ' + probeErr.message);
    }

    // Heartbeat table cleanup — agent_heartbeats grows one row per worker per
    // tick. Reuses pruneHeartbeats() (same logic as POST /ops/agent/cleanup)
    // so the table no longer relies on someone hitting that endpoint by hand.
    // Daily cadence + a one-shot run shortly after boot.
    try {
      var pruneHeartbeats = require('./routes/ops').pruneHeartbeats;
      var hbRetentionDays = require('./routes/ops').HEARTBEAT_RETENTION_DAYS;
      var runHeartbeatPrune = function (phase) {
        pruneHeartbeats().then(function (n) {
          if (n > 0) logMajor('agent_heartbeats prune (' + phase + '): removed ' + n + ' rows older than ' + hbRetentionDays + 'd');
        }).catch(function (err) {
          console.error('[heartbeat-cleanup] error', err);
        });
      };
      var hbCleanupInterval = setInterval(function () { runHeartbeatPrune('daily'); }, 24 * 60 * 60 * 1000);
      if (hbCleanupInterval.unref) hbCleanupInterval.unref();
      intervalIds.push(hbCleanupInterval);
      var hbCleanupBoot = setTimeout(function () { runHeartbeatPrune('boot'); }, 60 * 1000);
      if (hbCleanupBoot.unref) hbCleanupBoot.unref();
      logMajor('Heartbeat cleanup registered (daily, ' + hbRetentionDays + 'd retention, primary-only)');
    } catch (hbErr) {
      logMajor('Heartbeat cleanup registration failed: ' + hbErr.message);
    }

    logMajor('[workers] Primary-instance gate active. SLA_MODE=primary on 1 instance. Multi-instance scaling not supported on disk-attached services.');
  } else {
    logMajor('SLA MODE: passive (no SLA mutations)');
    // #66: dispatchUnpaidCaseReminders interval moved to the primary
    // branch above (it mutates case status + queues notifications,
    // which violates passive-mode's "no SLA mutations" contract).
    logMajor('[workers] Non-primary instance — workers skipped (SLA_MODE=' + CONFIG.SLA_MODE + ').');
  }

  var PORT = CONFIG.PORT;
  var server = app.listen(PORT, function() {
    var baseUrl = String(process.env.BASE_URL || '').trim();
    logMajor('Tashkheesa portal running on port ' + PORT + (baseUrl ? ' (' + baseUrl + ')' : ''));
  });

  module.exports._server = server;
}).catch(function(err) {
  logFatal('Boot failed — database initialization error', err);
  process.exit(1);
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logMajor('Graceful shutdown started (' + signal + ')');
  var forceTimer = setTimeout(function() {
    logFatal('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000);
  if (forceTimer.unref) forceTimer.unref();

  try {
    if (slaSweepIntervalId) { clearInterval(slaSweepIntervalId); slaSweepIntervalId = null; }
  } catch (e) {}

  // Theme 6 §4-A — clear every long-lived setInterval registered on boot.
  try {
    for (var ii = 0; ii < intervalIds.length; ii++) {
      try { clearInterval(intervalIds[ii]); } catch (_) {}
    }
    intervalIds.length = 0;
  } catch (e) {}

  // Theme 6 §4-A — stop the Instagram scheduler if it was started.
  try {
    if (igSchedulerInstance && typeof igSchedulerInstance.stop === 'function') {
      igSchedulerInstance.stop();
    }
    igSchedulerInstance = null;
  } catch (e) {}

  // Theme 6 §4-A — stop the mac-mini SSH probe (its interval id is also in
  // intervalIds[] above, but this also resets the module-private state).
  try {
    var stopMacMiniProbe = require('./routes/ops').stopMacMiniProbe;
    if (typeof stopMacMiniProbe === 'function') stopMacMiniProbe();
  } catch (e) {}

  // Stop pg-boss job queue
  try { stopJobQueue(); } catch (e) {}

  var server = module.exports._server;
  if (server) {
    server.close(async function() {
      try { if (pool && typeof pool.end === 'function') await pool.end(); } catch (e) { logFatal('Error closing DB pool during shutdown', e); }
      logMajor('Graceful shutdown complete');
      process.exit(0);
    });
  } else {
    try {
      if (pool && typeof pool.end === 'function') { pool.end().then(function() { process.exit(0); }); }
      else { process.exit(0); }
    } catch (e) { process.exit(1); }
  }
}

process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });

// DEPRECATED — Theme 7 sub-issue B (2026-05-10).
//
// runSlaReminderJob's two loops are now no-ops:
//   - Reminder loop (60-min sla_reminder_doctor + sla_reminder_sent
//     column flag): consolidated into case_sla_worker.handlePreBreach,
//     which dedupes via per-(case, doctor) dedupe_key on the
//     notifications row instead of the column flag.
//   - Breach loop (raw `status='breached'` + issueBreachRefundSafe +
//     sla_breached_doctor/admin/superadmin in-app bells):
//     consolidated into case_sla_worker.handleBreach →
//     case_lifecycle.markSlaBreach (canonical), which now also fires
//     issueBreachRefundSafe + the patient breach bell. The doctor and
//     ops in-app bells are intentionally dropped (channel shift to
//     WhatsApp via sendSlaReminder + dispatchSlaBreach).
//
// Kept callable so the existing
//   `await runSlaReminderJob()` invocation at runSlaEnforcementSweep
// does not crash. Scheduled for deletion in a follow-up PR after 30
// days of stable canonical-worker behaviour.
//
// See docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md § sub-issue B.
async function runSlaReminderJob() {
  return;
}

// Demo data seeding (staging only)
async function seedDemoData() {
  var existingUsers = await safeGet('SELECT COUNT(*) as c FROM users', [], { c: 0 });
  if (existingUsers && existingUsers.c > 0) {
    logMajor('Skipping demo seed – users already exist.');
    return;
  }

  var now = new Date();
  var dayMs = 24 * 60 * 60 * 1000;
  var patientId = 'demo-patient';
  var doctorId = 'demo-radiology-doctor';
  var superadminId = 'demo-superadmin';
  var specialtyId = 'demo-specialty-radiology';
  var serviceId = 'demo-service-radiology';
  var passwordHash = await hash('demo1234');
  var completedOrderId = randomUUID();
  var inReviewOrderId = randomUUID();
  var breachedOrderId = randomUUID();

  var completedCreated = new Date(now.getTime() - 5 * dayMs);
  var completedAccepted = new Date(completedCreated.getTime() + 2 * 60 * 60 * 1000);
  var completedDeadline = new Date(completedAccepted.getTime() + 3 * dayMs);
  var completedCompleted = new Date(completedAccepted.getTime() + 4 * 60 * 60 * 1000);

  var inReviewCreated = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  var inReviewAccepted = new Date(inReviewCreated.getTime() + 30 * 60 * 1000);
  var inReviewDeadline = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  var breachedCreated = new Date(now.getTime() - 4 * dayMs);
  var breachedAccepted = new Date(breachedCreated.getTime() + 2 * 60 * 60 * 1000);
  var breachedDeadline = new Date(breachedAccepted.getTime() + 24 * 60 * 60 * 1000);
  var breachedAt = new Date(breachedDeadline.getTime() + 2 * 60 * 60 * 1000);

  var INSERT_ORDER_SQL = 'INSERT INTO orders (id, patient_id, doctor_id, specialty_id, service_id, sla_hours, status, price, doctor_fee, created_at, accepted_at, deadline_at, completed_at, breached_at, reassigned_count, notes, payment_status, payment_method, payment_reference, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)';

  try {
    await withTransaction(async function(client) {
      await client.query('INSERT INTO specialties (id, name) VALUES ($1, $2)', [specialtyId, 'Radiology']);
      await client.query('INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, currency, payment_link) VALUES ($1, $2, $3, $4, $5, $6, $7)', [serviceId, specialtyId, 'Radiology review', 3500, 1500, 'EGP', null]);

      var createdAtIso = now.toISOString();
      await client.query('INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [patientId, 'demo.patient@tashkheesa.com', passwordHash, 'Demo Patient', 'patient', null, true, createdAtIso]);
      await client.query('INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [doctorId, 'demo.doctor@tashkheesa.com', passwordHash, 'Radiology Doctor', 'doctor', specialtyId, true, createdAtIso]);
      await client.query('INSERT INTO users (id, email, password_hash, name, role, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [superadminId, 'demo.superadmin@tashkheesa.com', passwordHash, 'Superadmin', 'superadmin', true, createdAtIso]);

      await client.query(INSERT_ORDER_SQL, [completedOrderId, patientId, doctorId, specialtyId, serviceId, 72, 'completed', 3500, 1500, completedCreated.toISOString(), completedAccepted.toISOString(), completedDeadline.toISOString(), completedCompleted.toISOString(), null, 0, 'Demo completed order', 'paid', 'card', 'DEMO-PAID', completedCreated.toISOString()]);
      await client.query(INSERT_ORDER_SQL, [inReviewOrderId, patientId, doctorId, specialtyId, serviceId, 24, 'in_review', 4000, 1800, inReviewCreated.toISOString(), inReviewAccepted.toISOString(), inReviewDeadline.toISOString(), null, null, 0, 'Demo VIP in-review case', 'unpaid', 'manual', 'DEMO-VIP', inReviewCreated.toISOString()]);
      await client.query(INSERT_ORDER_SQL, [breachedOrderId, patientId, doctorId, specialtyId, serviceId, 72, 'breached', 3200, 1200, breachedCreated.toISOString(), breachedAccepted.toISOString(), breachedDeadline.toISOString(), null, breachedAt.toISOString(), 1, 'Demo breached order', 'unpaid', 'manual', 'DEMO-BREACHED', breachedCreated.toISOString()]);

      var INSERT_EVENT_SQL = 'INSERT INTO order_events (id, order_id, label, meta, at) VALUES ($1, $2, $3, $4, $5)';
      await client.query(INSERT_EVENT_SQL, [randomUUID(), completedOrderId, 'Order completed (demo)', null, completedCompleted.toISOString()]);
      await client.query(INSERT_EVENT_SQL, [randomUUID(), inReviewOrderId, 'Order in review (demo)', null, now.toISOString()]);
      await client.query(INSERT_EVENT_SQL, [randomUUID(), breachedOrderId, 'Order breached (demo)', null, breachedAt.toISOString()]);

      if (tableExists('order_files')) {
        var INSERT_FILE_SQL = 'INSERT INTO order_files (id, order_id, url, label, created_at) VALUES ($1, $2, $3, $4, $5)';
        await client.query(INSERT_FILE_SQL, [randomUUID(), completedOrderId, 'uploads/demo/xray-report.pdf', 'X-Ray Report', completedCompleted.toISOString()]);
        await client.query(INSERT_FILE_SQL, [randomUUID(), inReviewOrderId, 'uploads/demo/ct-scan.pdf', 'CT Scan', inReviewCreated.toISOString()]);
        await client.query(INSERT_FILE_SQL, [randomUUID(), breachedOrderId, 'uploads/demo/ultrasound.pdf', 'Ultrasound', breachedCreated.toISOString()]);
      }

      if (tableExists('order_additional_files')) {
        var INSERT_ADDL_FILE_SQL = 'INSERT INTO order_additional_files (id, order_id, url, label, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)';
        await client.query(INSERT_ADDL_FILE_SQL, [randomUUID(), inReviewOrderId, 'uploads/demo/patient-notes.pdf', 'Patient Notes', patientId, inReviewCreated.toISOString()]);
        await client.query(INSERT_ADDL_FILE_SQL, [randomUUID(), breachedOrderId, 'uploads/demo/previous-scans.pdf', 'Previous Scans', patientId, breachedCreated.toISOString()]);
      }

      if (tableExists('notifications')) {
        var INSERT_NOTIF_SQL = 'INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, at) VALUES ($1, $2, $3, $4, $5, $6, $7)';
        var ts = now.toISOString();
        await client.query(INSERT_NOTIF_SQL, [randomUUID(), completedOrderId, patientId, 'internal', 'demo_payment_received', 'queued', ts]);
        await client.query(INSERT_NOTIF_SQL, [randomUUID(), inReviewOrderId, doctorId, 'internal', 'demo_order_assigned', 'queued', ts]);
        await client.query(INSERT_NOTIF_SQL, [randomUUID(), breachedOrderId, doctorId, 'internal', 'demo_order_breached', 'queued', ts]);
      }
    });
    logMajor('Demo data seeded for staging mode.');
  } catch (err) {
    logFatal('Demo seed failed', err);
  }
}
