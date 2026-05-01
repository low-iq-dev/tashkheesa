'use strict';

// Integration test: tier-aware doctor pool selection.
// Requires a live Postgres DB (uses JSONB @> containment, not mockable).
// Run: DATABASE_URL=postgresql://... PG_SSL=false node --test src/__tests__/auto_assign.test.js

var test = require('node:test');
var assert = require('node:assert/strict');
var { execute, queryAll } = require('../pg');

// Loaded after fixtures so a missing export is a RED test, not a require crash.
var autoAssign = require('../auto_assign');

var SUFFIX = 'sla-rt-' + process.pid + '-' + Date.now();
var TEST_SPEC = 'spec-' + SUFFIX;
var DOC_A = 'doc-A-' + SUFFIX; // ["standard"]
var DOC_B = 'doc-B-' + SUFFIX; // ["standard","vip"]
var DOC_C = 'doc-C-' + SUFFIX; // ["standard","vip","urgent"]
var DOC_D = 'doc-D-' + SUFFIX; // sla_tiers_supported = NULL → defensive default = standard-only

async function seedDoctor(id, name, tiersJsonOrNull) {
  if (tiersJsonOrNull === null) {
    await execute(
      "INSERT INTO users (id, email, name, role, is_active, specialty_id, sla_tiers_supported) " +
      "VALUES ($1, $2, $3, 'doctor', true, $4, NULL)",
      [id, id + '@test.local', name, TEST_SPEC]
    );
  } else {
    await execute(
      "INSERT INTO users (id, email, name, role, is_active, specialty_id, sla_tiers_supported) " +
      "VALUES ($1, $2, $3, 'doctor', true, $4, $5::jsonb)",
      [id, id + '@test.local', name, TEST_SPEC, tiersJsonOrNull]
    );
  }
}

test.before(async function() {
  await execute(
    "INSERT INTO specialties (id, name, is_visible) VALUES ($1, 'Test SLA Routing', true) " +
    "ON CONFLICT (id) DO NOTHING",
    [TEST_SPEC]
  );
  await seedDoctor(DOC_A, 'A Standard',  JSON.stringify(['standard']));
  await seedDoctor(DOC_B, 'B Vip',       JSON.stringify(['standard', 'vip']));
  await seedDoctor(DOC_C, 'C Urgent',    JSON.stringify(['standard', 'vip', 'urgent']));
  await seedDoctor(DOC_D, 'D NullPref',  null);
});

test.after(async function() {
  await execute("DELETE FROM users WHERE id IN ($1,$2,$3,$4)", [DOC_A, DOC_B, DOC_C, DOC_D]);
  await execute("DELETE FROM specialties WHERE id = $1", [TEST_SPEC]);
  var { pool } = require('../pg');
  await pool.end();
});

function ids(rows) {
  return rows.map(function(r) { return r.id; }).sort();
}

test('Standard tier: every doctor eligible (incl. NULL prefs → defaults to standard)', async function() {
  var rows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'standard' });
  assert.deepEqual(ids(rows), [DOC_A, DOC_B, DOC_C, DOC_D].sort());
});

test('VIP tier: only doctors who opted into vip — A and D excluded', async function() {
  var rows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'vip' });
  assert.deepEqual(ids(rows), [DOC_B, DOC_C].sort());
});

test('Urgent tier: only doctor C eligible', async function() {
  var rows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'urgent' });
  assert.deepEqual(ids(rows), [DOC_C]);
});

test('NULL sla_tiers_supported is treated as standard-only', async function() {
  // Sanity: D shows up for standard, never for vip/urgent.
  var stdRows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'standard' });
  var vipRows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'vip' });
  var urgRows = await autoAssign.eligibleDoctorsFor({ specialtyId: TEST_SPEC, tier: 'urgent' });
  assert.ok(ids(stdRows).includes(DOC_D), 'D eligible for standard');
  assert.ok(!ids(vipRows).includes(DOC_D), 'D NOT eligible for vip');
  assert.ok(!ids(urgRows).includes(DOC_D), 'D NOT eligible for urgent');
});

test('Specialty filter still applies — doctors of other specialties are excluded', async function() {
  var rows = await autoAssign.eligibleDoctorsFor({ specialtyId: 'spec-does-not-exist-' + SUFFIX, tier: 'standard' });
  assert.deepEqual(rows, []);
});
