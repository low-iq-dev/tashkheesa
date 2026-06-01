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
// Pre-fix behaviour (current main without this PR): only the Paymob
// webhook fires enqueueAutoAssign + broadcastOrderToSpecialty (formerly
// src/routes/payments.js:480-492). The stub success path in
// src/routes/patient.js GET /payment-success?stub=1 calls markCasePaid
// but not the hooks, so every stub-paid order dead-ends without a
// doctor.
//
// The fix (this commit) moves the hooks into case_lifecycle.markCasePaid
// (post-commit) so every caller — webhook, stub, future surface — fires
// them. This test pins that invariant so it cannot silently regress.
//
// Runs against DATABASE_URL (real Postgres pool). Seeds rows with
// pin-test-<random> ids and cleans them up in finally{}. Forces
// admin_settings.auto_assign_enabled='true' for the duration and
// restores the prior value (or deletes the row if it didn't exist
// before) on exit.

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📌 Stage 2 P0-PAY-3 — post-payment hook pinning\n');

const { queryOne, execute } = require('../../src/pg');
const { markCasePaid } = require('../../src/case_lifecycle');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

async function pollFor(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch (_) { last = null; }
    if (last) return last;
    await new Promise(function (r) { setTimeout(r, intervalMs); });
  }
  return last;
}

(async function runAll() {
  const suffix = Math.random().toString(36).slice(2, 10);
  const patientId   = 'pin-test-patient-' + suffix;
  const doctorId    = 'pin-test-doctor-' + suffix;
  const orderId     = 'pin-test-order-' + suffix;
  // spec-cardiology is verified visible in prod via the launch audit
  // and has eligible doctors today; we seed our own anyway so the test
  // never depends on prod's doctor pool composition.
  const specialtyId = 'spec-cardiology';

  let originalAutoAssign = null;
  let needsAutoAssignRestore = false;
  let originalRowExisted = false;

  try {
    // Capture and force the auto_assign_enabled flag for the duration of
    // the test. Without it, the inline fallback in job_queue.enqueueAutoAssign
    // exits early and we'd be testing the pre-fix world.
    const orig = await queryOne(
      "SELECT value FROM admin_settings WHERE key = 'auto_assign_enabled'"
    );
    originalRowExisted = !!orig;
    originalAutoAssign = orig ? orig.value : null;
    await execute(
      "INSERT INTO admin_settings (key, value, updated_at) " +
      "VALUES ('auto_assign_enabled', 'true', NOW()) " +
      "ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()"
    );
    needsAutoAssignRestore = true;

    // Seed test patient.
    await execute(
      "INSERT INTO users (id, role, name, email, is_active, created_at) " +
      "VALUES ($1, 'patient', 'Pin Test Patient', $2, true, NOW())",
      [patientId, patientId + '@pin.test']
    );

    // Seed the one eligible test doctor: cardiology + standard SLA tier.
    // Because we seed exactly one doctor with a unique id, autoAssignDoctor's
    // lowest-caseload tiebreaker will deterministically pick this row.
    await execute(
      "INSERT INTO users (id, role, name, email, is_active, specialty_id, sla_tiers_supported, created_at) " +
      "VALUES ($1, 'doctor', 'Pin Test Doctor', $2, true, $3, '[\"standard\"]'::jsonb, NOW())",
      [doctorId, doctorId + '@pin.test', specialtyId]
    );

    // Seed a submitted order. NOTE on the payment-gate (case_lifecycle.js:5-29):
    // assertPaidGate refuses to transition a case to PAID unless the row already
    // has payment_status='paid' AND paid_at set — the caller's contract per the
    // comment at markCasePaid line 1429 ("payment processor/webhook should set
    // payment_status='paid'") and what the Paymob webhook does at
    // payments.js:357-369 before calling markCasePaid. The test mirrors that
    // sequence: writes payment_status='paid' + paid_at, then invokes
    // markCasePaid for the lifecycle transition + unified post-payment hook.
    await execute(
      "INSERT INTO orders (id, patient_id, specialty_id, status, payment_status, paid_at, urgency_tier, sla_hours, updated_at) " +
      "VALUES ($1, $2, $3, 'submitted', 'paid', NOW(), 'standard', 48, NOW())",
      [orderId, patientId, specialtyId]
    );

    // === Action: fire the canonical payment lifecycle entry. ===
    await markCasePaid(orderId);

    // === Assertion A: order has doctor_id != NULL after the unified hook. ===
    const orderAfter = await pollFor(async function () {
      const o = await queryOne(
        'SELECT doctor_id FROM orders WHERE id = $1', [orderId]
      );
      return (o && o.doctor_id) ? o : null;
    }, 5000, 200);

    assert(
      !!(orderAfter && orderAfter.doctor_id),
      'paid order ends with doctor_id != NULL',
      'doctor_id still NULL after markCasePaid + 5s — post-payment hook did not fire'
    );
    assert(
      !!(orderAfter && orderAfter.doctor_id === doctorId),
      'paid order is assigned to the only eligible seeded doctor',
      'expected doctor_id=' + doctorId + ', got ' + (orderAfter && orderAfter.doctor_id)
    );

    // === Assertion B: doctor notification queued. ===
    const notif = await pollFor(async function () {
      return await queryOne(
        "SELECT id FROM notifications " +
        " WHERE order_id = $1 AND to_user_id = $2 AND template = 'order_auto_assigned_doctor' " +
        " LIMIT 1",
        [orderId, doctorId]
      );
    }, 3000, 200);

    assert(
      !!notif,
      "doctor notification queued with template='order_auto_assigned_doctor'",
      'no notifications row matching the order+doctor+template'
    );
  } catch (err) {
    t.fail(fileTag + ': runAll crashed', err);
  } finally {
    // Cleanup runs even on crash. Each statement wrapped so one failure
    // doesn't skip the rest (we want the DB to end in its original state).
    try { await execute('DELETE FROM notifications WHERE order_id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM orders WHERE id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM users WHERE id IN ($1, $2)', [patientId, doctorId]); } catch (_) {}
    if (needsAutoAssignRestore) {
      try {
        if (originalRowExisted) {
          await execute(
            "UPDATE admin_settings SET value = $1, updated_at = NOW() WHERE key = 'auto_assign_enabled'",
            [originalAutoAssign]
          );
        } else {
          // Row didn't exist before this test — remove the one we inserted
          // so admin_settings ends exactly as we found it.
          await execute("DELETE FROM admin_settings WHERE key = 'auto_assign_enabled'");
        }
      } catch (_) {}
    }
  }
})().catch(function (err) {
  t.fail(fileTag + ': runAll crashed (outer)', err);
});
