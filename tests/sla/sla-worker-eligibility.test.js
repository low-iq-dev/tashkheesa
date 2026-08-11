'use strict';
// §4.6 site 5 — the SLA worker's alternate-doctor selection now applies the
// shared eligibility gate keyed on the CASE's service_id. Real local Postgres.
// Run: DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//      PG_SSL=false node --test tests/sla/sla-worker-eligibility.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const SUFFIX = 'slaelig-' + process.pid + '-' + Date.now();
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa';
process.env.PG_SSL = process.env.PG_SSL || 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PG_SSL).toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (s, p) => pool.query(s, p);
let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// buildAlternateDoctorQuery is not exported; test through the module's public
// selectAlternateDoctor by requiring the internals via a thin re-export shim.
// (Add `buildAlternateDoctorQuery` to case_sla_worker's module.exports in Step 3.)
const { buildAlternateDoctorQuery } = require('../../src/case_sla_worker');

const spec = 'spec-' + SUFFIX;
const svcA = 'svcA-' + SUFFIX;

async function mkDoctor({ onboarding = true, active = true, paused = false, name }) {
  const id = uid('doc');
  await q(`INSERT INTO users (id,email,name,role,is_active,is_paused,onboarding_complete,specialty_id,created_at)
           VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7,NOW())`,
    [id, id + '@example.com', name || id, active, paused, onboarding, spec]);
  return id;
}
const mapSvc = (d, s) => q(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d, s]);

test.after(async () => {
  await q('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await pool.end();
});

test('service-keyed eligibility: only onboarded doctor holding the service row is selectable', async () => {
  const good     = await mkDoctor({ name: 'Good' });        await mapSvc(good, svcA);
  const noBoard  = await mkDoctor({ onboarding: false });   await mapSvc(noBoard, svcA);
  const wrongSvc = await mkDoctor({ name: 'Wrong' });       // no svcA row

  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId: spec, excludeDoctorId: null, countOnly: false, serviceId: svcA,
  });
  // Constrain to this test's rows so ORDER BY … LIMIT 1 is deterministic.
  // The query has two WHERE clauses (one in the subquery, one outer); we must
  // patch the OUTER one. The outer WHERE always follows ") a ON a.doctor_id = u.id".
  const scoped = query.replace(
    ') a ON a.doctor_id = u.id\n    WHERE ',
    ") a ON a.doctor_id = u.id\n    WHERE u.id LIKE '%" + SUFFIX + "%' AND "
  );
  const row = (await q(scoped, allParams)).rows[0];
  assert.ok(row, 'a doctor was selected');
  assert.equal(row.id, good, 'only the onboarded, service-holding doctor is eligible');
});

test('countOnly with service gate counts exactly the eligible pool', async () => {
  const { query, allParams } = buildAlternateDoctorQuery({
    specialtyId: spec, excludeDoctorId: null, countOnly: true, serviceId: svcA,
  });
  const scoped = query.replace(
    ') a ON a.doctor_id = u.id\n    WHERE ',
    ") a ON a.doctor_id = u.id\n    WHERE u.id LIKE '%" + SUFFIX + "%' AND "
  );
  const c = Number((await q(scoped, allParams)).rows[0].eligible_count);
  assert.equal(c, 1, 'exactly one eligible doctor for svcA');
});
