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

  console.log('✅ Boot checks passed\n');
}

module.exports = { bootCheck };