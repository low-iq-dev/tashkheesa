'use strict';
// Integration proof of eligibleDoctorClause against a REAL local Postgres.
// Onboarding-incomplete + missing-service-row doctors are excluded; a fully
// eligible one is included. Run:
//   DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//   PG_SSL=false node --test tests/services/doctor_eligibility_integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { eligibleDoctorClause } = require('../../src/services/doctor_eligibility');

const SUFFIX = 'elig-' + process.pid + '-' + Date.now();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (s, p) => pool.query(s, p);
let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

async function mkDoctor({ onboarding, active = true, paused = false }) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, onboarding_complete, specialty_id)
       VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7)`,
    [id, id + '@example.com', id, active, paused, onboarding, 'spec-' + SUFFIX]
  );
  return id;
}
async function mapService(docId, svcId) {
  await q(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [docId, svcId]);
}

test.after(async () => {
  await q('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await pool.end();
});

test('excludes onboarding-incomplete + service-less doctors; includes the fully eligible one', async () => {
  const svc = 'svc-' + SUFFIX;
  const eligible   = await mkDoctor({ onboarding: true });  await mapService(eligible, svc);
  const noOnboard  = await mkDoctor({ onboarding: false }); await mapService(noOnboard, svc);
  const noService  = await mkDoctor({ onboarding: true });  // never mapped to svc

  // $1 = svc id (serviceIdParam), $2 = our SUFFIX filter to scope to this test's rows.
  const frag = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' });
  const { rows } = await q(
    `SELECT u.id FROM users u WHERE ${frag} AND u.id LIKE $2`,
    [svc, '%' + SUFFIX + '%']
  );
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids.sort(), [eligible].sort(), 'only the fully-eligible doctor matches');
  assert.ok(!ids.includes(noOnboard), 'onboarding-incomplete excluded');
  assert.ok(!ids.includes(noService), 'service-less excluded');
});

test('excludes a paused-but-active+onboarded doctor holding the service', async () => {
  const svc = 'svc2-' + SUFFIX;
  const paused = await mkDoctor({ onboarding: true, active: true, paused: true });
  await mapService(paused, svc);

  const frag = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' });
  const { rows } = await q(
    `SELECT u.id FROM users u WHERE ${frag} AND u.id LIKE $2`,
    [svc, '%' + SUFFIX + '%']
  );
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(paused), 'paused doctor excluded');
});
