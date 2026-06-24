'use strict';

// createApplication — split-lifecycle write service, on a REAL local Postgres
// (real types, real COMMIT/ROLLBACK). The route owns the client; this service
// owns BEGIN/INSERT/COMMIT with ROLLBACK-in-catch (mirrors admin_refund.js).
//
// Skips gracefully when no test DB is reachable (CI without Postgres, or the
// local anon-role boot issue). before() also applies the 073 migration so the
// table exists. All fixtures carry a per-process SUFFIX and are cleaned in after().
//
// Run: node --test tests/services/doctor_applications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { createApplication } = require('../../src/services/doctor_applications');

const SUFFIX = 'app-' + process.pid + '-' + Date.now();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

const MIGRATION = path.join(__dirname, '..', '..', 'src', 'migrations', '073_doctor_applications.sql');

let DB_OK = false;
let skipReason = '';

test.before(async () => {
  try {
    const c = await pool.connect();
    try {
      await c.query(fs.readFileSync(MIGRATION, 'utf-8')); // idempotent — ensures the table exists
      DB_OK = true;
    } finally {
      c.release();
    }
  } catch (err) {
    skipReason = err.message;
  }
});

test.after(async () => {
  try {
    if (DB_OK) await pool.query("DELETE FROM doctor_applications WHERE email LIKE $1", ['%' + SUFFIX + '%']);
  } catch (_) { /* best-effort cleanup */ }
  await pool.end();
});

function rec(over) {
  return Object.assign({
    full_name: 'Dr. Sara Ali',
    full_name_ar: 'د. سارة علي',
    email: 'sara+' + SUFFIX + '@example.com',
    phone: '+201001234567',
    specialty_id: 'spec-cardiology',
    specialty_other: null,
    sub_specialties: ['Interventional Cardiology', 'Underwater Basket Weaving'],
    medical_license_number: 'LIC-123',
    license_country: 'EG',
    bio: 'experienced',
    bio_ar: 'خبرة',
    cv_url: 'https://example.com/cv.pdf',
    current_affiliation: 'Shifa Hospitals',
    years_experience: 12,
    source: 'web_apply',
    submitter_ip: '203.0.113.7',
    user_agent: 'node-test',
  }, over || {});
}

test('valid input inserts exactly ONE row with defaults + sub_specialties stored verbatim (incl. free-text)', async (t) => {
  if (!DB_OK) return t.skip('no test DB reachable: ' + skipReason);
  const client = await pool.connect();
  let out;
  try {
    out = await createApplication(client, rec());
  } finally {
    client.release();
  }
  assert.ok(out && out.id, 'returns the new application id');
  assert.equal(out.status, 'new');
  assert.equal(out.source, 'web_apply');

  const rows = (await pool.query('SELECT * FROM doctor_applications WHERE id = $1', [out.id])).rows;
  assert.equal(rows.length, 1, 'exactly one row inserted');
  const r = rows[0];
  assert.equal(r.status, 'new', 'status defaults to new');
  assert.equal(r.source, 'web_apply');
  assert.equal(r.full_name, 'Dr. Sara Ali');
  assert.equal(r.email, 'sara+' + SUFFIX + '@example.com');
  assert.equal(r.specialty_id, 'spec-cardiology');
  assert.equal(r.years_experience, 12);
  // jsonb round-trips as a JS array; the unlisted free-text value survives verbatim
  assert.deepEqual(r.sub_specialties, ['Interventional Cardiology', 'Underwater Basket Weaving']);
  assert.ok(r.created_at, 'created_at defaulted');
});

test('a forced in-transaction error → ROLLBACK leaves ZERO rows', async (t) => {
  if (!DB_OK) return t.skip('no test DB reachable: ' + skipReason);
  const email = 'rollback+' + SUFFIX + '@example.com';
  const client = await pool.connect();
  let threw = false;
  try {
    // years_experience is an INTEGER column; a non-castable value forces the
    // INSERT to error inside the BEGIN — the service must ROLLBACK and rethrow.
    await createApplication(client, rec({ email, years_experience: 'NOT-AN-INT' }));
  } catch (_) {
    threw = true;
  } finally {
    client.release();
  }
  assert.equal(threw, true, 'the in-transaction error propagated');
  const rows = (await pool.query('SELECT id FROM doctor_applications WHERE email = $1', [email])).rows;
  assert.equal(rows.length, 0, 'ROLLBACK left no persisted row');
});
