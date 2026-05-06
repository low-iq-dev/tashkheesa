// tests/core/no-mobile-api-boot-script.test.js
//
// Theme 1, sub-issue A (boot race) regression guard.
//
// The fix path retired the parallel boot-time schema-mutation script
// src/migrate_mobile_api.js. Those mutations are now codified in
// migrations 043 + 044 + 045. This test asserts:
//
//   1. The deleted file is and stays deleted.
//   2. server.js no longer references migrateForMobileApi (no
//      fire-and-forget call, no require).
//
// Catches the regression class where someone re-introduces a parallel
// boot-time schema mutation outside the schema_migrations runner.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧹 boot-time schema mutations are gone (Theme 1, A)\n');

const ROOT = path.join(__dirname, '..', '..');

try {
  const ghost = path.join(ROOT, 'src', 'migrate_mobile_api.js');
  if (fs.existsSync(ghost)) {
    throw new Error('src/migrate_mobile_api.js still exists; fire-and-forget boot script must stay deleted');
  }
  t.pass('src/migrate_mobile_api.js is deleted');
} catch (e) { t.fail('src/migrate_mobile_api.js absent', e); }

try {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  if (/migrateForMobileApi/.test(serverSrc)) {
    throw new Error('server.js still references migrateForMobileApi — boot path resurrected');
  }
  if (/require\(['"]\.\/migrate_mobile_api['"]\)/.test(serverSrc)) {
    throw new Error('server.js still requires ./migrate_mobile_api — boot path resurrected');
  }
  t.pass('server.js does not reference migrateForMobileApi');
} catch (e) { t.fail('server.js boot path clean', e); }
