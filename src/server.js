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
(function validateCriticalEnvVars() {
  var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
  var missing = [];

  required.forEach(function(varName) {
    var value = process.env[varName];
    if (!value || String(value).trim() === '') {
      missing.push(varName);
    }
  });

  if (missing.length > 0) {
    logFatal('FATAL: Missing required environment variables: ' + missing.join(', '));
    process.exit(1);
  }

  logVerbose('All required env vars present: ' + required.join(', '));
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
var publicRoutes = require('./routes/public');
var publicOrdersRoutes = require('./routes/public_orders');
var intakeRoutes = require('./routes/intake');
var orderFlowRoutes = require('./routes/order_flow');
// Legacy sla_worker.js disabled — consolidated on case_sla_worker.js to avoid
// duplicate SLA sweeps and potential race conditions. See audit 2026-04-21.
// var { startSlaWorker, runSlaSweep } = require('./sla_worker');
var { runSlaSweep: runWatcherSweep } = require('./sla_watcher');
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

// CSP nonce
app.use(function(req, res, next) {
  try {
    var nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    var csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob: https://ucarecdn.com https://res.cloudinary.com https://api.qrserver.com",
      "font-src 'self' data: https://ucarecdn.com https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://ucarecdn.com https://fonts.googleapis.com",
      "script-src 'self' 'nonce-" + nonce + "' https://ucarecdn.com https://cdn.jsdelivr.net https://media.twiliocdn.com https://unpkg.com",
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

// Fallback translation helpers
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

app.get('/files/:fileId', async function(req, res) {
  var fileId = String(req.params.fileId || '').trim();
  if (!fileId) {
    return sendErrorResponse(res, 400, 'Missing file ID', req.originalUrl, req.method, req.requestId);
  }
  if (!req.user) {
    var next = encodeURIComponent(req.originalUrl || '/files/' + fileId);
    return res.redirect('/login?next=' + next);
  }
  var file = await safeGet('SELECT id, order_id, url, label FROM order_files WHERE id = $1 LIMIT 1', [fileId], null);
  if (!file) {
    return sendErrorResponse(res, 404, 'File not found: ' + fileId, req.originalUrl, req.method, req.requestId);
  }
  var order = await safeGet('SELECT id, patient_id, doctor_id, accepted_at, status FROM orders WHERE id = $1 LIMIT 1', [file.order_id], null);
  if (!order) return res.status(404).type('text/plain').send('Order not found');

  var role = String(req.user.role || '').toLowerCase();
  var userId = String(req.user.id || '');
  var allowed = false;

  if (role === 'superadmin' || role === 'admin') {
    allowed = true;
  } else if (role === 'patient') {
    allowed = !!order.patient_id && String(order.patient_id) === userId;
  } else if (role === 'doctor') {
    var isAssigned = !!order.doctor_id && String(order.doctor_id) === userId;
    var isAccepted = !!order.accepted_at;
    allowed = isAssigned && isAccepted;
  }

  if (!allowed) {
    logMajor('[FILES] blocked role=' + role + ' user=' + userId + ' file=' + fileId + ' order=' + order.id + ' req=' + req.requestId);
    return res.status(403).type('text/plain').send('Forbidden');
  }

  var urlOrPath = String(file.url || '').trim();
  if (!urlOrPath) return res.status(404).type('text/plain').send('File missing');

  // Legacy: rows where url is an HTTP URL (Uploadcare etc.) — redirect directly.
  if (isHttpUrl(urlOrPath)) {
    return res.redirect(302, urlOrPath);
  }

  // Otherwise treat as an R2 storage key; generate a short-lived signed URL.
  // Pre-migration synthetic local paths (e.g. 'orders/<id>/<filename>') will resolve to
  // a signed URL pointing to a non-existent R2 object — those are unrecoverable
  // (the local disk that held them was wiped on the prior Render deploy).
  try {
    var storage = require('./storage');
    var downloadName = safeFilename(file.label || path.basename(urlOrPath));
    var signedUrl = await storage.getSignedDownloadUrl(urlOrPath, 3600, { downloadName: downloadName });
    return res.redirect(302, signedUrl);
  } catch (err) {
    logMajor('[FILES] R2 signed URL failed file=' + fileId + ' key=' + urlOrPath + ' err=' + (err && err.message ? err.message : String(err)) + ' req=' + req.requestId);
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
      if (!p.startsWith('/lang/') && !EXEMPT_PATHS.has(p) && !isAssetRequest(p)) {
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

  try {
    var { migrateForMobileApi } = require('./migrate_mobile_api');
    migrateForMobileApi(pool);
  } catch (err) {
    console.error('[migrate] Mobile API migration failed:', err.message);
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
app.use('/', superadminRoutes);
app.use('/', exportRoutes);
app.use('/', adminRoutes);
app.use('/', publicRoutes);
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

// Email sender stub for the mobile API helpers — same shape as the OTP stub.
// The portal routes import src/services/emailService.js directly, so this only affects
// api_v1 (mobile). To enable real email here, replace with: require('./services/emailService').sendEmail
var sendEmailStub = async function(opts) {
  console.warn('[EMAIL STUB] Mobile API email sender not wired. To: ' + (opts && opts.to ? opts.to : '?') + ' subject: "' + (opts && opts.subject ? opts.subject : '?') + '" — not sent.');
  return { stub: true };
};

var apiV1 = require('./routes/api_v1')(pool, {
  safeGet: safeGet,
  safeAll: safeAll,
  safeRun: execute,
  sendOtpViaTwilio: sendOtpViaTwilio,
  sendEmail: sendEmailStub,
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
    try { runWatcherSweep(new Date()); } catch (err) { logFatal('SLA watcher sweep error', err); }
    try { await runSlaReminderJob(); } catch (err) { logFatal('SLA reminder job error', err); }
    try { dispatchUnpaidCaseReminders(); } catch (err) { logFatal('Unpaid reminder sweep error', err); }
    try {
      if (typeof caseLifecycle.sweepExpiredDoctorAccepts === 'function') {
        caseLifecycle.sweepExpiredDoctorAccepts();
      }
    } catch (err) { logFatal('Doctor accept sweep failed', err); }
    try { logVerbose('[SLA] enforcement sweep ran (' + srcLabel + ')'); } catch (e) {}
  } catch (err) {
    logFatal('SLA enforcement sweep failed', err);
  } finally {
    slaEnforcementRunning = false;
  }
}

var { startJobQueue, stopJobQueue, scheduleSlaSweep } = require('./job_queue');

// Boot: wait for DB migration before starting workers
_dbReady.then(async function() {
  // Start pg-boss job queue (handles case-intelligence, auto-assign, reprocess)
  try {
    await startJobQueue();
  } catch (jqErr) {
    logMajor('Job queue start failed (falling back to direct execution): ' + jqErr.message);
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
    if (!slaBoss) startCaseSlaWorker();
    startVideoScheduler();
    startAcceptanceWatcher();

    setTimeout(function() {
      try { runSlaEnforcementSweep('boot'); } catch (e) {}
    }, 1000);

    slaSweepIntervalId = setInterval(function() {
      runSlaEnforcementSweep('interval');
    }, SLA_ENFORCEMENT_INTERVAL_MS);
    if (slaSweepIntervalId.unref) slaSweepIntervalId.unref();

    logMajor('Payment reminders dispatched via SLA sweep (every 5 min)');
  } else {
    logMajor('SLA MODE: passive (no SLA mutations)');
    setInterval(function() {
      try { dispatchUnpaidCaseReminders(); } catch (err) { console.error('[payment-reminders] error', err); }
    }, 15 * 60 * 1000);
    logMajor('Payment reminders registered (every 15 min, passive mode)');
  }

  // Auto-close stale conversations
  try {
    var closeStaleConversations = require('./routes/messaging').closeStaleConversations;
    setTimeout(function() { try { closeStaleConversations(); } catch (_) {} }, 5000);
    setInterval(function() { try { closeStaleConversations(); } catch (_) {} }, 24 * 60 * 60 * 1000);
    logMajor('Conversation auto-close registered (daily)');
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
    logMajor('Appointment reminder cron registered (every 15 min)');
  } catch (cronErr) {
    logMajor('Appointment reminder cron registration failed: ' + cronErr.message);
  }

  // Campaign cron
  try {
    var campaignCron = require('node-cron');
    var processCampaign = require('./routes/campaigns').processCampaign;
    campaignCron.schedule('*/5 * * * *', async function() {
      try {
        var now = new Date().toISOString();
        var scheduled = await safeAll(
          "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND scheduled_at <= $1",
          [now], []
        );
        for (var ci = 0; ci < scheduled.length; ci++) {
          try {
            await execute("UPDATE email_campaigns SET status = 'sending' WHERE id = $1 AND status = 'scheduled'", [scheduled[ci].id]);
            setImmediate(function() { try { processCampaign(scheduled[ci].id); } catch (_) {} });
          } catch (_) {}
        }
        if (scheduled.length > 0) {
          logMajor('[campaigns] Triggered ' + scheduled.length + ' scheduled campaign(s)');
        }
      } catch (_) {}
    });
    logMajor('Campaign scheduler cron registered (every 5 min)');
  } catch (campaignCronErr) {
    logMajor('Campaign scheduler cron registration failed: ' + campaignCronErr.message);
  }

  // Instagram scheduler
  try {
    var igScheduler = new InstagramScheduler();
    igScheduler.start();
  } catch (igErr) {
    logMajor('Instagram scheduler start failed: ' + igErr.message);
  }

  // Notification worker
  var runNotificationWorker = require('./notification_worker').runNotificationWorker;
  setInterval(async function() {
    try { await runNotificationWorker(50); } catch (err) { console.error('[notify-worker] interval error', err); }
  }, 30000);
  setTimeout(async function() {
    try { await runNotificationWorker(50); console.log('[notify-worker] initial run complete'); } catch (err) { console.error('[notify-worker] initial run error', err); }
  }, 5000);
  logMajor('Notification worker registered (every 30s)');

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

// SLA reminder + breach marker (primary mode only)
async function runSlaReminderJob() {
  if (CONFIG.SLA_MODE !== 'primary') return;

  var sweepStartTime = Date.now();
  var now = new Date();
  var nowIso = now.toISOString();
  var reminders = 0;
  var breaches = 0;

  var IN_FLIGHT_WHERE = "\n    deadline_at IS NOT NULL\n    AND completed_at IS NULL\n    AND breached_at IS NULL\n    AND COALESCE(status, '') NOT IN ('completed','cancelled','canceled','rejected')\n  ";

  try {
    await withTransaction(async function(client) {
      var result = await client.query(
        'SELECT id, doctor_id, deadline_at FROM orders WHERE ' + IN_FLIGHT_WHERE + ' AND COALESCE(sla_reminder_sent, false) = false'
      );
      var reminderOrders = result.rows;

      for (var ri = 0; ri < reminderOrders.length; ri++) {
        var o = reminderOrders[ri];
        if (!o.deadline_at) continue;
        var diffMin = Math.floor((new Date(o.deadline_at).getTime() - now.getTime()) / 60000);
        var SLA_REMINDER_MINUTES = Number(process.env.SLA_REMINDER_MINUTES || 60);
        if (diffMin > 0 && diffMin <= SLA_REMINDER_MINUTES && o.doctor_id) {
          queueNotification({
            orderId: o.id, toUserId: o.doctor_id, channel: 'internal',
            template: 'sla_reminder_doctor', status: 'queued',
            dedupe_key: 'sla:reminder:' + o.id + ':doctor'
          });
          await client.query('UPDATE orders SET sla_reminder_sent = true, updated_at = $1 WHERE id = $2', [nowIso, o.id]);
          logOrderEvent({ orderId: o.id, label: 'SLA reminder sent to doctor (<= 60 min to deadline)', actorRole: 'system' });
          reminders += 1;
        }
      }
    });
  } catch (err) { logFatal('SLA reminder transaction failed', err); }

  try {
    await withTransaction(async function(client) {
      var opsResult = await client.query("SELECT id, role FROM users WHERE role IN ('admin','superadmin') AND COALESCE(is_active, true) = true");
      var opsUsers = opsResult.rows;
      var breachResult = await client.query('SELECT id, doctor_id, deadline_at FROM orders WHERE ' + IN_FLIGHT_WHERE);
      var breachOrders = breachResult.rows;

      for (var bi = 0; bi < breachOrders.length; bi++) {
        var o = breachOrders[bi];
        if (!o.deadline_at) continue;
        if (new Date(o.deadline_at) < now) {
          var currentResult = await client.query('SELECT status, breached_at FROM orders WHERE id = $1', [o.id]);
          var current = currentResult.rows[0] || null;
          if (current && !current.breached_at) {
            await client.query('UPDATE orders SET status = $1, breached_at = $2, updated_at = $3, sla_reminder_sent = true WHERE id = $4', ['breached', nowIso, nowIso, o.id]);
            logOrderEvent({ orderId: o.id, label: 'SLA breached – deadline passed without completion', actorRole: 'system' });
            if (o.doctor_id) {
              queueNotification({ orderId: o.id, toUserId: o.doctor_id, channel: 'internal', template: 'sla_breached_doctor', status: 'queued', dedupe_key: 'sla:breach:' + o.id + ':doctor' });
            }
            for (var ui = 0; ui < opsUsers.length; ui++) {
              var u = opsUsers[ui];
              queueNotification({ orderId: o.id, toUserId: u.id, channel: 'internal', template: u.role === 'superadmin' ? 'sla_breached_superadmin' : 'sla_breached_admin', status: 'queued', dedupe_key: 'sla:breach:' + o.id + ':' + u.role });
            }
            breaches += 1;
          }
        }
      }
    });
  } catch (err) { logFatal('SLA breach transaction failed', err); }

  var sweepDurationMs = Date.now() - sweepStartTime;
  if (reminders || breaches || sweepDurationMs > 1000) {
    logMajor('[SLA job] completed in ' + sweepDurationMs + 'ms — reminders=' + reminders + ', breaches=' + breaches);
  }
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
