require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { bootCheck } = require('./bootCheck');
const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const SERVER_STARTED_AT = Date.now();
const SERVER_STARTED_AT_ISO = new Date(SERVER_STARTED_AT).toISOString();

function getGitSha() {
  // Prefer an injected value (deploy pipelines) but fall back to local git if available.
  const envSha = String(process.env.GIT_SHA || process.env.COMMIT_SHA || '').trim();
  if (envSha) return envSha;
  try {
    // eslint-disable-next-line global-require
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

const GIT_SHA = getGitSha();
// src/server.js

const express = require('express');
const { randomUUID, randomBytes } = require('crypto');
const { db, migrate } = require('./db');
const { hash, attachUser } = require('./auth');
const { queueNotification } = require('./notify');
const { logOrderEvent } = require('./audit');
const { baseMiddlewares } = require('./middleware');
const i18n = require('./i18n');
const {
  MODE,
  verbose: logVerbose,
  major: logMajor,
  fatal: logFatal,
  attachRequestId,
  accessLogger,
  logError
} = require('./logger');
bootCheck({ ROOT, MODE });
// Centralized config for server.js (normalize env reads + defaults)
const CONFIG = Object.freeze({
  ROOT,
  MODE,
  // SLA writer mode:
  // - primary: this instance performs SLA mutations (breach marking + reminders + escalations)
  // - passive: read-only (no SLA DB writes)
  // Default to primary in local development so the pipeline is testable out of the box.
  SLA_MODE:
    process.env.SLA_MODE ||
    (MODE === 'development' ? 'primary' : 'passive'),
  PORT: Number(process.env.PORT || 3000),

  // Staging Basic Auth (primary keys: BASIC_AUTH_USER/BASIC_AUTH_PASS)
  // Back-compat: STAGING_USER/STAGING_PASS
  BASIC_AUTH_USER: process.env.BASIC_AUTH_USER || process.env.STAGING_USER || '',
  BASIC_AUTH_PASS: process.env.BASIC_AUTH_PASS || process.env.STAGING_PASS || ''
});

// Startup banner (single source of truth for runtime config)
const DB_CANDIDATES = [
  process.env.PORTAL_DB_PATH,
  process.env.DB_PATH,
].filter(Boolean);

const RESOLVED_DB_PATH = DB_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}) || null;

logMajor(
  `🔧 Boot config: MODE=${CONFIG.MODE} SLA_MODE=${CONFIG.SLA_MODE} PORT=${CONFIG.PORT}` +
    (RESOLVED_DB_PATH ? ` DB=${RESOLVED_DB_PATH}` : ' DB=(not found yet)')
);

if (CONFIG.SLA_MODE === 'primary') {
  logMajor('⚠️  SLA_MODE=primary — ensure ONLY ONE server instance runs in primary');
}
const { safeAll, safeGet, tableExists } = require('./sql-utils');

const authRoutes = require('./routes/auth');
const doctorRoutes = require('./routes/doctor');
const patientRoutes = require('./routes/patient');
const { router: superadminRoutes } = require('./routes/superadmin');
const exportRoutes = require('./routes/exports'); // CSV exports
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const publicOrdersRoutes = require('./routes/public_orders');
const intakeRoutes = require('./routes/intake');
const orderFlowRoutes = require('./routes/order_flow');
const { startSlaWorker, runSlaSweep } = require('./sla_worker');
const { scheduleSlaWatcher } = require('./jobs/sla_watcher');
const { runSlaSweep: runWatcherSweep } = require('./sla_watcher');
const { runSlaSweep: runSlaSweepJob } = require('./sla');
const paymentRoutes = require('./routes/payments');
const { checkAndMarkBreaches } = require('./sla');
const { startCaseSlaWorker } = require('./case_sla_worker');


const app = express();

// Basic hardening
app.disable('x-powered-by');

// If behind a proxy (Render/Railway/NGINX/Cloudflare), trust the first hop so secure cookies + req.ip work.
if (MODE === 'production' || MODE === 'staging') {
  app.set('trust proxy', 1);
}

// Baseline security headers (helmet should already be applied in baseMiddlewares, but this is a safe fallback)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return next();
});

// Normalize cookie security defaults (explicit everywhere we set cookies)
const COOKIE_SECURE = MODE === 'production' || MODE === 'staging';
const COOKIE_SAMESITE = 'lax';

// Request correlation + access logs (single source of truth)
app.use(attachRequestId);
app.use(accessLogger());

// Staging Basic Auth (normalized via CONFIG)
const STAGING_AUTH_USER = CONFIG.BASIC_AUTH_USER;
const STAGING_AUTH_PASS = CONFIG.BASIC_AUTH_PASS;

// Fail-fast: never run staging basic auth with weak defaults
if (MODE === 'staging') {
  if (!STAGING_AUTH_USER || !STAGING_AUTH_PASS) {
    logFatal(
      'Missing BASIC_AUTH_USER/BASIC_AUTH_PASS in staging — refusing to start with empty credentials.'
    );
    process.exit(1);
  }
}
const EXEMPT_PATHS = new Set(['/health', '/status', '/healthz', '/__version']);
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.map'
]);

function isAssetRequest(reqPath) {
  if (!reqPath) return false;
  if (reqPath.startsWith('/public/') || reqPath.startsWith('/assets/')) return true;
  if (reqPath === '/favicon.ico') return true;
  const ext = path.extname(reqPath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function sendAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Tashkheesa Staging"');
  return res.status(401).send('Authentication required');
}

function stagingBasicAuth(req, res, next) {
  if (MODE !== 'staging') return next();
  const normalizedPath = req.path || '/';
  if (EXEMPT_PATHS.has(normalizedPath) || isAssetRequest(normalizedPath)) {
    return next();
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return sendAuthChallenge(res);
  }
  const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const [user = '', pass = ''] = credentials.split(':');
  if (user === STAGING_AUTH_USER && pass === STAGING_AUTH_PASS) {
    return next();
  }
  logMajor(`Staging auth failed for ${normalizedPath}`);
  return sendAuthChallenge(res);
}

if (MODE === 'staging') {
  app.use(stagingBasicAuth);
}

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// ----------------------------------------------------
// CRASH GUARDRAILS (fail-fast, no silent corruption)
// ----------------------------------------------------
process.on('unhandledRejection', (reason) => {
  try {
    logFatal('UNHANDLED_REJECTION', reason);
  } catch (e) {
    console.error('UNHANDLED_REJECTION', reason);
  } finally {
    // Give logs a moment, then exit
    setTimeout(() => process.exit(1), 250).unref();
  }
});

process.on('uncaughtException', (err) => {
  try {
    logFatal('UNCAUGHT_EXCEPTION', err);
  } catch (e) {
    console.error('UNCAUGHT_EXCEPTION', err);
  } finally {
    setTimeout(() => process.exit(1), 250).unref();
  }
});

// Core middlewares (helmet, cookies, rate limit, i18n, user from JWT)
baseMiddlewares(app);
// ----------------------------------------------------
// CSP NONCE (allow inline <script> blocks safely)
// ----------------------------------------------------
app.use((req, res, next) => {
  try {
    const nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",

      // Uploadcare assets are served from ucarecdn.com
      "img-src 'self' data: blob: https://ucarecdn.com",
      "font-src 'self' data: https://ucarecdn.com",
      "style-src 'self' 'unsafe-inline' https://ucarecdn.com",

      // Allow our nonce inline scripts + the Uploadcare widget script CDN
      `script-src 'self' 'nonce-${nonce}' https://ucarecdn.com`,

      // Uploadcare uploads/API
      "connect-src 'self' https://upload.uploadcare.com https://api.uploadcare.com https://ucarecdn.com",

      // Widget may use iframes in some flows
      "frame-src 'self' https://uploadcare.com https://ucarecdn.com",
    ].join('; ');

    // Override any CSP set earlier (helmet/baseMiddlewares)
    res.setHeader('Content-Security-Policy', csp);
  } catch (e) {}
  next();
});
// i18n (must run after cookies + session). Support multiple export styles.
// This ensures language switching works consistently across all pages.
try {
  const mw =
    (typeof i18n === 'function' && i18n) ||
    (i18n && typeof i18n.middleware === 'function' && i18n.middleware) ||
    (i18n && typeof i18n.i18nMiddleware === 'function' && i18n.i18nMiddleware) ||
    null;

  if (mw) app.use(mw);
} catch (e) {
  // If i18n isn't wired yet, keep the app booting.
}

// Fallback: ensure templates always have translation helpers.
// tt(key, enFallback, arFallback) -> returns best available string.
app.use((req, res, next) => {
  if (res && res.locals) {
    if (typeof res.locals.t !== 'function') {
      res.locals.t = (key, fallback = '') => fallback || key;
    }
    if (typeof res.locals.tt !== 'function') {
      res.locals.tt = (key, enFallback = '', arFallback = '') => {
        const lang = res.locals.lang || (req.session && req.session.lang) || (req.cookies && req.cookies.lang) || 'en';
        const isAr = lang === 'ar';
        // If an i18n middleware later sets res.locals.t, this still stays safe.
        const fromT = (typeof res.locals.t === 'function') ? res.locals.t(key, '') : '';
        if (fromT && fromT !== key) return fromT;
        return isAr ? (arFallback || enFallback || key) : (enFallback || key);
      };
    }
  }
  return next();
});
// Fallback: ensure templates always have lang/dir (in case a route forgets to set them)
app.use((req, res, next) => {
  if (res && res.locals) {
    if (!res.locals.lang) {
      const lang = (req.session && req.session.lang) || (req.cookies && req.cookies.lang) || 'en';
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
// Attach req.user from JWT/cookies (safe, does not force login)
app.use(attachUser);
// Keep template locals in sync in case earlier middleware set locals.user before attachUser ran
app.use((req, res, next) => {
  if (res && res.locals) {
    res.locals.user = req.user || null;
  }
  return next();
});

// ----------------------------------------------------
// CSRF GUARDRAILS (log by default; enforce when ready)
// ----------------------------------------------------
// Modes:
//  - off: disabled
//  - log: log missing/invalid tokens but DO NOT block (safe while you retrofit forms)
//  - enforce: block unsafe requests without valid token
const CSRF_MODE = String(process.env.CSRF_MODE || (MODE === 'production' || MODE === 'staging' ? 'log' : 'log'))
  .trim()
  .toLowerCase();
const CSRF_COOKIE = 'csrf_token';

function ensureCsrfCookie(req, res) {
  const existing = req.cookies && req.cookies[CSRF_COOKIE];
  if (existing && String(existing).length >= 16) return String(existing);
  const token = randomBytes(32).toString('hex');
  // httpOnly is OK because the server injects the value into HTML forms via res.locals
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
  // Prefer explicit header for fetch/XHR, then form field
  const h = req.get('x-csrf-token');
  if (h && String(h).trim()) return String(h).trim();
  const b = req.body && (req.body._csrf || req.body.csrf);
  if (b && String(b).trim()) return String(b).trim();
  return '';
}

function csrfFail(req, res) {
  const requestId = req.requestId;
  const wantsJson = (req.get('accept') || '').includes('application/json');
  if (wantsJson) {
    return res.status(403).json({ ok: false, error: 'CSRF', requestId });
  }
  return res.status(403).type('text/plain').send(`Forbidden (CSRF). requestId=${requestId}`);
}

app.use((req, res, next) => {
  if (CSRF_MODE === 'off') {
    if (res && res.locals) {
      res.locals.csrfToken = null;
      res.locals.csrfField = () => '';
    }
    return next();
  }

  // Exempt health + assets + internal version endpoints
  const p = req.path || '';
  if (EXEMPT_PATHS.has(p) || isAssetRequest(p)) {
    return next();
  }
  // Exempt payment provider callbacks/webhooks if you add them later
  if (p.startsWith('/payments/webhook')) {
    return next();
  }

  const cookieToken = ensureCsrfCookie(req, res);

  // Make it easy to retrofit forms: <%- csrfField() %>
  if (res && res.locals) {
    res.locals.csrfToken = cookieToken;
    res.locals.csrfField = () => `<input type="hidden" name="_csrf" value="${cookieToken}">`;
  }

  if (isSafeMethod(req.method)) return next();

  const provided = readCsrfToken(req);
  const ok = provided && provided === cookieToken;

  if (!ok) {
    const msg = `[CSRF] ${CSRF_MODE} missing/invalid token for ${req.method} ${req.originalUrl || req.url} req=${req.requestId}`;
    if (CSRF_MODE === 'enforce') {
      logMajor(msg);
      return csrfFail(req, res);
    }
    // log mode: record but allow (safe while you retrofit forms)
    logMajor(msg);
  }

  return next();
});

// Remember last visited page (helps language switching return you to the same page)
app.use((req, res, next) => {
  try {
    if (req.method === 'GET') {
      const p = req.path || '/';
      // Only store real pages (skip assets, health endpoints, and language switch itself)
      if (!p.startsWith('/lang/') && !EXEMPT_PATHS.has(p) && !isAssetRequest(p)) {
        res.cookie('last_path', req.originalUrl || '/', {
          httpOnly: false,
          sameSite: COOKIE_SAMESITE,
          secure: COOKIE_SECURE,
          maxAge: 7 * 24 * 60 * 60 * 1000
        });
      }
    }
  } catch (e) {
    // ignore
  }
  next();
});

// Health endpoints (skip Basic Auth in staging via middleware logic)
app.get('/health', (req, res) => {
  return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
});
app.get('/status', (req, res) => {
  return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
});

// Healthcheck (preferred): includes request id + uptime for fast debugging
app.get('/healthz', (req, res) => {
  return res.json({
    ok: true,
    mode: MODE,
    timestamp: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    requestId: req.requestId
  });
});

// Build/version info (safe): helps confirm which build is running
app.get('/__version', (req, res) => {
  return res.json({
    ok: true,
    name: pkg.name,
    version: pkg.version,
    mode: MODE,
    slaMode: CONFIG.SLA_MODE,
    startedAt: SERVER_STARTED_AT,
    startedAtIso: SERVER_STARTED_AT_ISO,
    uptimeSec: Math.floor(process.uptime()),
    gitSha: GIT_SHA,
    requestId: req.requestId
  });
});

// ----------------------------------------------------
// VERIFY (internal, work-efficient readiness snapshot)
// - Admin/Superadmin only (prevents leaking internals to patients)
// - No secrets: shows only presence + suffix for keys
// ----------------------------------------------------
function redactKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return { present: false };
  return { present: true, suffix: s.slice(-4), length: s.length };
}

function requireOpsRole(req, res) {
  if (!req.user) {
    return { ok: false, res: res.redirect('/login') };
  }
  const role = String(req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'superadmin') {
    return { ok: false, res: res.status(403).type('text/plain').send('Forbidden') };
  }
  return { ok: true };
}

function buildVerifySnapshot(req) {
  const uptimeSec = Math.floor(process.uptime());

  const requiredTables = ['users', 'orders', 'order_events'];
  const tables = {};
  requiredTables.forEach((t) => {
    try {
      tables[t] = !!tableExists(t);
    } catch (e) {
      tables[t] = false;
    }
  });

  const counts = {
    users: 0,
    doctors: 0,
    activeDoctors: 0,
    orders: 0,
    ordersByStatus: {}
  };

  if (tables.users) {
    counts.users = safeGet('SELECT COUNT(*) as c FROM users', [], { c: 0 }).c;
    counts.doctors = safeGet("SELECT COUNT(*) as c FROM users WHERE role='doctor'", [], { c: 0 }).c;
    counts.activeDoctors = safeGet(
      "SELECT COUNT(*) as c FROM users WHERE role='doctor' AND COALESCE(is_active,1)=1",
      [],
      { c: 0 }
    ).c;
  }

  if (tables.orders) {
    counts.orders = safeGet('SELECT COUNT(*) as c FROM orders', [], { c: 0 }).c;
    try {
      const rows = safeAll('SELECT status, COUNT(*) as c FROM orders GROUP BY status', [], []);
      rows.forEach((r) => {
        const k = String(r.status || 'unknown');
        counts.ordersByStatus[k] = Number(r.c || 0);
      });
    } catch (e) {
      // ignore
    }
  }

  const recentEvents = [];
  if (tables.order_events) {
    try {
      const rows = safeAll(
        'SELECT order_id, label, at FROM order_events ORDER BY at DESC LIMIT 10',
        [],
        []
      );
      rows.forEach((r) => {
        recentEvents.push({
          orderId: r.order_id,
          label: r.label,
          at: r.at
        });
      });
    } catch (e) {
      // ignore
    }
  }

  // Uploadcare config (no secrets)
  const uploadcarePublic =
    process.env.UPLOADCARE_PUBLIC_KEY ||
    process.env.UPLOADCARE_PUBLIC ||
    process.env.UPLOADCARE_KEY ||
    '';

  const snapshot = {
    ok: true,
    requestId: req.requestId,
    startedAt: SERVER_STARTED_AT,
    startedAtIso: SERVER_STARTED_AT_ISO,
    uptimeSec,
    gitSha: GIT_SHA,

    mode: MODE,
    slaMode: CONFIG.SLA_MODE,
    csrfMode: CSRF_MODE,
    port: CONFIG.PORT,
    dbPath: RESOLVED_DB_PATH,

    tables,
    counts,
    keys: {
      uploadcarePublicKey: redactKey(uploadcarePublic)
    },

    warnings: [
      CONFIG.SLA_MODE === 'primary'
        ? 'SLA_MODE=primary (ensure single instance only)'
        : null,
      CSRF_MODE === 'off' ? 'CSRF_MODE=off (not recommended for staging/production)' : null,
      !RESOLVED_DB_PATH ? 'DB path could not be resolved by server startup scan' : null
    ].filter(Boolean),

    recentEvents
  };

  return snapshot;
}

app.get('/verify', (req, res) => {
  const gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;

  const snap = buildVerifySnapshot(req);

  // Simple HTML (no new view file needed)
  res.type('text/html');
  return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tashkheesa Verify</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:18px; line-height:1.4;}
    .row{display:flex; gap:10px; flex-wrap:wrap; margin:10px 0 16px;}
    .pill{display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#f2f2f2; font-size:12px;}
    .ok{background:#e9f7ef;}
    .bad{background:#fdecea;}
    code, pre{background:#f6f6f6; padding:10px; border-radius:10px; overflow:auto;}
    table{border-collapse:collapse; width:100%; max-width:980px;}
    th,td{border-bottom:1px solid #eee; padding:8px 10px; text-align:left; font-size:13px;}
    .muted{color:#666;}
  </style>
</head>
<body>
  <h2 style="margin:0 0 6px;">Verify</h2>
  <div class="muted">Read-only readiness snapshot (admin/superadmin). requestId: <code>${snap.requestId}</code></div>

  <div class="row">
    <span class="pill ok">MODE: <b>${snap.mode}</b></span>
    <span class="pill ok">SLA_MODE: <b>${snap.slaMode}</b></span>
    <span class="pill ok">CSRF_MODE: <b>${snap.csrfMode}</b></span>
    <span class="pill ok">PORT: <b>${snap.port}</b></span>
    <span class="pill ok">UPTIME: <b>${snap.uptimeSec}s</b></span>
    <span class="pill">GIT: <b>${snap.gitSha || 'n/a'}</b></span>
  </div>

  ${snap.warnings.length ? `<div class="pill bad" style="display:inline-flex; margin-bottom:12px;">Warnings: <b>${snap.warnings.join(' · ')}</b></div>` : ''}

  <h3 style="margin:14px 0 8px;">DB + tables</h3>
  <div class="muted" style="margin-bottom:8px;">DB path: <code>${snap.dbPath || 'n/a'}</code></div>
  <table>
    <thead><tr><th>Table</th><th>Present</th></tr></thead>
    <tbody>
      ${Object.entries(snap.tables).map(([k,v]) => `<tr><td>${k}</td><td>${v ? '✅' : '❌'}</td></tr>`).join('')}
    </tbody>
  </table>

  <h3 style="margin:14px 0 8px;">Counts</h3>
  <table>
    <tbody>
      <tr><td>Users</td><td><b>${snap.counts.users}</b></td></tr>
      <tr><td>Doctors (active/total)</td><td><b>${snap.counts.activeDoctors}/${snap.counts.doctors}</b></td></tr>
      <tr><td>Orders</td><td><b>${snap.counts.orders}</b></td></tr>
      <tr><td>Orders by status</td><td><code>${JSON.stringify(snap.counts.ordersByStatus)}</code></td></tr>
    </tbody>
  </table>

  <h3 style="margin:14px 0 8px;">Keys</h3>
  <table>
    <tbody>
      <tr>
        <td>Uploadcare public key</td>
        <td>${snap.keys.uploadcarePublicKey.present ? `✅ present (…${snap.keys.uploadcarePublicKey.suffix})` : '❌ missing'}</td>
      </tr>
    </tbody>
  </table>

  <h3 style="margin:14px 0 8px;">Recent activity (latest 10 events)</h3>
  ${snap.recentEvents.length ? `
    <table>
      <thead><tr><th>At</th><th>Order</th><th>Event</th></tr></thead>
      <tbody>
        ${snap.recentEvents.map((e) => `
          <tr>
            <td><code>${e.at || ''}</code></td>
            <td><code>${e.orderId || ''}</code></td>
            <td>${String(e.label || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : `<div class="muted">No events found.</div>`}

  <div style="margin-top:16px;" class="muted">
    Tip: JSON version at <a href="/verify.json">/verify.json</a>
  </div>
</body>
</html>`);
});

app.get('/verify.json', (req, res) => {
  const gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;
  return res.json(buildVerifySnapshot(req));
});

// Run DB migrations (fail-fast if schema is broken)
try {
  migrate();
} catch (err) {
  logFatal('DB migrate failed — refusing to start', err);
  process.exit(1);
}

// Demo seeding must be explicitly enabled (prevents accidental demo data in real DBs)
if (MODE === 'staging') {
  if (String(process.env.SEED_DEMO_DATA || '').trim() === '1') {
    seedDemoData();
  } else {
    logMajor('Demo seed skipped (set SEED_DEMO_DATA=1 to seed demo users/orders in staging).');
  }
}

// Home – redirect based on role
app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');

  switch (req.user.role) {
    case 'patient':
      return res.redirect('/dashboard');
    case 'doctor':
      return res.redirect('/portal/doctor');
    case 'admin':
      return res.redirect('/admin');
    case 'superadmin':
      return res.redirect('/superadmin');
    default:
      return res.redirect('/login');
  }
});

// Profile – redirect based on role (single canonical link target for all headers)
app.get('/profile', (req, res) => {
  if (!req.user) return res.redirect('/login');

  const role = String(req.user.role || '').toLowerCase();

  switch (role) {
    case 'patient':
      // Implement patient profile at /patient/profile
      return res.redirect('/patient/profile');
    case 'doctor':
      return res.redirect('/portal/doctor/profile');
    case 'admin':
      // Implement admin profile at /admin/profile
      return res.redirect('/admin/profile');
    case 'superadmin':
      // Implement superadmin profile at /superadmin/profile
      return res.redirect('/superadmin/profile');
    default:
      return res.redirect('/login');
  }
});

// Convenience alias: /patient -> patient dashboard
// (prevents accidental 404s when users type /patient)
app.get('/patient', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'patient') return res.redirect('/dashboard');
  // Non-patients: fall back to role dashboard
  switch (req.user.role) {
    case 'doctor':
      return res.redirect('/portal/doctor');
    case 'admin':
      return res.redirect('/admin');
    case 'superadmin':
      return res.redirect('/superadmin');
    default:
      return res.redirect('/dashboard');
  }
});

// Compatibility alias: some links may point to /patient/orders.
// Today, the patient "home" is /dashboard; this prevents confusing 404s.
// If/when you add a real orders index page at /patient/orders, remove this route.
app.get('/patient/orders', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'patient') return res.redirect('/dashboard');

  // Non-patients: fall back to role dashboard
  switch (req.user.role) {
    case 'doctor':
      return res.redirect('/portal/doctor');
    case 'admin':
      return res.redirect('/admin');
    case 'superadmin':
      return res.redirect('/superadmin');
    default:
      return res.redirect('/dashboard');
  }
});

// Language switch
app.get('/lang/:code', (req, res) => {
  const code = req.params.code === 'ar' ? 'ar' : 'en';
  // Persist language in session (primary source for middleware/templates)
  if (req.session) {
    req.session.lang = code;
  }
  // Persist language preference (read by middleware/i18n)
  res.cookie('lang', code, {
    httpOnly: false,
    sameSite: COOKIE_SAMESITE,
    secure: COOKIE_SECURE,
    maxAge: 365 * 24 * 60 * 60 * 1000
  });

  // -----------------------------
  // Safe redirect target selection
  // Priority:
  //  1) ?next=/some/path (relative only)
  //  2) Referer (same-host only)
  //  3) last_path cookie
  //  4) fallback
  // -----------------------------

  function sanitizeNext(nextVal) {
    if (!nextVal) return null;
    let s = String(nextVal).trim();
    if (!s) return null;

    // Clamp to avoid header issues / abuse
    const MAX_NEXT_LEN = 2048;
    if (s.length > MAX_NEXT_LEN) s = s.slice(0, MAX_NEXT_LEN);

    // Block control characters (CRLF), nulls, etc.
    if (/[\u0000-\u001F\u007F]/.test(s)) return null;

    // Block backslashes to avoid weird path interpretation on some stacks
    if (s.includes('\\')) return null;

    // Only allow relative paths. Disallow protocol, scheme-relative, or full URLs.
    // Examples blocked: "http://...", "https://...", "//evil.com"
    if (s.includes('://') || s.startsWith('//')) return null;

    // Must start with '/'
    if (!s.startsWith('/')) return null;

    // Never bounce back into /lang/* to avoid loops
    if (s.startsWith('/lang/')) return null;

    return s;
  }

  function roleDefault() {
    if (!req.user) return '/login';
    switch (req.user.role) {
      case 'patient':
        // Patient home is the main dashboard (keeps routing consistent across the app)
        return '/dashboard';
      case 'doctor':
        return '/portal/doctor';
      case 'admin':
        return '/admin';
      case 'superadmin':
        return '/superadmin';
      default:
        return '/dashboard';
    }
  }

  const host = String(req.get('host') || '').toLowerCase();
  const ref = String(req.get('referer') || '');

  // Start with cookie fallback
  let target = (req.cookies && req.cookies.last_path) ? req.cookies.last_path : roleDefault();

  // 1) Explicit next param wins (when safe)
  const nextParam = sanitizeNext(req.query && req.query.next);
  if (nextParam) {
    target = nextParam;
  } else if (ref) {
    // 2) Same-host referer wins (when present)
    try {
      const u = new URL(ref, `http://${host || 'localhost'}`);
      // Only allow same-host redirects (prevent open redirect)
      if (!host || String(u.host || '').toLowerCase() === host) {
        const p = `${u.pathname || ''}${u.search || ''}${u.hash || ''}`;
        if (p && !p.startsWith('/lang/')) {
          target = p;
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // Final safety checks
  target = sanitizeNext(target) || roleDefault();

  // Ensure session is persisted before redirecting (prevents "language changes but page stays English")
  if (req.session && typeof req.session.save === 'function') {
    return req.session.save(() => res.redirect(302, target));
  }
  return res.redirect(302, target);
});

// ----------------------------------------------------
// PORTAL ROUTE GUARDRAILS (role boundaries)
// - Enforce login for portal areas
// - Keep users inside their own portal when they hit the wrong URL
// - For non-GET requests, never redirect (avoid masking mistakes) -> 403
// ----------------------------------------------------
function roleHome(role) {
  switch (role) {
    case 'patient':
      return '/dashboard';
    case 'doctor':
      return '/portal/doctor';
    case 'admin':
      return '/admin';
    case 'superadmin':
      return '/superadmin';
    default:
      return '/login';
  }
}

function denyOrRedirect(req, res, target) {
  // Never redirect unsafe requests; fail fast.
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return res.status(403).type('text/plain').send('Forbidden');
  }
  return res.redirect(target);
}

// Enforce role boundaries at the top-level, regardless of what individual routers do.
app.use((req, res, next) => {
  const p = req.path || '';

  // Define portal areas + allowed roles (keep this tight).
  const areas = [
    { name: 'patient', match: (x) => x === '/dashboard' || x.startsWith('/patient'), roles: ['patient'] },
    { name: 'doctor', match: (x) => x.startsWith('/portal/doctor'), roles: ['doctor'] },
    { name: 'admin', match: (x) => x.startsWith('/admin'), roles: ['admin', 'superadmin'] },
    { name: 'superadmin', match: (x) => x.startsWith('/superadmin'), roles: ['superadmin'] }
  ];

  const area = areas.find((a) => a.match(p));
  if (!area) return next();

  // If not logged in, portal pages require login.
  if (!req.user) {
    const loginTarget = `/login?next=${encodeURIComponent(req.originalUrl || p || '/')}`;
    return denyOrRedirect(req, res, loginTarget);
  }

  const role = String(req.user.role || '').toLowerCase();
  if (!area.roles.includes(role)) {
    // Fail-fast: keep people in the correct portal.
    const home = roleHome(role);
    logMajor(`[RBAC] blocked role=${role} from ${p} (area=${area.name}) req=${req.requestId}`);
    return denyOrRedirect(req, res, home);
  }

  return next();
});

// ----------------------------------------------------
// SLA HYBRID ENFORCEMENT (event-based trigger)
// ----------------------------------------------------
app.use((req, res, next) => {
  res.on('finish', () => {
    if (CONFIG.SLA_MODE !== 'primary') return;
    if (!SLA_ENFORCEMENT_ENABLED) return;

    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (res.statusCode && res.statusCode >= 400) return;

    const p = String(req.originalUrl || req.url || '');

    // Keep triggers tight to order/case lifecycle areas
    const isOrderMutation =
      /^\/(admin|superadmin)\/orders\b/i.test(p) ||
      /^\/portal\/doctor\b/i.test(p) ||
      /^\/doctor\b/i.test(p) ||
      /^\/patient\/orders\b/i.test(p);

    if (!isOrderMutation) return;

    setTimeout(() => {
      try { runSlaEnforcementSweep(`event:${method} ${p}`); } catch (e) {}
    }, 0).unref?.();
  });

  next();
});

// Routes
app.use('/', authRoutes);
app.use('/', doctorRoutes);
app.use('/', patientRoutes);
app.use('/', superadminRoutes);
app.use('/', exportRoutes); // exports/CSV
app.use('/', adminRoutes);
app.use('/', publicRoutes);
app.use('/', publicOrdersRoutes);
app.use('/', intakeRoutes);
app.use('/', orderFlowRoutes);
app.use('/payments', paymentRoutes);

// Internal SLA trigger (superadmin only)
// - run-sla-check: keeps compatibility with older logic
// - run-sla-enforcement: runs the enforcement sweep (primary-mode mutations)
app.get('/internal/run-sla-check', (req, res) => {
  const gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;

  try {
    runSlaSweep();
  } catch (e) {
    // ignore; enforcement sweep is the key path
  }

  // If this instance is primary, also run the enforcement sweep immediately.
  try {
    runSlaEnforcementSweep('manual:run-sla-check');
  } catch (e) {
    // already logged inside sweep
  }

  return res.redirect(req.user.role === 'superadmin' ? '/superadmin?sla_ran=1' : '/admin?sla_ran=1');
});

app.get('/internal/run-sla-enforcement', (req, res) => {
  const gate = requireOpsRole(req, res);
  if (!gate.ok) return gate.res;
  try {
    runSlaEnforcementSweep('manual:run-sla-enforcement');
  } catch (e) {
    // already logged inside sweep
  }
  return res.redirect(req.user.role === 'superadmin' ? '/superadmin?sla_ran=1' : '/admin?sla_ran=1');
});

// ----------------------------------------------------
// 404 HANDLER (clear + consistent)
// ----------------------------------------------------
app.use((req, res) => {
  const requestId = req.requestId;
  const pathStr = req.originalUrl || req.url;
  const wantsJson =
    (req.get('accept') || '').includes('application/json') ||
    pathStr.startsWith('/api/') ||
    pathStr.startsWith('/internal/');

  if (wantsJson) {
    return res.status(404).json({
      ok: false,
      error: 'NOT_FOUND',
      path: pathStr,
      requestId
    });
  }

  if (MODE === 'production') {
    return res.status(404).type('text/plain').send('Not found');
  }

  return res
    .status(404)
    .type('text/plain')
    .send(`Not found\n\npath: ${pathStr}\nrequestId: ${requestId}`);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;

  const errorId = logError(err, {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    userId: req.user?.id,
    role: req.user?.role
  });

  if (MODE === 'production') {
    return res
      .status(status)
      .type('text/plain')
      .send(`An unexpected error occurred. Error ID: ${errorId}`);
  }

  return res
    .status(status)
    .type('text/plain')
    .send(`Error ID: ${errorId}\n\n${err.stack || 'Internal Server Error'}`);
});

// ----------------------------------------------------
// SINGLE SLA WRITER MODE (primary vs passive)
// ----------------------------------------------------
// NOTE:
// - primary: ONE instance owns SLA mutations (breach marking + reminders + escalations)
// - passive: read-only; no DB writes
let slaSweepIntervalId = null;
let slaEnforcementRunning = false;
let slaUnlabeledSweepWarned = false;

// Tuning knobs (safe defaults)
const SLA_ENFORCEMENT_ENABLED = String(process.env.SLA_ENFORCEMENT_ENABLED || '1') === '1';
const SLA_ENFORCEMENT_INTERVAL_MS = Number(process.env.SLA_ENFORCEMENT_INTERVAL_MS || 5 * 60 * 1000);

function runSlaEnforcementSweep(source) {
  if (CONFIG.SLA_MODE !== 'primary') return;
  const srcLabel = source ? String(source) : 'unlabeled';
  if (srcLabel === 'unlabeled' && !slaUnlabeledSweepWarned) {
    slaUnlabeledSweepWarned = true;
    try {
      const stack = (new Error('unlabeled SLA sweep')).stack || '';
      logMajor(`[SLA] WARNING: enforcement sweep called without source label. Stack:\n${stack}`);
    } catch (e) {
      // ignore
    }
  }
  if (!SLA_ENFORCEMENT_ENABLED) return;

  if (slaEnforcementRunning) return;
  slaEnforcementRunning = true;

  try {
    try { runWatcherSweep(new Date()); } catch (err) { logFatal('SLA watcher sweep error', err); }
    try { runSlaReminderJob(); } catch (err) { logFatal('SLA enforcement job error', err); }

    // Optional debug trace; keep it low-noise
    try { logVerbose(`[SLA] enforcement sweep ran (${srcLabel})`); } catch (e) {}
  } catch (err) {
    logFatal('SLA enforcement sweep failed', err);
  } finally {
    slaEnforcementRunning = false;
  }
}

if (CONFIG.SLA_MODE === 'primary') {
  logMajor('🟢 SLA MODE: primary (single writer enabled)');

  startSlaWorker();
  startCaseSlaWorker();

  // Run once at boot, then on an interval.
  setTimeout(() => {
    try {
      runSlaEnforcementSweep('boot');
    } catch (e) {
      // already logged
    }
  }, 1000).unref?.();

  slaSweepIntervalId = setInterval(() => {
    runSlaEnforcementSweep('interval');
  }, SLA_ENFORCEMENT_INTERVAL_MS);
  slaSweepIntervalId.unref?.();

} else {
  logMajor('🟡 SLA MODE: passive (no SLA mutations)');
}

const PORT = CONFIG.PORT;
const server = app.listen(PORT, () => {
  const baseUrl = String(process.env.BASE_URL || '').trim();
  logMajor(`Tashkheesa portal running on port ${PORT}${baseUrl ? ` (${baseUrl})` : ''}`);
});

// Graceful shutdown: close HTTP server + stop timers + close DB
function gracefulShutdown(signal) {
  logMajor(`🧯 Graceful shutdown started (${signal})`);

  // Force-exit safety net (avoid hanging forever)
  const forceTimer = setTimeout(() => {
    logFatal('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  // Allow process to exit naturally if everything is closed
  forceTimer.unref?.();

  // Stop SLA sweep timer if running
  try {
    if (slaSweepIntervalId) {
      clearInterval(slaSweepIntervalId);
      slaSweepIntervalId = null;
    }
  } catch (e) {
    // ignore
  }

  // Stop accepting new connections
  server.close(() => {
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (e) {
      logFatal('Error closing DB during shutdown', e);
    }

    logMajor('✅ Graceful shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));


// Simple SLA reminder + breach marker (primary mode only)
function runSlaReminderJob() {
  // Guardrail: this job mutates DB and sends notifications.
  if (CONFIG.SLA_MODE !== 'primary') return;

  const now = new Date();
  const nowIso = now.toISOString();
  let reminders = 0;
  let breaches = 0;

  // Treat anything not completed/cancelled as "in flight" for SLA purposes.
  // This makes the job resilient as you evolve status naming.
  const IN_FLIGHT_WHERE = `
    deadline_at IS NOT NULL
    AND completed_at IS NULL
    AND breached_at IS NULL
    AND COALESCE(status, '') NOT IN ('completed','cancelled','canceled','rejected')
  `;

  // ----------------------------
  // 1) Reminder: within 60 minutes of deadline
  // ----------------------------
  const reminderOrders = db
    .prepare(
      `SELECT id, doctor_id, deadline_at
       FROM orders
       WHERE ${IN_FLIGHT_WHERE}
         AND COALESCE(sla_reminder_sent, 0) = 0`
    )
    .all();

  reminderOrders.forEach((o) => {
    if (!o.deadline_at) return;
    const diffMin = Math.floor((new Date(o.deadline_at).getTime() - now.getTime()) / 60000);
    if (diffMin > 0 && diffMin <= 60 && o.doctor_id) {
      queueNotification({
        orderId: o.id,
        toUserId: o.doctor_id,
        channel: 'internal',
        template: 'sla_reminder_doctor',
        status: 'queued'
      });

      db.prepare(
        `UPDATE orders
         SET sla_reminder_sent = 1,
             updated_at = ?
         WHERE id = ?`
      ).run(nowIso, o.id);

      logOrderEvent({
        orderId: o.id,
        label: 'SLA reminder sent to doctor (<= 60 min to deadline)',
        actorRole: 'system'
      });

      reminders += 1;
    }
  });

  // ----------------------------
  // 2) Breach: deadline passed
  // ----------------------------
  const opsUsers = db
    .prepare("SELECT id, role FROM users WHERE role IN ('admin','superadmin') AND COALESCE(is_active,1)=1")
    .all();

  const breachOrders = db
    .prepare(
      `SELECT id, doctor_id, deadline_at
       FROM orders
       WHERE ${IN_FLIGHT_WHERE}`
    )
    .all();

  breachOrders.forEach((o) => {
    if (!o.deadline_at) return;
    if (new Date(o.deadline_at) < now) {
      // Mark as breached once.
      db.prepare(
        `UPDATE orders
         SET status = 'breached',
             breached_at = ?,
             updated_at = ?,
             sla_reminder_sent = 1
         WHERE id = ?`
      ).run(nowIso, nowIso, o.id);

      logOrderEvent({
        orderId: o.id,
        label: 'SLA breached – deadline passed without completion',
        actorRole: 'system'
      });

      // Notify doctor
      if (o.doctor_id) {
        queueNotification({
          orderId: o.id,
          toUserId: o.doctor_id,
          channel: 'internal',
          template: 'sla_breached_doctor',
          status: 'queued',
          dedupe_key: `sla:breach:${o.id}:doctor`
        });
      }

      // Escalate to ops (admin + superadmin)
      opsUsers.forEach((u) => {
        queueNotification({
          orderId: o.id,
          toUserId: u.id,
          channel: 'internal',
          template: u.role === 'superadmin' ? 'sla_breached_superadmin' : 'sla_breached_admin',
          status: 'queued',
          dedupe_key: `sla:breach:${o.id}:${u.role}`
        });
      });

      breaches += 1;
    }
  });

  if (reminders || breaches) {
    logMajor(`[SLA job] reminders=${reminders}, breaches=${breaches}`);
  }
}


function seedDemoData() {
  const existingUsers = safeGet('SELECT COUNT(*) as c FROM users', [], { c: 0 });
  if (existingUsers && existingUsers.c > 0) {
    logMajor('Skipping demo seed – users already exist.');
    return;
  }


  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const patientId = 'demo-patient';
  const doctorId = 'demo-radiology-doctor';
  const superadminId = 'demo-superadmin';
  const specialtyId = 'demo-specialty-radiology';
  const serviceId = 'demo-service-radiology';
  const passwordHash = hash('demo1234');
  const completedOrderId = randomUUID();
  const inReviewOrderId = randomUUID();
  const breachedOrderId = randomUUID();

  const completedCreated = new Date(now.getTime() - 5 * dayMs);
  const completedAccepted = new Date(completedCreated.getTime() + 2 * 60 * 60 * 1000);
  const completedDeadline = new Date(completedAccepted.getTime() + 3 * dayMs);
  const completedCompleted = new Date(completedAccepted.getTime() + 4 * 60 * 60 * 1000);

  const inReviewCreated = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const inReviewAccepted = new Date(inReviewCreated.getTime() + 30 * 60 * 1000);
  const inReviewDeadline = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const breachedCreated = new Date(now.getTime() - 4 * dayMs);
  const breachedAccepted = new Date(breachedCreated.getTime() + 2 * 60 * 60 * 1000);
  const breachedDeadline = new Date(breachedAccepted.getTime() + 24 * 60 * 60 * 1000);
  const breachedAt = new Date(breachedDeadline.getTime() + 2 * 60 * 60 * 1000);

  const insertOrder = db.prepare(
    `INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, accepted_at, deadline_at, completed_at, breached_at,
      reassigned_count, notes, payment_status, payment_method, payment_reference, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO specialties (id, name) VALUES (?, ?)').run(specialtyId, 'Radiology');
    db.prepare(
      'INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, currency, payment_link) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(serviceId, specialtyId, 'Radiology review', 3500, 1500, 'EGP', null);

    const createdAtIso = now.toISOString();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(patientId, 'demo.patient@tashkheesa.com', passwordHash, 'Demo Patient', 'patient', null, 1, createdAtIso);
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, specialty_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(doctorId, 'demo.doctor@tashkheesa.com', passwordHash, 'Radiology Doctor', 'doctor', specialtyId, 1, createdAtIso);
    db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(superadminId, 'demo.superadmin@tashkheesa.com', passwordHash, 'Superadmin', 'superadmin', 1, createdAtIso);

    insertOrder.run(
      completedOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      72,
      'completed',
      3500,
      1500,
      completedCreated.toISOString(),
      completedAccepted.toISOString(),
      completedDeadline.toISOString(),
      completedCompleted.toISOString(),
      null,
      0,
      'Demo completed order',
      'paid',
      'card',
      'DEMO-PAID',
      completedCreated.toISOString()
    );

    insertOrder.run(
      inReviewOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      24,
      'in_review',
      4000,
      1800,
      inReviewCreated.toISOString(),
      inReviewAccepted.toISOString(),
      inReviewDeadline.toISOString(),
      null,
      null,
      0,
      'Demo VIP in-review case',
      'unpaid',
      'manual',
      'DEMO-VIP',
      inReviewCreated.toISOString()
    );

    insertOrder.run(
      breachedOrderId,
      patientId,
      doctorId,
      specialtyId,
      serviceId,
      72,
      'breached',
      3200,
      1200,
      breachedCreated.toISOString(),
      breachedAccepted.toISOString(),
      breachedDeadline.toISOString(),
      null,
      breachedAt.toISOString(),
      1,
      'Demo breached order',
      'unpaid',
      'manual',
      'DEMO-BREACHED',
      breachedCreated.toISOString()
    );

    const eventInsert = db.prepare(
      'INSERT INTO order_events (id, order_id, label, meta, at) VALUES (?, ?, ?, ?, ?)'
    );
    eventInsert.run(randomUUID(), completedOrderId, 'Order completed (demo)', null, completedCompleted.toISOString());
    eventInsert.run(randomUUID(), inReviewOrderId, 'Order in review (demo)', null, now.toISOString());
    eventInsert.run(randomUUID(), breachedOrderId, 'Order breached (demo)', null, breachedAt.toISOString());

    if (tableExists('notifications')) {
      const notificationInsert = db.prepare(
        'INSERT INTO notifications (id, order_id, to_user_id, channel, template, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const ts = now.toISOString();
      notificationInsert.run(randomUUID(), completedOrderId, patientId, 'internal', 'demo_payment_received', 'queued', ts);
      notificationInsert.run(randomUUID(), inReviewOrderId, doctorId, 'internal', 'demo_order_assigned', 'queued', ts);
      notificationInsert.run(randomUUID(), breachedOrderId, doctorId, 'internal', 'demo_order_breached', 'queued', ts);
    }
  });

  try {
    tx();
    logMajor('Demo data seeded for staging mode.');
  } catch (err) {
    logFatal('Demo seed failed', err);
  }
}
