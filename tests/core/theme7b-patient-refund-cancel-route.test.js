// tests/core/theme7b-patient-refund-cancel-route.test.js
//
// Theme 7b Phase 2 — patient refund-cancel route regression guard.
//
// Per OQ-3: patient can self-cancel a pending or auto_approved refund
// request within 1 hour of submission. Hard-delete (no
// 'cancelled_by_patient' enum value); audit event preserves the
// deleted row's identity in meta. Source-grep style.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 2 — patient refund cancel route\n');

const PATIENT = path.join(__dirname, '..', '..', 'src', 'routes', 'patient.js');
const src = fs.readFileSync(PATIENT, 'utf8');

function sliceRoute(text, verb, pathSubstring) {
  const escaped = pathSubstring.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const m = text.match(new RegExp(
    'router\\.' + verb + "\\(\\s*['\"][^'\"]*" + escaped + "[^'\"]*['\"]"
  ));
  if (!m) return null;
  const start = m.index;
  const after = text.slice(start);
  const next = after.slice(50).search(/\nrouter\.(?:get|post|put|delete|patch|all)\(/);
  return next > 0 ? after.slice(0, next + 50) : after;
}

const cancelBody = sliceRoute(src, 'post', '/refund-request/cancel');

// ── 1. Cancel route exists with requireRole('patient') ────────────
try {
  if (!cancelBody) throw new Error('POST /portal/patient/orders/:id/refund-request/cancel route not found');
  if (!/requireRole\(\s*['"]patient['"]\s*\)/.test(cancelBody)) {
    throw new Error('cancel route is missing requireRole(\'patient\') middleware');
  }
  t.pass('POST /portal/patient/orders/:id/refund-request/cancel — patient-gated');
} catch (e) { t.fail('cancel route exists', e); }

// ── 2. Validates ownership of order + refund + status precondition ─
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/SELECT id FROM orders_active WHERE id = \$1 AND patient_id = \$2/.test(cancelBody)) {
    throw new Error('cancel route does not check order ownership (order_id + patient_id)');
  }
  if (!/status\s+IN\s*\(\s*'pending','auto_approved'\s*\)/.test(cancelBody)) {
    throw new Error('cancel route does not gate on status IN (pending, auto_approved)');
  }
  if (!/refund\.requested_by/.test(cancelBody) || !/!==/.test(cancelBody)) {
    throw new Error('cancel route does not verify refund.requested_by matches patientId');
  }
  t.pass('cancel route validates: order ownership + refund status precondition + refund.requested_by ownership');
} catch (e) { t.fail('cancel route ownership', e); }

// ── 3. 1-hour cancel window from refunded_at ──────────────────────
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/60\s*\*\s*60\s*\*\s*1000/.test(cancelBody)) {
    throw new Error('cancel route does not enforce a 60*60*1000ms (1 hour) window');
  }
  if (!/cancel_window_expired/.test(cancelBody)) {
    throw new Error('cancel route does not surface a `cancel_window_expired` error path');
  }
  t.pass('cancel route enforces a 1-hour window (60*60*1000ms) and returns cancel_window_expired on miss');
} catch (e) { t.fail('cancel window', e); }

// ── 4. Hard-delete, not status-flip ────────────────────────────────
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/DELETE FROM refunds WHERE id = \$1/.test(cancelBody)) {
    throw new Error('cancel route does not DELETE the refund row (per OQ-3)');
  }
  if (/UPDATE\s+refunds\s+SET\s+status\s*=\s*['"]cancelled_by_patient['"]/.test(cancelBody)) {
    throw new Error('cancel route still flips status to \'cancelled_by_patient\' — should hard-delete per OQ-3');
  }
  t.pass('cancel route hard-deletes the refund row (no \'cancelled_by_patient\' enum value)');
} catch (e) { t.fail('hard-delete', e); }

// ── 5. Audit event preserves the deleted row's identity in meta ───
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/logOrderEvent\s*\(\s*\{[\s\S]{0,400}label:\s*['"]patient_refund_cancelled['"]/.test(cancelBody)) {
    throw new Error('logOrderEvent for label `patient_refund_cancelled` not written');
  }
  if (!/refund_id:\s*refund\.id/.test(cancelBody)) {
    throw new Error('audit meta does not preserve refund_id (the deleted row\'s id)');
  }
  if (!/requested_amount_egp:/.test(cancelBody)) {
    throw new Error('audit meta does not preserve requested_amount_egp');
  }
  if (!/prior_status:/.test(cancelBody)) {
    throw new Error('audit meta does not preserve prior_status');
  }
  if (!/actorRole:\s*['"]patient['"]/.test(cancelBody)) {
    throw new Error('audit event does not set actorRole=\'patient\'');
  }
  t.pass('audit event `patient_refund_cancelled` preserves refund_id + requested_amount_egp + prior_status in meta');
} catch (e) { t.fail('audit preservation', e); }

// ── 6. Admin notification fires ────────────────────────────────────
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/notifyAdmins\s*\(\s*\{/.test(cancelBody)) {
    throw new Error('cancel route does not fan out via notifyAdmins()');
  }
  if (!/template:\s*['"]admin_refund_cancelled_by_patient['"]/.test(cancelBody)) {
    throw new Error('admin notification template is not `admin_refund_cancelled_by_patient`');
  }
  if (!/dedupeKey:\s*['"`]refund_cancelled:/.test(cancelBody)) {
    throw new Error('admin fan-out dedupeKey does not start with `refund_cancelled:`');
  }
  t.pass('admin notification `admin_refund_cancelled_by_patient` fires via notifyAdmins() with refund_cancelled:<id>:sa dedupeKey');
} catch (e) { t.fail('admin notification', e); }

// ── 7. Redirect on success ─────────────────────────────────────────
try {
  if (!cancelBody) throw new Error('cancel route body unavailable');
  if (!/refund_status=cancelled/.test(cancelBody)) {
    throw new Error('cancel route does not redirect with ?refund_status=cancelled');
  }
  t.pass('cancel route redirects to /portal/patient/orders/:id?refund_status=cancelled on success');
} catch (e) { t.fail('redirect', e); }
