// tests/core/theme13-c2d-display-uses-proxy.test.js
//
// Theme 13 Sub-issue C2.D — message + additional-files display always
// routes through /files/<id> (the unified reader). Locks in the
// disambiguation strategy chosen in §8 Q5: "always proxy, drop OR
// fallback." Pre-C2.D both surfaces passed raw URL strings to file-tile,
// which broke the moment a row's stored value was an R2 key (no scheme).
//
// Pure source-grep — no DB, no boot.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 C2.D — display always proxies through /files/<id>\n');

const ROOT = path.join(__dirname, '..', '..');
const EJS = fs.readFileSync(path.join(ROOT, 'src', 'views', 'patient_order.ejs'), 'utf8');
const PATIENT_JS = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'patient.js'), 'utf8');

function expect(cond, msg) { if (!cond) throw new Error(msg); }

// 1. Message file-tile call uses /files/<id> proxy, NOT the OR fallback.
try {
  // Old shape: `url: m.file_url || ('/files/' + m.id)` → forbidden
  expect(!/url:\s*m\.file_url\s*\|\|\s*\(['"]\/files\/['"]/.test(EJS),
    'EJS must NOT pass m.file_url || (/files/...) — that breaks for R2 keys');
  // New shape: `url: '/files/' + m.id` → required
  expect(/url:\s*['"]\/files\/['"]\s*\+\s*m\.id/.test(EJS),
    'EJS message file-tile call must use url: \'/files/\' + m.id (always proxy)');
  t.pass('message file-tile call always proxies through /files/<id> (no OR fallback)');
} catch (e) { t.fail('message display proxy', e); }

// 2. Additional-files reader rewrites url through /files/<id> proxy.
try {
  // The SELECT must NOT include `file_url AS url` anymore.
  expect(!/SELECT\s+id,[\s\S]*?file_url\s+AS\s+url[\s\S]*?FROM\s+order_additional_files/i.test(PATIENT_JS),
    'patient.js order_additional_files SELECT must NOT alias file_url AS url');
  // Rewrite must apply: additionalFiles.forEach(f => { f.url = '/files/' + f.id; });
  expect(/additionalFiles\.forEach\([^)]*f\.url\s*=\s*['"]\/files\/['"]\s*\+\s*f\.id/.test(PATIENT_JS),
    'patient.js must rewrite additionalFiles[].url to /files/<id> after the query');
  t.pass('order_additional_files reader rewrites url through /files/<id> proxy');
} catch (e) { t.fail('additional-files proxy rewrite', e); }
