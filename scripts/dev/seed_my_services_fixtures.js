'use strict';

// ============================================================================
// SYNTHETIC dev/test seed for the doctor "My Services" feature (design §4.9).
//
// NOT a numbered migration — it lives under scripts/dev/ and is NEVER read by
// src/db.js#migrate(), so it can never run against prod on boot. ALL data is
// obviously fake: ids prefixed `seed_ms_`, emails @example.com, licences
// LIC-FIX-*. Seeds the four doctor shapes the union rule + coming_soon guard
// exist for. Idempotent (ON CONFLICT DO NOTHING everywhere); re-runnable.
//
// Requires migration 078 already applied (services.coming_soon must exist).
// Callable from tests:  await seedMyServicesFixtures(client)
// Standalone (against a clone):  node scripts/dev/seed_my_services_fixtures.js
// ============================================================================

const SEED_PREFIX = 'seed_ms_';

// ── Specialties ─────────────────────────────────────────────────────────────
// - spec_cardio_seed : has visible services (shape 3 normal)
// - spec_nephro_seed : has NO visible services (shape 1 cross-specialty own
//                      spec, shape 2 empty-union own spec); cross-spec maps
//                      point at cardio services
const SPECIALTIES = [
  { id: SEED_PREFIX + 'spec_cardio', name: 'Fixture Cardiology', name_ar: 'قلب (تجريبي)', is_visible: true },
  { id: SEED_PREFIX + 'spec_nephro', name: 'Fixture Nephrology', name_ar: 'كلى (تجريبي)', is_visible: true },
];

// ── Services (only real columns; NO name_ar column on services) ─────────────
//
// ecg, echo  — visible cardio services; doc_normal maps to BOTH (satisfies
//              "all own-specialty visible services are mapped" in shape 3).
// holter     — is_visible=false; belongs to cardio but NOT in the visible
//              catalogue. Only doc_solo maps it → last-doctor-standing shape.
//              (Visibility is independent of coming_soon; the untick guard fires
//              when active-doctor count drops to 0 regardless of is_visible.)
const SERVICES = [
  { id: SEED_PREFIX + 'svc_ecg',
    specialty_id: SEED_PREFIX + 'spec_cardio',
    name: 'Fixture ECG Review',   base_price: 500,  doctor_fee: 100, sla_hours: 48, is_visible: true },
  { id: SEED_PREFIX + 'svc_echo',
    specialty_id: SEED_PREFIX + 'spec_cardio',
    name: 'Fixture Echo Review',  base_price: 1200, doctor_fee: 240, sla_hours: 48, is_visible: true },
  // shape-4 target: is_visible=false so it doesn't inflate the visible count
  // for the normal shape, but the last-doctor-standing mechanics still apply.
  { id: SEED_PREFIX + 'svc_holter',
    specialty_id: SEED_PREFIX + 'spec_cardio',
    name: 'Fixture Holter Review', base_price: 3000, doctor_fee: 600, sla_hours: 48, is_visible: false },
];

// ── Doctors (users) ─────────────────────────────────────────────────────────
const DOCTORS = [
  // shape 3 — normal: cardiology, mapped to all VISIBLE cardio services (ecg+echo)
  { id: SEED_PREFIX + 'doc_normal', specialty_id: SEED_PREFIX + 'spec_cardio',
    email: 'fixture.normal@example.com', name: 'Dr. Fixture Normal', licence: 'LIC-FIX-N1', phone: '+20100000001' },
  // shape 1 — cross-specialty: nephrology (empty own catalogue), mapped to 2 cardio svcs
  { id: SEED_PREFIX + 'doc_cross', specialty_id: SEED_PREFIX + 'spec_nephro',
    email: 'fixture.cross@example.com', name: 'Dr. Fixture Cross', licence: 'LIC-FIX-X1', phone: '+20100000002' },
  // shape 2 — empty-union: nephrology, ZERO mappings
  { id: SEED_PREFIX + 'doc_empty', specialty_id: SEED_PREFIX + 'spec_nephro',
    email: 'fixture.empty@example.com', name: 'Dr. Fixture Empty', licence: 'LIC-FIX-E1', phone: '+20100000003' },
  // shape 4 — the SOLE active doctor holding svc_holter (last-doctor-standing)
  { id: SEED_PREFIX + 'doc_solo', specialty_id: SEED_PREFIX + 'spec_cardio',
    email: 'fixture.solo@example.com', name: 'Dr. Fixture Solo', licence: 'LIC-FIX-S1', phone: '+20100000004' },
];

// ── Mappings (doctor_services) ──────────────────────────────────────────────
const MAPPINGS = [
  // normal → all VISIBLE cardio services (ecg + echo only; holter is invisible)
  { doctor_id: SEED_PREFIX + 'doc_normal', service_id: SEED_PREFIX + 'svc_ecg' },
  { doctor_id: SEED_PREFIX + 'doc_normal', service_id: SEED_PREFIX + 'svc_echo' },
  // cross → 2 cross-specialty (cardio) services; own (nephro) catalogue is empty
  { doctor_id: SEED_PREFIX + 'doc_cross', service_id: SEED_PREFIX + 'svc_ecg' },
  { doctor_id: SEED_PREFIX + 'doc_cross', service_id: SEED_PREFIX + 'svc_echo' },
  // solo → ONLY svc_holter → exactly one active doctor, so unticking flips coming_soon
  { doctor_id: SEED_PREFIX + 'doc_solo', service_id: SEED_PREFIX + 'svc_holter' },
  // empty → (no rows) — the empty-union shape
];

const FIXTURES = Object.freeze({
  SEED_PREFIX,
  normal:             { doctorId: SEED_PREFIX + 'doc_normal', specialtyId: SEED_PREFIX + 'spec_cardio' },
  crossSpecialty:     { doctorId: SEED_PREFIX + 'doc_cross',  specialtyId: SEED_PREFIX + 'spec_nephro' },
  emptyUnion:         { doctorId: SEED_PREFIX + 'doc_empty',  specialtyId: SEED_PREFIX + 'spec_nephro' },
  lastDoctorStanding: { doctorId: SEED_PREFIX + 'doc_solo',   serviceId:   SEED_PREFIX + 'svc_holter'  },
});

async function seedMyServicesFixtures(client) {
  for (const s of SPECIALTIES) {
    await client.query(
      'INSERT INTO specialties (id, name, name_ar, is_visible) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [s.id, s.name, s.name_ar, s.is_visible]);
  }

  for (const sv of SERVICES) {
    await client.query(
      `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, sla_hours, is_visible, coming_soon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT (id) DO NOTHING`,
      [sv.id, sv.specialty_id, sv.id, sv.name, sv.base_price, sv.doctor_fee, sv.sla_hours, sv.is_visible]);
  }

  for (const d of DOCTORS) {
    await client.query(
      `INSERT INTO users (id, role, is_active, is_paused, onboarding_complete, specialty_id,
                          password_hash, first_login_at, email, name, phone,
                          medical_license_number, sub_specialties)
       VALUES ($1,'doctor',true,false,false,$2,NULL,NULL,$3,$4,$5,$6,'[]'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [d.id, d.specialty_id, d.email, d.name, d.phone, d.licence]);
  }

  for (const m of MAPPINGS) {
    await client.query(
      'INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT (doctor_id, service_id) DO NOTHING',
      [m.doctor_id, m.service_id]);
  }

  // Re-sync coming_soon for seed rows: a service is coming_soon when it has
  // zero active doctors mapped. Scoped to seed prefix so it never touches the
  // real catalogue.
  await client.query(
    `UPDATE services sv
        SET coming_soon = NOT EXISTS (
              SELECT 1 FROM doctor_services ds
                JOIN users u ON u.id = ds.doctor_id
               WHERE ds.service_id = sv.id
                 AND u.role = 'doctor'
                 AND u.is_active = true)
      WHERE sv.id LIKE $1`,
    [SEED_PREFIX + '%']);

  return {
    specialties: SPECIALTIES.length,
    services:    SERVICES.length,
    doctors:     DOCTORS.length,
    mappings:    MAPPINGS.length,
  };
}

async function cleanupMyServicesFixtures(client) {
  await client.query(
    'DELETE FROM doctor_services WHERE doctor_id LIKE $1',
    [SEED_PREFIX + '%']);
  await client.query(
    "DELETE FROM users WHERE id LIKE $1 AND role='doctor'",
    [SEED_PREFIX + '%']);
  await client.query(
    'DELETE FROM services WHERE id LIKE $1',
    [SEED_PREFIX + '%']);
  await client.query(
    'DELETE FROM specialties WHERE id LIKE $1',
    [SEED_PREFIX + '%']);
}

module.exports = { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES, SEED_PREFIX };

// Standalone runner (against a local clone only — NEVER prod).
// Reads DATABASE_URL from the environment. The caller is responsible for
// ensuring the target is not the production database.
if (require.main === module) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
    ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });
  seedMyServicesFixtures(pool)
    .then((s) => { console.log('[seed_my_services] seeded', s); return pool.end(); })
    .catch((e) => { console.error('[seed_my_services] FAILED:', e.message); pool.end(); process.exit(1); });
}
