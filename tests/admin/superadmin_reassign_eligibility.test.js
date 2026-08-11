'use strict';

// Task 17 — eligibility gate on the superadmin reassign SELECT (spec §4.6).
//
// Tests the tightened SELECT in POST /superadmin/orders/:id/reassign:
//
//   SELECT id, name FROM users u
//     WHERE u.id = $1
//       AND u.role = 'doctor'
//       AND COALESCE(u.is_active, true) = true
//       AND COALESCE(u.is_paused, false) = false
//       AND COALESCE(u.onboarding_complete, false) = true
//       AND EXISTS (SELECT 1 FROM doctor_services ds
//                   WHERE ds.doctor_id = u.id AND ds.service_id = $2)
//
// (src/routes/superadmin.js, line 3718 — pinned)
//
// Approach: run the exact SELECT against seeded rows (via seed_my_services_fixtures.js)
// on the local PG clone. This directly tests the predicate set without booting the
// superadmin router (which requires the broken local `anon` role).
//
// The exclusion tests are LOAD-BEARING: they assert NO ROW when only the excluded
// doctor exists, proving the gate rejects them.
//
// Run:
//   DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa PG_SSL=false \
//     node --test tests/admin/superadmin_reassign_eligibility.test.js
//
// Skipped automatically when DATABASE_URL is not set, so `npm test` counts it as
// skipped and never attempts a connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES, SEED_PREFIX } = require('../../scripts/dev/seed_my_services_fixtures');

if (!process.env.DATABASE_URL) {
  test('superadmin reassign eligibility — DB tests (skip: DATABASE_URL not set)', (t) => {
    t.skip('DATABASE_URL not set');
  });
  // Exit early so we never open a pool.
} else {

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false,
});

// The exact SELECT from src/routes/superadmin.js line 3718.
// Keep this string identical to the route — if you change one, change both.
const REASSIGN_DOCTOR_SQL = `
  SELECT id, name FROM users u
   WHERE u.id = $1
     AND u.role = 'doctor'
     AND COALESCE(u.is_active, true) = true
     AND COALESCE(u.is_paused, false) = false
     AND COALESCE(u.onboarding_complete, false) = true
     AND EXISTS (SELECT 1 FROM doctor_services ds
                  WHERE ds.doctor_id = u.id AND ds.service_id = $2)
`;

// Helper: run the reassign SELECT for a given doctor + service.
async function runReassignSelect(client, doctorId, serviceId) {
  const res = await client.query(REASSIGN_DOCTOR_SQL, [doctorId, serviceId]);
  return res.rows[0] || null;
}

// ── Seed once before all tests ────────────────────────────────────────────────

let client;

test('setup: seed fixtures', async () => {
  client = await pool.connect();
  const counts = await seedMyServicesFixtures(client);
  assert.ok(counts.doctors >= 4, `expected >= 4 seeded doctors, got ${counts.doctors}`);
});

// ── Exclusion tests (LOAD-BEARING) ────────────────────────────────────────────
// Each asserts NO ROW when the specific ineligibility condition applies.

test('LOAD-BEARING: onboarding_complete=false doctor → no row (excluded)', async () => {
  // The seed fixture inserts all doctors with onboarding_complete=false.
  // seed_ms_doc_normal is seeded with onboarding_complete=false (see seed script line 107).
  // So any seeded doctor hit for the service they cover must return no row here.
  const doctorId = FIXTURES.normal.doctorId;         // doc_normal — mapped to svc_ecg
  const serviceId = SEED_PREFIX + 'svc_ecg';          // service doc_normal offers

  // Confirm the seeded row actually has onboarding_complete=false (guard against
  // future seed changes silently making this test meaningless).
  const userRow = await client.query('SELECT onboarding_complete FROM users WHERE id = $1', [doctorId]);
  assert.ok(userRow.rows.length === 1, 'seed_ms_doc_normal must exist');
  assert.equal(userRow.rows[0].onboarding_complete, false, 'seed_ms_doc_normal must have onboarding_complete=false');

  const row = await runReassignSelect(client, doctorId, serviceId);
  assert.equal(row, null, 'onboarding-incomplete doctor must be excluded from reassign SELECT');
});

test('LOAD-BEARING: no doctor_services mapping → no row (excluded)', async () => {
  // Temporarily insert an onboarding-complete doctor who is NOT mapped to the
  // service we'll query for, then verify SELECT returns no row.
  const tmpDoctorId = SEED_PREFIX + 'tmp_no_svc_map';
  const serviceId   = SEED_PREFIX + 'svc_ecg';  // a real service this doctor does NOT offer

  await client.query(
    `INSERT INTO users (id, role, is_active, is_paused, onboarding_complete, specialty_id,
                        password_hash, first_login_at, email, name, phone,
                        medical_license_number, sub_specialties)
     VALUES ($1,'doctor',true,false,true,$2,NULL,NULL,$3,$4,$5,$6,'[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [tmpDoctorId, SEED_PREFIX + 'spec_cardio',
     'tmp_no_svc_map@example.com', 'Dr TmpNoSvcMap', '+20100009901', 'LIC-TMP-NS1']
  );
  // Intentionally NO doctor_services row for (tmpDoctorId, svc_ecg).

  try {
    const row = await runReassignSelect(client, tmpDoctorId, serviceId);
    assert.equal(row, null, 'doctor with no service mapping must be excluded from reassign SELECT');
  } finally {
    await client.query('DELETE FROM doctor_services WHERE doctor_id = $1', [tmpDoctorId]);
    await client.query("DELETE FROM users WHERE id = $1 AND role = 'doctor'", [tmpDoctorId]);
  }
});

test('LOAD-BEARING: is_paused=true doctor → no row (excluded)', async () => {
  const tmpDoctorId = SEED_PREFIX + 'tmp_paused';
  const serviceId   = SEED_PREFIX + 'svc_ecg';

  await client.query(
    `INSERT INTO users (id, role, is_active, is_paused, onboarding_complete, specialty_id,
                        password_hash, first_login_at, email, name, phone,
                        medical_license_number, sub_specialties)
     VALUES ($1,'doctor',true,true,true,$2,NULL,NULL,$3,$4,$5,$6,'[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [tmpDoctorId, SEED_PREFIX + 'spec_cardio',
     'tmp_paused@example.com', 'Dr TmpPaused', '+20100009902', 'LIC-TMP-P1']
  );
  await client.query(
    'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [tmpDoctorId, serviceId]
  );

  try {
    const row = await runReassignSelect(client, tmpDoctorId, serviceId);
    assert.equal(row, null, 'paused doctor must be excluded from reassign SELECT');
  } finally {
    await client.query('DELETE FROM doctor_services WHERE doctor_id = $1', [tmpDoctorId]);
    await client.query("DELETE FROM users WHERE id = $1 AND role = 'doctor'", [tmpDoctorId]);
  }
});

// ── Inclusion test — eligible doctor returns a row ────────────────────────────

test('eligible doctor (onboarded + not paused + service mapped) → row returned', async () => {
  const tmpDoctorId = SEED_PREFIX + 'tmp_eligible';
  const serviceId   = SEED_PREFIX + 'svc_ecg';

  await client.query(
    `INSERT INTO users (id, role, is_active, is_paused, onboarding_complete, specialty_id,
                        password_hash, first_login_at, email, name, phone,
                        medical_license_number, sub_specialties)
     VALUES ($1,'doctor',true,false,true,$2,NULL,NULL,$3,$4,$5,$6,'[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [tmpDoctorId, SEED_PREFIX + 'spec_cardio',
     'tmp_eligible@example.com', 'Dr TmpEligible', '+20100009903', 'LIC-TMP-EL1']
  );
  await client.query(
    'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [tmpDoctorId, serviceId]
  );

  try {
    const row = await runReassignSelect(client, tmpDoctorId, serviceId);
    assert.ok(row !== null, 'eligible doctor must be returned by reassign SELECT');
    assert.equal(row.id, tmpDoctorId);
    assert.equal(row.name, 'Dr TmpEligible');
  } finally {
    await client.query('DELETE FROM doctor_services WHERE doctor_id = $1', [tmpDoctorId]);
    await client.query("DELETE FROM users WHERE id = $1 AND role = 'doctor'", [tmpDoctorId]);
  }
});

// ── Teardown ──────────────────────────────────────────────────────────────────

test('teardown: cleanup fixtures', async () => {
  await cleanupMyServicesFixtures(client);
  client.release();
  await pool.end();
});

} // end else (DATABASE_URL set)
