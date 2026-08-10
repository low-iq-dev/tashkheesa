'use strict';
// Integration test: §4.6 onboarding gate + service-level filter in pickDoctorForOrder.
// Verifies that paused, onboarding-incomplete, and service-less doctors are excluded,
// and that the eligible, onboarded, service-mapped doctor is selected.
// Run:
//   DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//   PG_SSL=false node --test tests/services/assign_pick_eligibility.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const SUFFIX = 'pick-elig-' + process.pid + '-' + Date.now();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (s, p) => pool.query(s, p);

const TEST_SPEC = 'spec-' + SUFFIX;
const TEST_SVC  = 'svc-'  + SUFFIX;

let DOC_ELIGIBLE;    // onboarding_complete=true + mapped + active + not paused
let DOC_NO_ONBOARD;  // onboarding_complete=false + mapped
let DOC_PAUSED;      // onboarding_complete=true  + mapped + paused
let DOC_NO_SERVICE;  // onboarding_complete=true  + NOT mapped

let pickDoctorForOrder;

async function mkDoctor({ suffix, onboarding, paused = false }) {
  const id = suffix + '-' + SUFFIX;
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, onboarding_complete, specialty_id)
       VALUES ($1,$2,$3,'doctor',true,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
    [id, id + '@test.local', id, paused, onboarding, TEST_SPEC]
  );
  return id;
}

async function mapService(docId, svcId) {
  await q(
    `INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [docId, svcId]
  );
}

test.before(async () => {
  // Insert test specialty (no FK to services table needed for users)
  await q(
    `INSERT INTO specialties (id, name, is_visible) VALUES ($1,'Test Pick Elig',true) ON CONFLICT (id) DO NOTHING`,
    [TEST_SPEC]
  );

  DOC_ELIGIBLE   = await mkDoctor({ suffix: 'eligible',   onboarding: true,  paused: false });
  DOC_NO_ONBOARD = await mkDoctor({ suffix: 'no-onboard', onboarding: false, paused: false });
  DOC_PAUSED     = await mkDoctor({ suffix: 'paused',     onboarding: true,  paused: true  });
  DOC_NO_SERVICE = await mkDoctor({ suffix: 'no-service', onboarding: true,  paused: false });

  await mapService(DOC_ELIGIBLE,   TEST_SVC);
  await mapService(DOC_NO_ONBOARD, TEST_SVC);
  await mapService(DOC_PAUSED,     TEST_SVC);
  // DOC_NO_SERVICE intentionally NOT mapped

  // Load the module now (after env is ready)
  pickDoctorForOrder = require('../../src/assign').pickDoctorForOrder;
});

test.after(async () => {
  await q(`DELETE FROM doctor_services WHERE doctor_id LIKE $1`, ['%' + SUFFIX + '%']);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['%' + SUFFIX + '%']);
  await q(`DELETE FROM specialties WHERE id = $1`, [TEST_SPEC]);
  await pool.end();
});

test('pickDoctorForOrder: picks the eligible doctor (onboarded + service-mapped + not paused)', async () => {
  const result = await pickDoctorForOrder({ specialtyId: TEST_SPEC, serviceId: TEST_SVC });
  assert.ok(result, 'should return a doctor');
  assert.equal(result.id, DOC_ELIGIBLE, 'should be the fully-eligible doctor');
});

test('pickDoctorForOrder: excludes onboarding-incomplete doctor', async () => {
  const result = await pickDoctorForOrder({ specialtyId: TEST_SPEC, serviceId: TEST_SVC });
  assert.ok(!result || result.id !== DOC_NO_ONBOARD, 'onboarding-incomplete doctor must be excluded');
});

test('pickDoctorForOrder: excludes paused doctor', async () => {
  const result = await pickDoctorForOrder({ specialtyId: TEST_SPEC, serviceId: TEST_SVC });
  assert.ok(!result || result.id !== DOC_PAUSED, 'paused doctor must be excluded');
});

test('pickDoctorForOrder: excludes doctor without service mapping', async () => {
  const result = await pickDoctorForOrder({ specialtyId: TEST_SPEC, serviceId: TEST_SVC });
  assert.ok(!result || result.id !== DOC_NO_SERVICE, 'service-less doctor must be excluded');
});

test('pickDoctorForOrder: returns null when specialtyId is missing', async () => {
  const result = await pickDoctorForOrder({ specialtyId: null, serviceId: TEST_SVC });
  assert.equal(result, null, 'should return null for missing specialtyId');
});
