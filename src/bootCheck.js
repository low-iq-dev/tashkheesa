// src/bootCheck.js
const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    console.error('\n⛔ BOOT CHECK FAILED');
    console.error('➡', message, '\n');
    process.exit(1);
  }
}

function bootCheck({ ROOT, MODE }) {
  console.log('🔒 Running boot checks...');

  // 1. Environment sanity (fail-fast in staging/production; flexible in development)
  const resolvedMode = (MODE || process.env.MODE || process.env.NODE_ENV || 'development').toString().trim();
  const mode = resolvedMode;

  assert(mode, 'MODE environment variable is missing');
  assert(
    ['development', 'staging', 'production'].includes(mode),
    `Invalid MODE value: ${mode}`
  );

  // Normalize MODE so downstream code can rely on it.
  process.env.MODE = mode;

  // SLA_MODE: default to passive in development; required in staging/production.
  let slaMode = String(process.env.SLA_MODE || '').trim();
  if (!slaMode) {
    if (mode === 'development') {
      slaMode = 'passive';
      process.env.SLA_MODE = slaMode;
      console.warn('⚠️  SLA_MODE missing — defaulting to passive (development only)');
    } else {
      assert(false, 'Missing required environment variable: SLA_MODE');
    }
  }
  assert(
    ['passive', 'primary'].includes(slaMode),
    `Invalid SLA_MODE value: ${slaMode} (expected: passive | primary)`
  );

  // Guardrail: prevent accidental SLA_MODE=primary in development.
  // Allow it only if explicitly acknowledged.
  if (mode === 'development' && slaMode === 'primary') {
    const allowPrimary = String(process.env.ALLOW_PRIMARY_IN_DEV || '')
      .trim()
      .toLowerCase();

    assert(
      allowPrimary === '1' || allowPrimary === 'true' || allowPrimary === 'yes',
      'SLA_MODE=primary in development is blocked by default. Set ALLOW_PRIMARY_IN_DEV=true to proceed.'
    );

    console.warn('⚠️  ALLOW_PRIMARY_IN_DEV enabled — running SLA_MODE=primary in development');
  }

  // Basic auth credentials: required for staging/production.
  if (mode !== 'development') {
    const user = String(process.env.BASIC_AUTH_USER || '').trim();
    const pass = String(process.env.BASIC_AUTH_PASS || '').trim();

    assert(user, 'Missing required environment variable: BASIC_AUTH_USER');
    assert(pass, 'Missing required environment variable: BASIC_AUTH_PASS');

    // Guardrail: prevent default/demo creds in production.
    if (mode === 'production') {
      assert(
        !(user === 'demo' && pass === 'demo123'),
        'BASIC_AUTH_USER/BASIC_AUTH_PASS are still set to demo defaults — set real secrets for production'
      );
    }
  }

  // Database path: required (and writable) in staging/production.
  const dbCandidates = [
    process.env.PORTAL_DB_PATH,
    process.env.DB_PATH,
    path.join(ROOT, 'data/portal.db'),
    path.join(ROOT, 'src/data/portal.db')
  ].filter(Boolean);

  const dbPath = dbCandidates.find((p) => fs.existsSync(p));

  if (!dbPath) {
    const msg = `No SQLite DB found. Looked in: ${dbCandidates.join(', ')}`;
    if (mode === 'development') {
      console.warn(`⚠️  ${msg} (dev warning)`);
    } else {
      assert(false, msg);
    }
  } else {
    // In staging/production the server must be able to read/write the DB.
    if (mode !== 'development') {
      try {
        fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch (e) {
        assert(false, `DB is not readable/writable: ${dbPath}`);
      }
    }
  }

  console.log(
    `🔧 MODE=${mode} SLA_MODE=${slaMode}` +
      (dbPath ? ` DB=${dbPath}` : '')
  );

  // 2. Project structure
  assert(fs.existsSync(ROOT), 'Project root does not exist');
  assert(fs.existsSync(path.join(ROOT, 'src')), 'src/ directory missing');
  assert(fs.existsSync(path.join(ROOT, 'src/server.js')), 'server.js missing');

  // 3. Critical views must exist
  const viewsDir = path.join(ROOT, 'src/views');
  assert(fs.existsSync(viewsDir), 'views directory missing');

  const requiredViews = [
    'portal_doctor_dashboard.ejs',
    'portal_doctor_case.ejs',
    'login.ejs'
  ];

  requiredViews.forEach((view) => {
    const fullPath = path.join(viewsDir, view);
    assert(fs.existsSync(fullPath), `Missing required view: ${view}`);
  });

  // 4. Public assets (warn in dev; fail in staging/production)
  const publicDir = path.join(ROOT, 'public');
  const requiredPublic = ['styles.css', 'favicon.ico', 'site.webmanifest'];
  const missingPublic = requiredPublic.filter((f) => !fs.existsSync(path.join(publicDir, f)));

  if (missingPublic.length) {
    const msg = `Missing public assets: ${missingPublic.join(', ')}`;
    if (mode === 'development') {
      console.warn(`⚠️  ${msg} (dev warning)`);
    } else {
      assert(false, msg);
    }
  }

  console.log('✅ Boot checks passed\n');
}

module.exports = { bootCheck };