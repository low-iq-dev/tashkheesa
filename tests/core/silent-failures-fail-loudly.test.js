// tests/core/silent-failures-fail-loudly.test.js
//
// A8 (AUDIT 2026-09-09) — three operator actions swallowed a failed write and
// then redirected with a SUCCESS code, so the operator was told it worked:
//   (a) additional-files approve — if the uploads_locked=false write fails the
//       patient is permanently blocked and the SLA stays paused, yet the admin
//       saw "approved" (routes/admin.js + routes/superadmin.js).
//   (b) refund mark-paid — the doctor-earnings clawback was swallowed, so the
//       refund is paid but the doctor keeps 100% (routes/superadmin.js).
//   (c) markCasePaid from the operator screen — the case never entered
//       assignment, yet the operator saw ?payment=paid (routes/superadmin.js).
//
// Each now sets a failure flag in the swallow and redirects with a code the
// page RENDERS, instead of an unconditional success. Source-grep (the change is
// control flow around a redirect). Verified NEGATIVELY: forcing the success
// redirect unconditional fails the matching assertion.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔇 A8 — silent failures now fail loudly\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// Carve a route handler body from its anchor to the next route definition.
function handler(src, anchor) {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const after = src.slice(start + anchor.length);
  const next = after.search(/router\.(post|get|put|delete)\(/);
  return next > 0 ? after.slice(0, next) : after;
}

const sa = code('src/routes/superadmin.js');
const ad = code('src/routes/admin.js');

// (a) additional-files approve — admin
check('(a) admin additional-files approve fails loudly on a failed unlock', () => {
  const h = handler(ad, "router.post('/admin/orders/:id/additional-files/approve'");
  if (!h) return 'handler not found';
  if (!/unlockFailed\s*=\s*true/.test(h)) return 'no failure flag set in the unlock catch';
  if (!/if\s*\(\s*unlockFailed\s*\)[\s\S]{0,120}\?files=unlock_failed/.test(h)) return 'success redirect is not guarded by the failure';
});
check('(a) admin renders the unlock failure (files:unlock_failed flash)', () => {
  if (!/'files:unlock_failed'/.test(ad)) return 'no FLASH_CODES entry';
  if (!/\['reassign', 'payment', 'lifecycle', 'rx', 'addons', 'files'\]/.test(ad)) return "flash loop does not read the 'files' key";
});

// (a) additional-files approve — superadmin
check('(a) superadmin additional-files approve fails loudly on a failed unlock', () => {
  const h = handler(sa, "router.post('/superadmin/orders/:id/additional-files/approve'");
  if (!h) return 'handler not found';
  if (!/unlockFailed\s*=\s*true/.test(h)) return 'no failure flag set in the unlock catch';
  if (!/if\s*\(\s*unlockFailed\s*\)[\s\S]{0,120}\?error=unlock_failed/.test(h)) return 'success not guarded by the failure';
});

// (b) refund mark-paid — clawback
check('(b) refund mark-paid surfaces a swallowed clawback', () => {
  const h = handler(sa, "router.post('/superadmin/refunds/:id/mark-paid'");
  if (!h) return 'handler not found';
  if (!/clawbackFailed\s*=\s*true/.test(h)) return 'clawback failure not flagged';
  if (!/if\s*\(\s*clawbackFailed\s*\)[\s\S]{0,140}error=clawback_failed/.test(h)) return 'paid redirect does not carry the clawback failure';
});

// (c) markCasePaid — operator screen
check('(c) operator mark-paid fails loudly when the case did not enter assignment', () => {
  const h = handler(sa, "router.post('/superadmin/orders/:id/mark-paid'");
  if (!h) return 'handler not found';
  if (!/markPaidFailed\s*=\s*true/.test(h)) return 'lifecycle failure not flagged';
  if (!/if\s*\(\s*markPaidFailed\s*\)[\s\S]{0,140}\?payment=paid_but_unrouted/.test(h)) return 'still reports ?payment=paid unconditionally';
});

// The order page actually renders the honest codes.
check('the superadmin order page renders the honest failure codes', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src/views/superadmin_order_detail.ejs'), 'utf8');
  if (!/unlock_failed/.test(view)) return 'view does not render unlock_failed';
  if (!/paid_but_unrouted/.test(view)) return 'view does not render paid_but_unrouted';
  // And the route must pass the params.
  if (!/flashError:.*req\.query\.error/.test(sa)) return 'detail route does not pass flashError';
  if (!/paymentNotice:.*req\.query\.payment/.test(sa)) return 'detail route does not pass paymentNotice';
});
