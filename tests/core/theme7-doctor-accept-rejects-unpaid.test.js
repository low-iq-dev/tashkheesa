// tests/core/theme7-doctor-accept-rejects-unpaid.test.js
//
// Theme 7 sub-issue A: defense-in-depth check that an unpaid case cannot
// be transitioned to IN_REVIEW even if some upstream path bypasses the
// route's payment guard.
//
// Two layers verified by source-grep:
//   1. The route still has its `paymentStatus === 'paid'|'captured'`
//      guard with redirect on `!isPaid`.
//   2. case_lifecycle.assertPaidGate still rejects pre-paid transitions
//      (PRE_PAYMENT allowlist is exactly [DRAFT, SUBMITTED]) and
//      STATUS_TRANSITIONS forces PAID → ASSIGNED → IN_REVIEW (i.e., a
//      direct PAID → IN_REVIEW would throw assertTransition).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🚫 Theme 7 sub-A — doctor accept rejects unpaid (source check)\n');

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'doctor.js');
const src = fs.readFileSync(SRC, 'utf8');

const startIdx = src.indexOf("router.post('/portal/doctor/case/:caseId/accept'");
if (startIdx < 0) {
  t.fail('locate accept handler', new Error('accept route not found'));
} else {
  const after = src.slice(startIdx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  // 1. Route's payment_status guard preserved (route-level pre-canonical check).
  try {
    if (!/paymentStatus\s*===\s*['"]paid['"]\s*\|\|\s*paymentStatus\s*===\s*['"]captured['"]/.test(body)) {
      throw new Error('accept handler dropped paymentStatus paid/captured guard');
    }
    if (!/if\s*\(\s*!isPaid\s*\)\s*\{[\s\S]{0,80}res\.redirect/.test(body)) {
      throw new Error('accept handler does not redirect on !isPaid');
    }
    t.pass('payment_status guard (paid|captured) preserved with redirect on !isPaid');
  } catch (e) { t.fail('route-payment-guard', e); }
}

// 2. Defense-in-depth: case_lifecycle.assertPaidGate still rejects
//    pre-paid transitions to IN_REVIEW.
const LIFECYCLE = path.join(__dirname, '..', '..', 'src', 'case_lifecycle.js');
const lifecycleSrc = fs.readFileSync(LIFECYCLE, 'utf8');

try {
  if (!/function\s+assertPaidGate\s*\(\s*existingCase,\s*nextStatus\s*\)/.test(lifecycleSrc)) {
    throw new Error('case_lifecycle.assertPaidGate signature drift');
  }
  if (!/PRE_PAYMENT\s*=\s*\[CASE_STATUS\.DRAFT,\s*CASE_STATUS\.SUBMITTED\]/.test(lifecycleSrc)) {
    throw new Error('assertPaidGate PRE_PAYMENT allowlist drift — IN_REVIEW could leak through');
  }
  t.pass('assertPaidGate still blocks IN_REVIEW for unpaid cases (PRE_PAYMENT = [DRAFT, SUBMITTED])');
} catch (e) { t.fail('lifecycle-assertPaidGate', e); }

// 3. transitionCase invariant: PAID → IN_REVIEW chain forces ASSIGNED in
//    between (route uses assignDoctor for the PAID branch). A direct
//    PAID → IN_REVIEW call to transitionCase would throw assertTransition.
try {
  if (!/\[CASE_STATUS\.PAID\]:\s*\[CASE_STATUS\.ASSIGNED\]/.test(lifecycleSrc)) {
    throw new Error('STATUS_TRANSITIONS[PAID] no longer = [ASSIGNED] — invariant drift; direct PAID → IN_REVIEW would silently succeed');
  }
  if (!/\[CASE_STATUS\.ASSIGNED\]:\s*\[\s*CASE_STATUS\.IN_REVIEW/.test(lifecycleSrc)) {
    throw new Error('STATUS_TRANSITIONS[ASSIGNED] no longer includes IN_REVIEW — chain broken');
  }
  t.pass('STATUS_TRANSITIONS canonical: PAID → ASSIGNED → IN_REVIEW chain intact');
} catch (e) { t.fail('status-transitions-chain', e); }

// 4. transitionCase calls assertPaidGate before allowing the transition.
try {
  if (!/async\s+function\s+transitionCase[\s\S]{0,400}assertPaidGate\(/.test(lifecycleSrc)) {
    throw new Error('transitionCase no longer calls assertPaidGate up-front');
  }
  t.pass('transitionCase invokes assertPaidGate before applying status changes');
} catch (e) { t.fail('transitionCase-paid-gate', e); }
