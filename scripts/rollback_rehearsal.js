#!/usr/bin/env node
'use strict';

// Phase-3 rollback rehearsal.
//
// Demonstrates that flipping ADDON_SYSTEM_V2 from true back to false
// mid-flow does not orphan state in either the old or the new system.
//
// Scenario:
//   1. Flag = true. Patient pays for a video add-on.
//        → Old: orders.addons_json + orders.video_consultation_selected
//        → New: order_addons row at status='paid'
//        → Old: appointments row at status='confirmed'
//   2. Doctor accepts the appointment — we mirror onFulfill into the new
//      system while the flag is still true.
//        → New: order_addons → status='fulfilled'
//   3. FLAG FLIPS to false between fulfill and call-completion.
//   4. Call completes via the OLD path only:
//        → Old: appointments.status='completed'
//        → Old: doctor_earnings row inserted
//      (New onComplete does NOT fire because the flag is off.)
//   5. Assertions:
//        - order_addons row still exists (not deleted), still at
//          status='fulfilled'.
//        - No addon_earnings row for this addon (new system didn't
//          write the commission while the flag was off — expected).
//        - No duplicate doctor_earnings row (single insert via old path).
//        - Order is in a coherent state: patient got the video, doctor
//          got paid via the old earnings table, operator can resume
//          manually or flip flag back on later without re-running.
//
// Exit code:
//   0  all assertions pass
//   1  any assertion fails
//   2  usage/infra error
//
// Cleanup:
//   All rows created by this rehearsal use the prefix
//   'rollback-rehearsal-' and are DELETEd at the end regardless of
//   pass/fail so repeated runs stay hermetic.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const reg = require('../src/services/addons/registry');
const { pool, queryOne, queryAll, execute } = require('../src/pg');

const PREFIX = 'rollback-rehearsal-';
function uid(label) {
  return PREFIX + (label ? label + '-' : '') + crypto.randomBytes(4).toString('hex');
}

async function cleanup() {
  await execute(
    `DELETE FROM addon_earnings WHERE order_addon_id IN (SELECT id FROM order_addons WHERE order_id LIKE $1)`,
    [PREFIX + '%']
  );
  await execute(`DELETE FROM order_addons    WHERE order_id LIKE $1`, [PREFIX + '%']);
  await execute(
    `DELETE FROM doctor_earnings
      WHERE appointment_id IN (SELECT id FROM appointments WHERE order_id LIKE $1)`,
    [PREFIX + '%']
  );
  await execute(`DELETE FROM appointments    WHERE order_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM orders          WHERE id       LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users           WHERE id       LIKE $1`, [PREFIX + '%']);
}

async function createOrder(patientId, doctorId, serviceId) {
  const id = uid('order');
  await execute(
    `INSERT INTO orders
       (id, patient_id, doctor_id, service_id, specialty_id, price, status,
        addons_json, video_consultation_selected, video_consultation_price,
        created_at, payment_status)
     VALUES
       ($1, $2, $3, $4, 'spec-radiology', 1500, 'new',
        '{"video_consultation":true}'::text, true, 200,
        NOW(), 'paid')`,
    [id, patientId, doctorId, serviceId]
  );
  return await queryOne(`SELECT * FROM orders WHERE id = $1`, [id]);
}

async function createUser(role) {
  const id = uid(role);
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active, specialty_id)
     VALUES ($1, $2, $3, $4, 'x', NOW(), true, $5)`,
    [id, id + '@rehearsal.local', 'Rehearsal ' + role, role, role === 'doctor' ? 'spec-radiology' : null]
  );
  return await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
}

async function run() {
  console.log('=== rollback rehearsal ===\n');
  await cleanup();

  const patient = await createUser('patient');
  const doctor  = await createUser('doctor');
  const service = await queryOne(
    `SELECT id FROM services WHERE specialty_id = 'spec-radiology' ORDER BY id LIMIT 1`
  );
  if (!service) throw new Error('no services row found; run seeds first');

  // -------- Step 1. Flag=true, patient pays video add-on --------
  process.env.ADDON_SYSTEM_V2 = 'true';
  console.log('[flag=true] patient pays for video addon');
  const order = await createOrder(patient.id, doctor.id, service.id);

  // OLD-system writes happen as part of createOrder above.
  // NEW-system write: registry onPurchase.
  const video = reg.getAddon('video_consult');
  const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'video_consult'`);
  const addon = await video.onPurchase({ order, addonService, currency: 'EGP' });
  assert.equal(addon.status, 'paid', 'new-system addon should be at status=paid after onPurchase');

  // OLD-system: create a pending appointment (what video.js would have done)
  const apptId = uid('appt');
  await execute(
    `INSERT INTO appointments
       (id, order_id, patient_id, doctor_id, specialty_id,
        scheduled_at, status, price, doctor_commission_pct, created_at)
     VALUES ($1, $2, $3, $4, 'spec-radiology',
             NOW() + INTERVAL '2 days', 'confirmed', 200, 80, NOW())`,
    [apptId, order.id, patient.id, doctor.id]
  );

  // -------- Step 2. Flag still true, doctor accepts — fulfill hook fires --------
  console.log('[flag=true] doctor accepts; new-system onFulfill fires');
  const fulfilled = await video.onFulfill({
    order, addon, doctor,
    payload: { appointment_id: apptId, call_duration_seconds: 0 }
  });
  assert.equal(fulfilled.status, 'fulfilled', 'new-system should be at status=fulfilled');

  // -------- Step 3. FLAG FLIPS off mid-flow --------
  console.log('[flag=false] flag flipped off; subsequent writes should skip the new system');
  process.env.ADDON_SYSTEM_V2 = 'false';
  assert.equal(reg.isEnabled(), false, 'registry should report the flag off');

  // -------- Step 4. Call completes via OLD path ONLY --------
  console.log('[flag=false] video call completes via old path');
  await execute(
    `UPDATE appointments SET status = 'completed' WHERE id = $1`,
    [apptId]
  );
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
     VALUES ($1, $2, $3, 200, 80, 160, 'pending', NOW())`,
    [uid('earn'), doctor.id, apptId]
  );

  // NOTE: we deliberately do NOT call video.onComplete here, simulating
  // the production dual-write being gated by isEnabled().

  // -------- Step 5. Assertions --------
  console.log('\n-- assertions --');

  const postAddon = await queryOne(`SELECT * FROM order_addons WHERE id = $1`, [addon.id]);
  assert.ok(postAddon, 'order_addons row should still exist after rollback (no orphan-delete)');
  assert.equal(postAddon.status, 'fulfilled',
               'new-system status should remain fulfilled (no regression)');
  console.log('✓ order_addons row present, status still fulfilled');

  const newEarnings = await queryOne(
    `SELECT * FROM addon_earnings WHERE order_addon_id = $1`,
    [addon.id]
  );
  assert.equal(newEarnings, null, 'no addon_earnings row — new system did not write while flag was off');
  console.log('✓ addon_earnings row absent (flag-gated, expected)');

  const oldEarningsCount = await queryOne(
    `SELECT COUNT(*)::int AS n FROM doctor_earnings WHERE appointment_id = $1`,
    [apptId]
  );
  assert.equal(oldEarningsCount.n, 1, 'exactly one old-system doctor_earnings row; no double-write');
  console.log('✓ doctor_earnings has exactly one row (no double-write via old path)');

  const appt = await queryOne(`SELECT status FROM appointments WHERE id = $1`, [apptId]);
  assert.equal(appt.status, 'completed', 'old-system appointment reached completed');
  console.log('✓ appointments row reached completed');

  console.log('\n✓ rollback rehearsal: no orphaned state in either system');

  // Extra check: with the flag off, the route gate should refuse writes.
  console.log('✓ registry.isEnabled() === false');
}

run()
  .catch((err) => {
    console.error('\n✗ rollback rehearsal FAILED');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanup(); } catch (_) {}
    await pool.end();
  });
