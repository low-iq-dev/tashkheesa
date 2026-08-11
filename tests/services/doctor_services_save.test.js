'use strict';

// diffServiceSelection (pure) + a DB-backed save round-trip.
// Run: node --test tests/services/doctor_services_save.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { diffServiceSelection } = require('../../src/services/doctor_service_catalog');
const { loadDoctorServiceCatalog } = require('../../src/services/doctor_service_catalog');

// ── Pure helper: no DB ──────────────────────────────────────────────────────
test('diffServiceSelection: computes insert/delete within the allowed union', () => {
  const allowed = new Set(['a', 'b', 'c']);
  const current = ['a', 'b'];          // doctor currently holds a,b
  const ticked = ['b', 'c'];           // wants b,c
  const out = diffServiceSelection(allowed, current, ticked);
  assert.deepEqual(out.toInsert.sort(), ['c']);
  assert.deepEqual(out.toDelete.sort(), ['a']);
  assert.deepEqual(out.rejected, []);
});

test('diffServiceSelection: rejects ticked ids outside the allowed union', () => {
  const allowed = new Set(['a', 'b']);
  const out = diffServiceSelection(allowed, ['a'], ['a', 'z']); // z not allowed
  assert.deepEqual(out.rejected, ['z']);
});

test('diffServiceSelection: never deletes current rows outside the union', () => {
  // 'x' is held but not in the allowed union (e.g. legacy row) — must be left alone
  const allowed = new Set(['a']);
  const out = diffServiceSelection(allowed, ['a', 'x'], []); // untick everything allowed
  assert.deepEqual(out.toDelete, ['a'], 'only union rows are deletable');
  assert.ok(!out.toDelete.includes('x'), 'out-of-union held row is preserved');
});

// ── DB-backed: save no-change preserves rows ────────────────────────────────
const SUFFIX = 'dss-' + process.pid + '-' + Date.now();
const SPEC = 'spec-' + SUFFIX;
const SVC1 = 'svc1-' + SUFFIX;
const SVC2 = 'svc2-' + SUFFIX;
const DOC = 'doc-' + SUFFIX;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
let DB_OK = false, skipReason = '';

test.before(async () => {
  const c = await pool.connect().catch((e) => { skipReason = e.message; return null; });
  if (!c) return;
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO specialties (id,name,is_visible) VALUES ($1,'Sp',true) ON CONFLICT (id) DO NOTHING`, [SPEC]);
    await c.query(`INSERT INTO services (id,name,base_price,doctor_fee,sla_hours,is_visible,coming_soon,specialty_id)
                   VALUES ($1,'S1',100,20,48,true,false,$3),($2,'S2',200,40,48,true,false,$3)
                   ON CONFLICT (id) DO NOTHING`, [SVC1, SVC2, SPEC]);
    await c.query(`INSERT INTO users (id,role,name,specialty_id,is_active,onboarding_complete)
                   VALUES ($1,'doctor','Dr X',$2,true,false) ON CONFLICT (id) DO NOTHING`, [DOC, SPEC]);
    await c.query(`INSERT INTO doctor_services (doctor_id,service_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [DOC, SVC1, SVC2]);
    await c.query('COMMIT');
    DB_OK = true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); skipReason = e.message; }
  finally { c.release(); }
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

test('save-with-no-change: diff is empty, both rows preserved', async (t) => {
  if (!DB_OK) return t.skip('no test DB: ' + skipReason);
  const c = await pool.connect();
  try {
    const cat = await loadDoctorServiceCatalog(c, { doctorId: DOC, specialtyId: SPEC });
    const current = [SVC1, SVC2];
    const ticked = [SVC1, SVC2]; // no change
    const diff = diffServiceSelection(cat.allowedIds, current, ticked);
    assert.deepEqual(diff.toInsert, []);
    assert.deepEqual(diff.toDelete, []);
  } finally { c.release(); }
  const n = (await pool.query('SELECT COUNT(*)::int AS c FROM doctor_services WHERE doctor_id=$1', [DOC])).rows[0].c;
  assert.equal(n, 2, 'no-change save preserves both rows');
});
