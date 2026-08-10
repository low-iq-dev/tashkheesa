'use strict';

// loadDoctorServiceCatalog — union loader over services + doctor_services,
// on a REAL Postgres (real jsonb, real joins). Seeds its own synthetic
// fixtures with a per-process SUFFIX, cleans them in after(). Skips
// gracefully when no test DB is reachable (CI / local anon-role boot issue).
//
// Run: node --test tests/services/doctor_service_catalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { loadDoctorServiceCatalog } = require('../../src/services/doctor_service_catalog');

const SUFFIX = 'dsc-' + process.pid + '-' + Date.now();
const SPEC_A = 'spec-A-' + SUFFIX;   // has visible services
const SPEC_B = 'spec-B-' + SUFFIX;   // empty catalogue (0 visible services)
const SPEC_C = 'spec-C-' + SUFFIX;   // cross-specialty source
const SVC_A1 = 'svc-A1-' + SUFFIX;
const SVC_A2 = 'svc-A2-' + SUFFIX;
const SVC_C1 = 'svc-C1-' + SUFFIX;   // in SPEC_C, mapped cross-specialty
const SVC_HIDDEN = 'svc-hid-' + SUFFIX; // visible=false in SPEC_A, held via row
const DOC_NORMAL = 'doc-normal-' + SUFFIX;   // in SPEC_A, mapped to A1,A2
const DOC_CROSS = 'doc-cross-' + SUFFIX;     // in SPEC_B, mapped to C1 + hidden
const DOC_EMPTY = 'doc-empty-' + SUFFIX;     // in SPEC_B, 0 mappings

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

let DB_OK = false;
let skipReason = '';

test.before(async () => {
  const c = await pool.connect().catch((e) => { skipReason = e.message; return null; });
  if (!c) return;
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO specialties (id, name, name_ar, is_visible) VALUES
         ($1,'Alpha','ألفا',true),($2,'Beta','بيتا',true),($3,'Gamma','جاما',true)
       ON CONFLICT (id) DO NOTHING`,
      [SPEC_A, SPEC_B, SPEC_C]
    );
    await c.query(
      `INSERT INTO services (id, name, base_price, doctor_fee, sla_hours, is_visible, coming_soon, specialty_id) VALUES
         ($1,'A One',1000,200,48,true,false,$5),
         ($2,'A Two',2000,400,24,true,false,$5),
         ($3,'C One',3000,600,72,true,false,$6),
         ($4,'A Hidden',1500,300,48,false,false,$5)
       ON CONFLICT (id) DO NOTHING`,
      [SVC_A1, SVC_A2, SVC_C1, SVC_HIDDEN, SPEC_A, SPEC_C]
    );
    await c.query(
      `INSERT INTO users (id, role, name, specialty_id, is_active, onboarding_complete) VALUES
         ($1,'doctor','Dr Normal',$4,true,false),
         ($2,'doctor','Dr Cross',$5,true,false),
         ($3,'doctor','Dr Empty',$5,true,false)
       ON CONFLICT (id) DO NOTHING`,
      [DOC_NORMAL, DOC_CROSS, DOC_EMPTY, SPEC_A, SPEC_B]
    );
    await c.query(
      `INSERT INTO doctor_services (doctor_id, service_id) VALUES
         ($1,$3),($1,$4),($2,$5),($2,$6)
       ON CONFLICT DO NOTHING`,
      [DOC_NORMAL, DOC_CROSS, SVC_A1, SVC_A2, SVC_C1, SVC_HIDDEN]
    );
    await c.query('COMMIT');
    DB_OK = true;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    skipReason = err.message;
  } finally {
    c.release();
  }
});

test.after(async () => {
  if (DB_OK) {
    await pool.query('DELETE FROM doctor_services WHERE doctor_id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM services WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
    await pool.query('DELETE FROM specialties WHERE id LIKE $1', ['%' + SUFFIX]).catch(() => {});
  }
  await pool.end();
});

test('normal doctor: own-specialty visible services, ticks reflect rows', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_NORMAL, specialtyId: SPEC_A }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, false);
  // union = A1, A2 (both visible in own specialty, both held)
  const ids = [...out.allowedIds].sort();
  assert.deepEqual(ids, [SVC_A1, SVC_A2].sort());
  const all = out.groups.flatMap((g) => g.services);
  assert.equal(all.length, 2);
  assert.ok(all.every((s) => s.ticked === true), 'both held → ticked');
  const a1 = all.find((s) => s.id === SVC_A1);
  assert.equal(a1.doctor_fee, 200, 'doctor_fee surfaced for "You earn"');
  assert.equal(a1.name_ar, null, 'services has no name_ar column');
});

test('cross-specialty doctor: sees N cross-specialty held items grouped under their specialty', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  // DOC_CROSS is in SPEC_B (0 visible services) but holds SVC_C1 (Gamma) + SVC_HIDDEN (Alpha, hidden)
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_CROSS, specialtyId: SPEC_B }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, false);
  const ids = [...out.allowedIds].sort();
  assert.deepEqual(ids, [SVC_C1, SVC_HIDDEN].sort(), 'union = held rows only (own specialty empty)');
  const gammaGroup = out.groups.find((g) => g.specialtyId === SPEC_C);
  assert.ok(gammaGroup, 'held cross-specialty service grouped under its own specialty');
  assert.equal(gammaGroup.specialtyNameAr, 'جاما');
  const alphaGroup = out.groups.find((g) => g.specialtyId === SPEC_A);
  assert.ok(alphaGroup.services.find((s) => s.id === SVC_HIDDEN && s.ticked === true), 'held hidden svc still shown+ticked');
});

test('empty-union doctor: isEmpty=true, no groups', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  let out;
  try { out = await loadDoctorServiceCatalog(c, { doctorId: DOC_EMPTY, specialtyId: SPEC_B }); }
  finally { c.release(); }
  assert.equal(out.isEmpty, true);
  assert.equal(out.allowedIds.size, 0);
  assert.equal(out.groups.length, 0);
});
