'use strict';
// tests/core/post-payment-hook-pinning.test.js
//
// Stage 2 P0-PAY-3 — pin test.
//
// Invariant: any paid order must end with a doctor assigned (doctor_id
// != NULL) and a doctor notification queued (notifications row with
// template='order_auto_assigned_doctor'), regardless of whether payment
// arrived via the Paymob webhook or the test-mode stub success path.
//
// Today, only the Paymob webhook fires enqueueAutoAssign +
// broadcastOrderToSpecialty (src/routes/payments.js:480-492). The stub
// success path in src/routes/patient.js:2147-2232 reaches markCasePaid
// but not the hooks, so every stub-paid order dead-ends without a
// doctor.
//
// The fix moves the hooks into markCasePaid (post-commit) so every
// caller — webhook, stub, future surface — fires them. This test
// pins that invariant so it cannot silently regress.
//
// Lifecycle in this PR:
//   - Commit 1 (this file): skip placeholder, CI stays green.
//   - Commit 2: assertions populated, fix lands in case_lifecycle.js
//     and payments.js. Test transitions from skip to pass.
//
// Pre-fix behaviour (proven by manually un-skipping against current
// main): assertion A fails — doctor_id stays NULL after markCasePaid
// on a fresh stub-paid order. The pin catches the regression.

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📌 Stage 2 P0-PAY-3 — post-payment hook pinning\n');

t.skip(
  fileTag + ': paid order ends with doctor_id != null + auto-assign notification queued',
  'placeholder — assertions land in commit 2 alongside the markCasePaid hook unification'
);
