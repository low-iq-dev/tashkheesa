'use strict';
// Integration test: §4.6 onboarding gate + service-level filter in pickDoctorForOrder.
//
// Each exclusion predicate is independently proven by constructing a scenario
// where the ONLY candidate is the excluded doctor → pickDoctorForOrder must
// return null. Removing any one of the three predicates from src/assign.js
// MUST cause the corresponding test to fail.
//
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

// Shared specialty/service for the happy-path test
const SPEC_ELIGH   = 'TEST_ELIGH_spec-' + SUFFIX;
const SVC_ELIGH    = 'TEST_ELIGH_svc-'  + SUFFIX;

// Isolated specialty/service where the ONLY doctor has onboarding_complete=false
const SPEC_NO_OB   = 'TEST_NO_OB_spec-' + SUFFIX;
const SVC_NO_OB    = 'TEST_NO_OB_svc-'  + SUFFIX;

// Isolated specialty/service where the ONLY doctor is paused
const SPEC_PAUSED  = 'TEST_PAUSED_spec-' + SUFFIX;
const SVC_PAUSED   = 'TEST_PAUSED_svc-'  + SUFFIX;

// Isolated specialty/service where the ONLY doctor has NO doctor_services row
const SPEC_NO_SVC  = 'TEST_NO_SVC_spec-' + SUFFIX;
const SVC_NO_SVC   = 'TEST_NO_SVC_svc-'  + SUFFIX;

let DOC_ELIGIBLE;   // happy-path: onboarding_complete=true, not paused, service-mapped
let DOC_NO_OB;      // only doctor in SPEC_NO_OB: onboarding_complete=false
let DOC_PAUSED;     // only doctor in SPEC_PAUSED: is_paused=true
let DOC_NO_SVC;     // only doctor in SPEC_NO_SVC: NOT mapped to SVC_NO_SVC

let pickDoctorForOrder;

async function mkDoctor({ prefix, spec, onboarding, paused = false }) {
  const id = prefix + '-' + SUFFIX;
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, onboarding_complete, specialty_id)
       VALUES ($1,$2,$3,'doctor',true,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
    [id, id + '@test.local', id, paused, onboarding, spec]
  );
  return id;
}

async function mkSpecialty(id) {
  await q(
    `INSERT INTO specialties (id, name, is_visible) VALUES ($1,$1,true) ON CONFLICT (id) DO NOTHING`,
    [id]
  );
}

async function mapService(docId, svcId) {
  await q(
    `INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [docId, svcId]
  );
}

test.before(async () => {
  // Create all four isolated specialties
  await mkSpecialty(SPEC_ELIGH);
  await mkSpecialty(SPEC_NO_OB);
  await mkSpecialty(SPEC_PAUSED);
  await mkSpecialty(SPEC_NO_SVC);

  // Happy-path doctor: eligible in every way
  DOC_ELIGIBLE = await mkDoctor({ prefix: 'TEST_ELIGH_doc', spec: SPEC_ELIGH,  onboarding: true,  paused: false });
  await mapService(DOC_ELIGIBLE, SVC_ELIGH);

  // Onboarding-gate doctor: only doc in its specialty; onboarding_complete=false
  DOC_NO_OB = await mkDoctor({ prefix: 'TEST_NO_OB_doc',  spec: SPEC_NO_OB,   onboarding: false, paused: false });
  await mapService(DOC_NO_OB, SVC_NO_OB);

  // Paused-gate doctor: only doc in its specialty; is_paused=true, onboarding_complete=true
  DOC_PAUSED = await mkDoctor({ prefix: 'TEST_PAUSED_doc', spec: SPEC_PAUSED,  onboarding: true,  paused: true });
  await mapService(DOC_PAUSED, SVC_PAUSED);

  // Service-gate doctor: only doc in its specialty; onboarding_complete=true, not paused,
  // but has NO doctor_services row for SVC_NO_SVC
  DOC_NO_SVC = await mkDoctor({ prefix: 'TEST_NO_SVC_doc', spec: SPEC_NO_SVC,  onboarding: true,  paused: false });
  // Intentionally NOT calling mapService(DOC_NO_SVC, SVC_NO_SVC)

  // Load the module after DB is seeded
  pickDoctorForOrder = require('../../src/assign').pickDoctorForOrder;
});

test.after(async () => {
  await q(`DELETE FROM doctor_services WHERE doctor_id LIKE $1`, ['%' + SUFFIX + '%']);
  await q(`DELETE FROM users WHERE id LIKE $1`,            ['%' + SUFFIX + '%']);
  for (const spec of [SPEC_ELIGH, SPEC_NO_OB, SPEC_PAUSED, SPEC_NO_SVC]) {
    await q(`DELETE FROM specialties WHERE id = $1`, [spec]);
  }
  await pool.end();
});

// ── Happy path ──────────────────────────────────────────────────────────────

test('pickDoctorForOrder: picks the eligible doctor (onboarded + service-mapped + not paused)', async () => {
  const result = await pickDoctorForOrder({ specialtyId: SPEC_ELIGH, serviceId: SVC_ELIGH });
  assert.ok(result, 'should return a doctor');
  assert.equal(result.id, DOC_ELIGIBLE, 'should be the fully-eligible doctor');
});

test('pickDoctorForOrder: returns null when specialtyId is missing', async () => {
  const result = await pickDoctorForOrder({ specialtyId: null, serviceId: SVC_ELIGH });
  assert.equal(result, null, 'should return null for missing specialtyId');
});

// ── Exclusion predicates — each independently load-bearing ──────────────────
//
// Each test uses a specialty+service where the ONLY doctor present is the
// excluded one. If the corresponding predicate were removed from assign.js
// that doctor would become eligible and the test would fail (non-null result).

test('pickDoctorForOrder: returns null when only candidate has onboarding_complete=false', async () => {
  // SPEC_NO_OB has exactly one doctor: DOC_NO_OB (onboarding_complete=false, mapped, active, not paused).
  // The `COALESCE(u.onboarding_complete,false) = true` predicate must exclude it.
  const result = await pickDoctorForOrder({ specialtyId: SPEC_NO_OB, serviceId: SVC_NO_OB });
  assert.equal(result, null,
    'onboarding-incomplete doctor is the only candidate — must return null');
});

test('pickDoctorForOrder: returns null when only candidate is paused (is_paused=true)', async () => {
  // SPEC_PAUSED has exactly one doctor: DOC_PAUSED (onboarding_complete=true, mapped, active, is_paused=true).
  // The `COALESCE(u.is_paused,false) = false` predicate must exclude it.
  const result = await pickDoctorForOrder({ specialtyId: SPEC_PAUSED, serviceId: SVC_PAUSED });
  assert.equal(result, null,
    'paused doctor is the only candidate — must return null');
});

test('pickDoctorForOrder: returns null when only candidate has no doctor_services row', async () => {
  // SPEC_NO_SVC has exactly one doctor: DOC_NO_SVC (onboarding_complete=true, not paused, active)
  // but it has NO doctor_services row for SVC_NO_SVC.
  // The `EXISTS (SELECT 1 FROM doctor_services ...)` predicate must exclude it.
  const result = await pickDoctorForOrder({ specialtyId: SPEC_NO_SVC, serviceId: SVC_NO_SVC });
  assert.equal(result, null,
    'service-unmapped doctor is the only candidate — must return null');
});
