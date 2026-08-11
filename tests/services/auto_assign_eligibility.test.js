'use strict';
// Integration test: §4.6 onboarding gate + service-level filter in eligibleDoctorsFor.
// Three doctors in same specialty; only the fully eligible one should be returned.
// Run:
//   DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//   PG_SSL=false node --test tests/services/auto_assign_eligibility.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const SUFFIX = 'aa-elig-' + process.pid + '-' + Date.now();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (s, p) => pool.query(s, p);

const TEST_SPEC   = 'spec-' + SUFFIX;
const TEST_SVC    = 'svc-'  + SUFFIX;
let   DOC_ELIGIBLE;   // onboarding_complete=true + mapped to TEST_SVC + standard tier
let   DOC_NO_ONBOARD; // onboarding_complete=false + mapped to TEST_SVC
let   DOC_NO_SERVICE; // onboarding_complete=true  + NOT mapped to TEST_SVC

// We lazily require auto_assign AFTER the pool is set up so the module's own pg
// module inherits the correct DATABASE_URL env var that was set before test run.
let eligibleDoctorsFor;

async function mkDoctor({ suffix, onboarding, tiers }) {
  const id = suffix + '-' + SUFFIX;
  const tiersJson = tiers || JSON.stringify(['standard']);
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, pending_approval, onboarding_complete, specialty_id, sla_tiers_supported)
       VALUES ($1,$2,$3,'doctor',true,false,false,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [id, id + '@test.local', id, onboarding, TEST_SPEC, tiersJson]
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
  // Insert specialty
  await q(
    `INSERT INTO specialties (id, name, is_visible) VALUES ($1,'Test AA Elig',true) ON CONFLICT (id) DO NOTHING`,
    [TEST_SPEC]
  );

  DOC_ELIGIBLE   = await mkDoctor({ suffix: 'eligible',    onboarding: true  });
  DOC_NO_ONBOARD = await mkDoctor({ suffix: 'no-onboard',  onboarding: false });
  DOC_NO_SERVICE = await mkDoctor({ suffix: 'no-service',  onboarding: true  });

  await mapService(DOC_ELIGIBLE,   TEST_SVC);
  await mapService(DOC_NO_ONBOARD, TEST_SVC);
  // DOC_NO_SERVICE is intentionally NOT mapped

  // Load the module now (after env is ready)
  eligibleDoctorsFor = require('../../src/auto_assign').eligibleDoctorsFor;
});

test.after(async () => {
  await q(`DELETE FROM doctor_services WHERE doctor_id LIKE $1`, ['%' + SUFFIX + '%']);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['%' + SUFFIX + '%']);
  await q(`DELETE FROM specialties WHERE id = $1`, [TEST_SPEC]);
  await pool.end();
});

function ids(rows) {
  return rows.map((r) => r.id).sort();
}

test('eligibleDoctorsFor: includes only the onboarded + service-mapped doctor', async () => {
  const rows = await eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'standard', serviceId: TEST_SVC });
  const found = ids(rows);
  assert.ok(found.includes(DOC_ELIGIBLE),   'eligible doctor must be included');
  assert.ok(!found.includes(DOC_NO_ONBOARD),'onboarding-incomplete doctor must be excluded');
  assert.ok(!found.includes(DOC_NO_SERVICE),'service-less doctor must be excluded');
});

test('eligibleDoctorsFor: NULL serviceId falls back to specialty-only (legacy path)', async () => {
  // Without serviceId, onboarding_complete + service checks do not apply.
  // All three doctors (onboarded and not) should appear as long as specialty matches.
  const rows = await eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'standard', serviceId: null });
  const found = ids(rows);
  // All three are active, not paused, not pending_approval, same specialty → all visible on legacy path
  assert.ok(found.includes(DOC_ELIGIBLE),   'eligible doc visible on legacy path');
  assert.ok(found.includes(DOC_NO_ONBOARD), 'no-onboard doc visible on legacy path (no onboarding filter)');
  assert.ok(found.includes(DOC_NO_SERVICE), 'no-service doc visible on legacy path (no service filter)');
});

test('eligibleDoctorsFor: tier filter still applies when serviceId is provided', async () => {
  // Eligible doctor has sla_tiers_supported=["standard"] — should NOT appear for vip
  const rows = await eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'vip', serviceId: TEST_SVC });
  const found = ids(rows);
  assert.ok(!found.includes(DOC_ELIGIBLE), 'standard-only doctor excluded from vip tier');
});

test('eligibleDoctorsFor: pending_approval gate still applies when serviceId is provided', async () => {
  // Insert a pending_approval doctor who IS onboarded and service-mapped
  const pendingId = 'pending-' + SUFFIX;
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, pending_approval, onboarding_complete, specialty_id, sla_tiers_supported)
       VALUES ($1,$2,$3,'doctor',true,false,true,true,$4,'["standard"]'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [pendingId, pendingId + '@test.local', pendingId, TEST_SPEC]
  );
  await mapService(pendingId, TEST_SVC);

  const rows = await eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'standard', serviceId: TEST_SVC });
  const found = ids(rows);
  assert.ok(!found.includes(pendingId), 'pending_approval doctor excluded even when onboarded+service-mapped');

  // cleanup
  await q(`DELETE FROM doctor_services WHERE doctor_id = $1`, [pendingId]);
  await q(`DELETE FROM users WHERE id = $1`, [pendingId]);
});
