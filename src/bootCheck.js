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

  // 1. Environment sanity
  assert(MODE, 'MODE environment variable is missing');
  assert(
    ['development', 'staging', 'production'].includes(MODE),
    `Invalid MODE value: ${MODE}`
  );

  // 1b. Required environment variables by mode
  // Keep this list short + high-signal. Add to it as the portal grows.
  const requiredEnvByMode = {
    development: ['SLA_MODE'],
    staging: ['SLA_MODE', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS'],
    production: ['SLA_MODE', 'BASIC_AUTH_USER', 'BASIC_AUTH_PASS']
  };

  const requiredEnv = requiredEnvByMode[MODE] || [];
  const missing = requiredEnv.filter((key) => !process.env[key] || !String(process.env[key]).trim());

  if (missing.length) {
    console.error('\n⛔ BOOT CHECK FAILED');
    console.error('➡ Missing required environment variables:');
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error('\nFix: add them to your .env (development) or deployment secrets (staging/production).\n');
    process.exit(1);
  }

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
    if (MODE === 'development') {
      console.warn(`⚠️  ${msg} (dev warning)`);
    } else {
      assert(false, msg);
    }
  }

  console.log('✅ Boot checks passed\n');
}

module.exports = { bootCheck };