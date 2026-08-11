'use strict';

// Re-sync helper (services.coming_soon truthfulness) — hermetic suite on a REAL
// local Postgres (real types, real UPDATE; not mocks). Modeled on
// admin_doctor_pause.test.js. Proves the §4.3 formula: a service is coming_soon
// iff it has NO mapped active doctor. Covers: flips true when the last active
// doctor's mapping is removed, flips false when re-added, is a no-op when a
// mapped doctor is merely paused (is_paused, NOT is_active — the formula is
// keyed on is_active), respects the caller's txn when a client is passed
// (rolls back with it), and is idempotent (second call = 0 changes).
//
// Run: node --test tests/services/services_coming_soon_sync.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { resyncComingSoon } = require('../../src/services/services_coming_soon_sync');

const SUFFIX = 'cs-' + process.pid + '-' + Date.now();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A doctor row. is_active drives the formula; is_paused must NOT.
async function mkDoctor({ active = true, paused = false, role = 'doctor' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, is_paused) VALUES ($1, $2, $3, $4)`,
    [id, role, active, paused]
  );
  return id;
}

// A visible service, coming_soon seeded so we can watch it flip either way.
async function mkService({ comingSoon = false } = {}) {
  const id = uid('svc');
  await q(
    `INSERT INTO services (id, name, is_visible, coming_soon, base_price, doctor_fee, sla_hours)
       VALUES ($1, $2, true, $3, 500, 100, 48)`,
    [id, 'Test Svc ' + id, comingSoon]
  );
  return id;
}

async function map(doctorId, serviceId) {
  await q(
    `INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2)
       ON CONFLICT (doctor_id, service_id) DO NOTHING`,
    [doctorId, serviceId]
  );
}
async function unmap(doctorId, serviceId) {
  await q(`DELETE FROM doctor_services WHERE doctor_id = $1 AND service_id = $2`, [doctorId, serviceId]);
}
async function comingSoonOf(serviceId) {
  return (await q(`SELECT coming_soon FROM services WHERE id = $1`, [serviceId])).rows[0].coming_soon;
}

test.after(async () => {
  await q(`DELETE FROM doctor_services WHERE doctor_id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await q(`DELETE FROM services WHERE id LIKE $1`, ['svc-' + SUFFIX + '-%']);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

// ─────────── remove last active doctor → coming_soon flips true ───────────
test('unmapping the last active doctor flips coming_soon true', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();                    // has a doctor → stays false
  assert.equal(await comingSoonOf(svc), false, 'mapped: bookable');

  await unmap(doc, svc);
  await resyncComingSoon();                    // no doctor → flips true
  assert.equal(await comingSoonOf(svc), true, 'unmapped: coming soon');
});

// ─────────── re-map → coming_soon flips back false ───────────
test('re-mapping an active doctor flips coming_soon false', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: true });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), false, 're-mapped: bookable again');
});

// ─────────── keyed on is_active, NOT is_paused ───────────
test('a mapped-but-PAUSED (is_active still true) doctor keeps coming_soon false', async () => {
  const doc = await mkDoctor({ active: true, paused: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), false, 'is_paused must NOT hide the doctor from supply');
});

// ─────────── an INACTIVE doctor does not count as supply ───────────
test('a mapped INACTIVE doctor leaves coming_soon true', async () => {
  const doc = await mkDoctor({ active: false });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), true, 'is_active=false is not supply');
});

// ─────────── honours a caller-supplied txn client (rolls back with it) ───────────
test('when passed a client, the UPDATE is inside the caller txn and rolls back', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: true });   // starts true
  await map(doc, svc);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resyncComingSoon(client);                    // would flip to false…
    await client.query('ROLLBACK');                    // …but we roll back
  } finally {
    client.release();
  }
  assert.equal(await comingSoonOf(svc), true, 'rolled back with the caller txn — still true');
});

// ─────────── idempotent: a second call changes 0 rows ───────────
test('idempotent — a second resync reports rowCount but no state change', async () => {
  const doc = await mkDoctor({ active: true });
  const svc = await mkService({ comingSoon: false });
  await map(doc, svc);
  await resyncComingSoon();
  const before = await comingSoonOf(svc);
  await resyncComingSoon();
  assert.equal(await comingSoonOf(svc), before, 'second call leaves state identical');
});
