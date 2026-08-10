'use strict';

// Exercises the SYNTHETIC My Services seed against the prod-schema clone /
// hermetic harness (same pattern as doctor_applications.test.js). before()
// applies migration 078 so services.coming_soon exists, then seeds. Skips
// gracefully with no DB. after() removes every fixture row.
//
// Run: node --test tests/services/seed_my_services_fixtures.test.js

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { Pool } = require('pg');

const { seedMyServicesFixtures, cleanupMyServicesFixtures, FIXTURES } =
  require('../../scripts/dev/seed_my_services_fixtures');

const M078 = path.join(__dirname, '..', '..', 'src', 'migrations',
  '078_reconcile_prod_hotfixes_20260810.sql');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

let DB_OK = false, skipReason = '';

test.before(async () => {
  const c = await pool.connect();
  try {
    await c.query(fs.readFileSync(M078, 'utf-8')); // ensure coming_soon exists
    await seedMyServicesFixtures(c);               // idempotent
    DB_OK = true;
  } catch (err) { skipReason = err.message; }
  finally { c.release(); }
});

test.after(async () => {
  try { if (DB_OK) await cleanupMyServicesFixtures(pool); } catch (_) {}
  await pool.end();
});

test('shape 3 (normal): all N own-specialty services are visible + mapped + pre-ticked', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const doc = FIXTURES.normal.doctorId;
  const spec = FIXTURES.normal.specialtyId;
  const svc = (await pool.query(
    "SELECT id FROM services WHERE specialty_id=$1 AND is_visible=true", [spec])).rows;
  assert.ok(svc.length >= 2, 'normal specialty has visible services');
  const mapped = (await pool.query(
    "SELECT service_id FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
  assert.equal(mapped.length, svc.length, 'doctor mapped to every own-specialty service');
});

test('shape 1 (cross-specialty): empty own specialty but N cross-specialty mappings; onboarding stays false', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const doc = FIXTURES.crossSpecialty.doctorId;
  const own = (await pool.query(
    "SELECT id FROM services WHERE specialty_id=(SELECT specialty_id FROM users WHERE id=$1) AND is_visible=true", [doc])).rows;
  assert.equal(own.length, 0, 'own specialty has zero visible services');
  const maps = (await pool.query(
    "SELECT service_id FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
  assert.ok(maps.length >= 2, 'has cross-specialty mappings (the Medhat/Ghoneim shape)');
  const u = (await pool.query("SELECT onboarding_complete FROM users WHERE id=$1", [doc])).rows[0];
  assert.equal(u.onboarding_complete, false, 'unconfirmed default — onboarding stays false');
});

test('shape 2 (empty-union): zero own-specialty services AND zero mappings', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const doc = FIXTURES.emptyUnion.doctorId;
  const own = (await pool.query(
    "SELECT id FROM services WHERE specialty_id=(SELECT specialty_id FROM users WHERE id=$1) AND is_visible=true", [doc])).rows;
  const maps = (await pool.query("SELECT 1 FROM doctor_services WHERE doctor_id=$1", [doc])).rows;
  assert.equal(own.length, 0, 'no own-specialty visible services');
  assert.equal(maps.length, 0, 'no cross-specialty mappings → union empty');
});

test('shape 4 (last-doctor-standing): the flagged service has exactly one active mapped doctor', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const svcId = FIXTURES.lastDoctorStanding.serviceId;
  const cnt = (await pool.query(
    `SELECT count(*)::int AS c FROM doctor_services ds
       JOIN users u ON u.id=ds.doctor_id
      WHERE ds.service_id=$1 AND u.role='doctor' AND u.is_active=true`, [svcId])).rows[0];
  assert.equal(cnt.c, 1, 'exactly one active doctor holds the service (untick will flip coming_soon)');
});

test('seed is idempotent — a second run inserts no duplicate mappings', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const before = (await pool.query("SELECT count(*)::int AS c FROM doctor_services WHERE doctor_id LIKE $1", [FIXTURES.SEED_PREFIX + '%'])).rows[0].c;
  await seedMyServicesFixtures(pool);
  const after = (await pool.query("SELECT count(*)::int AS c FROM doctor_services WHERE doctor_id LIKE $1", [FIXTURES.SEED_PREFIX + '%'])).rows[0].c;
  assert.equal(after, before, 're-seed added no rows');
});
