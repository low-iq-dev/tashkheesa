// tests/auth/welcome-token-expiry.test.js
//
// Package 2 (Task 25): WELCOME_EXPIRY_HOURS is single-sourced in
// doctor_welcome_payload.js; superadmin.js imports it rather than carrying its
// own duplicate literal (which had drifted to a separate `const … = 168`).
// admin_doctor_invite.js already imports it. Value kept at 168h (7-day) per an
// explicit decision (2026-08-10) — the 72h security reduction is deferred so the
// just-shipped v5 welcome email's "7 days" copy stays truthful. Pure require-time
// + source assertion — no server, no DB.
'use strict';
const assert = require('assert');
const fs = require('fs');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};
console.log('\n⏳ auth/welcome-token-expiry (Package 2 — Task 25 single-source)\n');

// 1. The single source exports the constant (kept at 168h per decision).
try {
  const { WELCOME_EXPIRY_HOURS } = require('../../src/services/doctor_welcome_payload');
  assert.strictEqual(WELCOME_EXPIRY_HOURS, 168, 'doctor_welcome_payload exports WELCOME_EXPIRY_HOURS = 168');
  t.pass('WELCOME_EXPIRY_HOURS single source (doctor_welcome_payload) = 168');
} catch (e) { t.fail('single-source constant value', e); }

// 2. superadmin.js must NOT define a local WELCOME_EXPIRY_HOURS literal — it must
//    import the shared one (no drift-prone duplicate).
try {
  const sa = fs.readFileSync(require.resolve('../../src/routes/superadmin.js'), 'utf8');
  assert.ok(!/const\s+WELCOME_EXPIRY_HOURS\s*=/.test(sa),
    'superadmin.js must NOT redeclare WELCOME_EXPIRY_HOURS (single-source it)');
  assert.ok(/require\(\s*['"]\.\.\/services\/doctor_welcome_payload['"]\s*\)/.test(sa),
    'superadmin.js must require ../services/doctor_welcome_payload');
  assert.ok(/WELCOME_EXPIRY_HOURS/.test(sa),
    'superadmin.js must still reference WELCOME_EXPIRY_HOURS (the imported one)');
  t.pass('superadmin.js single-sources WELCOME_EXPIRY_HOURS (no local dup, imported)');
} catch (e) { t.fail('superadmin.js single-source', e); }

// 3. admin_doctor_invite.js already imports it from the same source (no change,
//    but pin it so a future refactor can't silently re-introduce a dup).
try {
  const inv = fs.readFileSync(require.resolve('../../src/services/admin_doctor_invite.js'), 'utf8');
  assert.ok(/WELCOME_EXPIRY_HOURS\s*}\s*=\s*require\(\s*['"]\.\/doctor_welcome_payload['"]\s*\)/.test(inv)
    || (/require\(\s*['"]\.\/doctor_welcome_payload['"]\s*\)/.test(inv) && !/const\s+WELCOME_EXPIRY_HOURS\s*=/.test(inv)),
    'admin_doctor_invite.js imports WELCOME_EXPIRY_HOURS (no local dup)');
  t.pass('admin_doctor_invite.js inherits the single source');
} catch (e) { t.fail('admin_doctor_invite.js single-source', e); }
