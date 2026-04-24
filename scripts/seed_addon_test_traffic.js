#!/usr/bin/env node
'use strict';

// Phase-3 prep: seed controlled test traffic for the parity window.
//
// Creates 5 orders covering every addon combination the production system
// will see, with BOTH old-system state (orders.addons_json, video-specific
// columns, appointments row) AND new-system state (order_addons,
// addon_earnings). Simulates the dual-write payments.js will eventually
// produce — so the parity script has something non-empty to compare.
//
// Run locally first:  node scripts/seed_addon_test_traffic.js --env=local
// Run on prod:        node scripts/seed_addon_test_traffic.js --env=prod
//
// Sentinel prefix: 'parity-fixture-'. Use `--cleanup` to remove all such
// rows (plus the addon_earnings / order_addons / appointments / orders
// they created).
//
// DATABASE_URL / PG_SSL come from env. The npm wrapper sets them for
// local runs; in production they are already set by Render.

'use strict';

const crypto = require('node:crypto');
const reg = require('../src/services/addons/registry');
const { pool, queryOne, queryAll, execute } = require('../src/pg');

const PREFIX = 'parity-fixture-';

function uid(label) {
  return PREFIX + (label ? label + '-' : '') + crypto.randomBytes(4).toString('hex');
}

// ---- args ----
const args = process.argv.slice(2);
const envFlag    = args.find(a => a.startsWith('--env=')) || '--env=local';
const cleanup    = args.includes('--cleanup');
const env        = envFlag.split('=')[1];
if (!['local', 'prod'].includes(env)) {
  console.error('Usage: seed_addon_test_traffic.js --env=<local|prod> [--cleanup]');
  process.exit(2);
}

async function runCleanup() {
  console.log('[' + env + '] Removing all ' + PREFIX + '* rows …');
  const dropped = {
    addon_earnings: 0, order_addons: 0, appointments: 0, doctor_earnings: 0, orders: 0, users: 0
  };
  dropped.addon_earnings = (await execute(
    `DELETE FROM addon_earnings
      WHERE order_addon_id IN (SELECT id FROM order_addons WHERE order_id LIKE $1)`,
    [PREFIX + '%']
  )).rowCount;
  dropped.order_addons  = (await execute(`DELETE FROM order_addons  WHERE order_id LIKE $1`, [PREFIX + '%'])).rowCount;
  dropped.appointments  = (await execute(`DELETE FROM appointments  WHERE order_id LIKE $1`, [PREFIX + '%'])).rowCount;
  dropped.doctor_earnings = (await execute(
    `DELETE FROM doctor_earnings
      WHERE appointment_id LIKE $1 OR doctor_id LIKE $2`,
    [PREFIX + '%', PREFIX + '%']
  )).rowCount;
  dropped.orders        = (await execute(`DELETE FROM orders         WHERE id       LIKE $1`, [PREFIX + '%'])).rowCount;
  dropped.users         = (await execute(`DELETE FROM users          WHERE id       LIKE $1`, [PREFIX + '%'])).rowCount;
  console.log('[' + env + '] Deleted:', dropped);
}

// ---- fixture helpers ----

async function ensureDoctor() {
  const id = uid('doc');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active, specialty_id)
     VALUES ($1, $2, $3, 'doctor', 'x', NOW(), true, 'spec-radiology')`,
    [id, id + '@seed.local', 'Parity Doctor']
  );
  return await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
}

async function ensurePatient() {
  const id = uid('pat');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active)
     VALUES ($1, $2, $3, 'patient', 'x', NOW(), true)`,
    [id, id + '@seed.local', 'Parity Patient']
  );
  return await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
}

async function pickServiceId() {
  const row = await queryOne(
    `SELECT id FROM services WHERE specialty_id = 'spec-radiology' ORDER BY id LIMIT 1`
  );
  return row ? row.id : null;
}

async function createOrder({ patientId, doctorId, serviceId, price = 1500, addonsObj = null, videoPrice = 0 }) {
  const id = uid('order');
  await execute(
    `INSERT INTO orders
       (id, patient_id, doctor_id, service_id, specialty_id, price, status,
        addons_json, video_consultation_selected, video_consultation_price,
        sla_hours, created_at, payment_status)
     VALUES
       ($1, $2, $3, $4, 'spec-radiology', $5, 'new',
        $6, $7, $8, $9, NOW(), 'paid')`,
    [id, patientId, doctorId, serviceId, price,
     addonsObj ? JSON.stringify(addonsObj) : null,
     !!(addonsObj && addonsObj.video_consultation),
     videoPrice,
     addonsObj && addonsObj.sla_24hr ? 24 : 72]
  );
  return await queryOne(`SELECT * FROM orders WHERE id = $1`, [id]);
}

// Simulated dual-write: writes the old-system shape (orders.addons_json,
// video appointments / video_calls / doctor_earnings) AND the new-system
// shape (order_addons, addon_earnings). This mirrors what payments.js will
// do in Phase 3. Idempotent per (order_id, addon_service_id).
async function attachAndFulfillAddon({ order, addonId, doctor, currency = 'EGP', fulfill = true, complete = true }) {
  const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = $1`, [addonId]);
  if (!addonService) throw new Error('unknown addon: ' + addonId);
  const svc = reg.getAddon(addonId);

  // ---- OLD SYSTEM WRITES ----
  // Video: also create an appointment + (optionally) doctor_earnings row.
  if (addonId === 'video_consult' && fulfill) {
    const apptId = uid('appt');
    await execute(
      `INSERT INTO appointments
         (id, order_id, patient_id, doctor_id, specialty_id,
          scheduled_at, status, price, doctor_commission_pct, created_at)
       VALUES ($1, $2, $3, $4, 'spec-radiology',
               NOW() + INTERVAL '2 days', $5, $6, $7, NOW())`,
      [apptId, order.id, order.patient_id, doctor.id,
       complete ? 'completed' : 'confirmed',
       200, 80]
    );
    if (complete) {
      await execute(
        `INSERT INTO doctor_earnings
           (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
         VALUES ($1, $2, $3, 200, 80, 160, 'pending', NOW())`,
        [uid('earn'), doctor.id, apptId]
      );
    }
  }

  // ---- NEW SYSTEM WRITES (via the registry) ----
  const purchased = await svc.onPurchase({ order, addonService, currency });
  if (svc.constructor.hasLifecycle && fulfill) {
    const payload = addonId === 'video_consult'
      ? { appointment_id: 'seeded-appt', call_duration_seconds: 720 }
      : addonId === 'prescription'
      ? { text_body: 'Rx: atorvastatin 20 mg nightly', pdf_storage_key: null }
      : {};
    await svc.onFulfill({ order, addon: purchased, doctor, payload });
    if (complete) {
      const refreshed = await queryOne(`SELECT * FROM order_addons WHERE id = $1`, [purchased.id]);
      await svc.onComplete({ order, addon: refreshed, doctorId: doctor.id });
    }
  }
}

async function run() {
  if (cleanup) { await runCleanup(); return; }

  const prev = process.env.ADDON_SYSTEM_V2;
  process.env.ADDON_SYSTEM_V2 = 'true';
  try {
    const patient = await ensurePatient();
    const doctor  = await ensureDoctor();
    const svcId   = await pickServiceId();
    if (!svcId) throw new Error('no services row found (spec-radiology); run migrations + seed first');

    const fixtures = [
      { label: 'video-only',         addons: { video_consultation: true }, videoPrice: 200 },
      { label: 'prescription-only',   addons: { prescription: true, prescription_price: 400 }, videoPrice: 0 },
      { label: 'video+prescription',  addons: { video_consultation: true, prescription: true, prescription_price: 400 }, videoPrice: 200 }
    ];

    console.log('[' + env + '] Seeding ' + fixtures.length + ' orders under prefix ' + PREFIX);
    const summary = [];
    for (const f of fixtures) {
      const order = await createOrder({
        patientId: patient.id, doctorId: doctor.id, serviceId: svcId,
        addonsObj: f.addons, videoPrice: f.videoPrice
      });

      if (f.addons.video_consultation) {
        await attachAndFulfillAddon({ order, addonId: 'video_consult', doctor });
      }
      if (f.addons.prescription) {
        await attachAndFulfillAddon({ order, addonId: 'prescription', doctor });
      }
      summary.push({ label: f.label, order_id: order.id });
    }

    console.log('\n✓ seeded fixtures:');
    for (const s of summary) console.log('  ' + s.label.padEnd(22) + ' ' + s.order_id);

    const counts = await queryOne(
      `SELECT
         (SELECT COUNT(*) FROM orders         WHERE id       LIKE $1) AS orders,
         (SELECT COUNT(*) FROM order_addons   WHERE order_id LIKE $1) AS order_addons,
         (SELECT COUNT(*) FROM addon_earnings WHERE order_addon_id IN (SELECT id FROM order_addons WHERE order_id LIKE $1)) AS addon_earnings,
         (SELECT COUNT(*) FROM appointments   WHERE order_id LIKE $1) AS appointments,
         (SELECT COUNT(*) FROM doctor_earnings dE
            WHERE dE.appointment_id IN (SELECT a.id FROM appointments a WHERE a.order_id LIKE $1)) AS doctor_earnings`,
      [PREFIX + '%']
    );
    console.log('\n[' + env + '] row counts under prefix:');
    console.log(counts);
    console.log('\nRun the parity script next: node scripts/verify_addon_parity.js');
  } finally {
    if (prev === undefined) delete process.env.ADDON_SYSTEM_V2;
    else process.env.ADDON_SYSTEM_V2 = prev;
  }
}

run()
  .catch((err) => {
    console.error('seed failed:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => { await pool.end(); });
