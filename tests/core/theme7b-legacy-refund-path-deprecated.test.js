// tests/core/theme7b-legacy-refund-path-deprecated.test.js
//
// Theme 7b Phase 3 — legacy payment_status='refunded' path deprecation
// (per OQ-14). Source-grep style.

'use strict';
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 3 — legacy refund path deprecated\n');

const SUPER = path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js');
const src = fs.readFileSync(SUPER, 'utf8');

// Slice the unified payment update handler.
const start = src.indexOf("router.post('/superadmin/orders/:id/payment'");
if (start < 0) {
  t.fail('locate /superadmin/orders/:id/payment handler', new Error('handler not found'));
} else {
  const after = src.slice(start);
  const next = after.slice(50).search(/\nrouter\.(?:get|post|put|delete|patch|all)\(/);
  const body = next > 0 ? after.slice(0, next + 50) : after;

  // 1. Refunded branch redirects (does not UPDATE payment_status='refunded' raw).
  try {
    if (!/if \(status === 'refunded'\)/.test(body)) {
      throw new Error("handler does not branch on `status === 'refunded'` for legacy redirect");
    }
    if (!/res\.redirect\(['"]\/superadmin\/refunds\?prefill_order=/.test(body)) {
      throw new Error('handler does not redirect to /superadmin/refunds?prefill_order=…');
    }
    // Verify the redirect happens BEFORE the UPDATE — no fall-through.
    const idx = body.indexOf("status === 'refunded'");
    const updIdx = body.indexOf('UPDATE orders');
    if (idx < 0 || updIdx < 0 || updIdx < idx) {
      throw new Error('refunded-branch redirect must be evaluated BEFORE the UPDATE orders SQL');
    }
    t.pass('legacy refund branch: redirects to /superadmin/refunds?prefill_order=<id> BEFORE the UPDATE');
  } catch (e) { t.fail('legacy redirect', e); }

  // 2. Audit event 'legacy_refund_path_deprecated' fires.
  try {
    if (!/label:\s*['"]legacy_refund_path_deprecated['"]/.test(body)) {
      throw new Error('legacy redirect does not write a `legacy_refund_path_deprecated` audit event');
    }
    t.pass('audit event `legacy_refund_path_deprecated` fires on the legacy hit');
  } catch (e) { t.fail('audit event', e); }

  // 3. Other branches (paid/unpaid) still pass through to the UPDATE.
  try {
    // The UPDATE remains; refunded branch returns early.
    if (!/UPDATE orders[\s\S]+?SET payment_status = \$1/.test(body)) {
      throw new Error('handler is missing the canonical UPDATE for non-refunded statuses');
    }
    t.pass('non-refunded branches (paid/unpaid) still UPDATE payment_status correctly');
  } catch (e) { t.fail('non-refunded branches preserved', e); }
}
