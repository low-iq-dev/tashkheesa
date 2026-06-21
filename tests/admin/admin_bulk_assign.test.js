'use strict';

// Bulk auto-assign — hermetic suite on a REAL local Postgres.
//
// Modeled on src/__tests__/auto_assign.test.js: real db.connect(), real
// SAVEPOINT/COMMIT/ROLLBACK semantics — NOT mocks. This is deliberate: the
// SLA-override prod dry-run once caught a param-type bug the mocked unit tests
// structurally could not. A real DB is the only honest atomicity proof.
//
// Run: DATABASE_URL=postgresql://ziadelwahsh@localhost:5432/tashkheesa \
//      PG_SSL=false node --test tests/admin/admin_bulk_assign.test.js
//
// Each test creates its OWN specialty so doctor pools are isolated; all fixtures
// carry a per-process SUFFIX and are deleted in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { bulkAutoAssign } = require('../../src/services/admin_bulk_assign');

const SUFFIX = 'bulk-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

async function mkSpec(label) {
  const id = uid('spec');
  await q("INSERT INTO specialties (id, name, is_visible) VALUES ($1,$2,true) ON CONFLICT (id) DO NOTHING", [id, label || id]);
  return id;
}

async function mkDoctor(spec, opts = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, email, name, role, is_active, is_paused, specialty_id,
                        max_active_cases, max_active_cases_urgent, sla_tiers_supported)
       VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7,$8,$9)`,
    [id, id + '@t.local', opts.name || id, opts.active !== false, !!opts.paused, spec,
      opts.cap == null ? null : opts.cap, opts.capUrgent == null ? null : opts.capUrgent,
      opts.tiers == null ? null : JSON.stringify(opts.tiers)]
  );
  return id;
}

async function mkCase(spec, opts = {}) {
  const id = uid('ord');
  const ageMin = opts.ageMin == null ? 5 : opts.ageMin;
  await q(
    `INSERT INTO orders (id, reference_id, status, payment_status, paid_at, specialty_id,
                         urgency_tier, sla_hours, assignment_status, doctor_id, deleted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() - ($12 || ' minutes')::interval)`,
    [id, 'REF-' + id,
      opts.status || 'paid',
      opts.payment === undefined ? 'paid' : opts.payment,
      opts.paid === false ? null : new Date().toISOString(),
      spec,  // pass null explicitly for the no_specialty case
      opts.tier || 'standard',
      opts.sla == null ? 72 : opts.sla,
      opts.assignment === undefined ? 'auto' : opts.assignment,
      opts.doctor || null,
      opts.deleted ? new Date().toISOString() : null,
      String(ageMin)]
  );
  return id;
}

// Seed N existing non-terminal cases against a doctor to set their active load.
async function seedLoad(doctorId, n, spec) {
  for (let k = 0; k < n; k++) {
    await q(
      `INSERT INTO orders (id, status, payment_status, paid_at, specialty_id, doctor_id, created_at)
         VALUES ($1,'in_review','paid',NOW(),$2,$3, NOW())`,
      [uid('load'), spec, doctorId]
    );
  }
}

async function run(caseIds, dryRun = false) {
  const client = await pool.connect();
  try {
    return await bulkAutoAssign(client, { caseIds, actorId: ACTOR, dryRun });
  } finally {
    client.release();
  }
}

const pick = (arr, caseId) => arr.find((x) => x.caseId === caseId);
const dbOrder = async (id) => (await q('SELECT doctor_id, status, assignment_status FROM orders WHERE id=$1', [id])).rows[0];
const assignCount = async (caseId) => Number((await q('SELECT COUNT(*) c FROM doctor_assignments WHERE case_id=$1', [caseId])).rows[0].c);
const loadOf = async (doctorId) => Number((await q(
  `SELECT COUNT(*) c FROM orders WHERE doctor_id=$1 AND deleted_at IS NULL
     AND LOWER(COALESCE(status,'')) NOT IN ('completed','cancelled','expired_unpaid','refunded')`, [doctorId])).rows[0].c);

// Proxy a real client so a single targeted query throws, but everything else —
// incl. SAVEPOINT / ROLLBACK TO / RELEASE / COMMIT — hits the real connection,
// so rollbacks are REAL. `shouldThrow(sql, params)` decides.
function faultClient(real, shouldThrow) {
  return new Proxy(real, {
    get(t, prop) {
      if (prop === 'query') {
        return (sql, params) => (shouldThrow(sql, params)
          ? Promise.reject(new Error('injected fault'))
          : t.query(sql, params));
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

test.after(async () => {
  await q('DELETE FROM doctor_assignments WHERE case_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM order_events WHERE order_id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM error_logs WHERE message LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM orders WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM users WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await q('DELETE FROM specialties WHERE id LIKE $1', ['%' + SUFFIX + '%']);
  await pool.end();
});

// ── happy path + least-loaded distribution + cumulative tiebreak ──────────────
test('happy: two cases distribute across two zero-load doctors (least-loaded + name tiebreak)', async () => {
  const spec = await mkSpec();
  const docA = await mkDoctor(spec, { name: 'A Doc' });
  const docB = await mkDoctor(spec, { name: 'B Doc' });
  const c1 = await mkCase(spec, { ageMin: 20 }); // processed first (older)
  const c2 = await mkCase(spec, { ageMin: 10 });

  const r = await run([c1, c2]);

  assert.equal(r.counts.assigned, 2);
  assert.equal(r.counts.skipped, 0);
  // c1 → A (tie 0=0, name 'A Doc' < 'B Doc'); then A=1 so c2 → B (0 < 1)
  assert.equal(pick(r.assigned, c1).doctorId, docA);
  assert.equal(pick(r.assigned, c2).doctorId, docB);
  assert.equal((await dbOrder(c1)).doctor_id, docA);
  assert.equal((await dbOrder(c1)).status, 'ASSIGNED');
  assert.equal(await assignCount(c1), 1);
  assert.equal(await assignCount(c2), 1);
});

// ── THE cumulative-capacity boundary: 4/5 doctor + 3 cases → 1 assigned, 2 full ─
test('cumulative capacity: doctor at 4/5 takes exactly ONE of three cases', async () => {
  const spec = await mkSpec();
  const doc = await mkDoctor(spec, { name: 'Cap Doc', cap: 5 });
  await seedLoad(doc, 4, spec);                 // existing load = 4
  const c1 = await mkCase(spec, { ageMin: 30 });
  const c2 = await mkCase(spec, { ageMin: 20 });
  const c3 = await mkCase(spec, { ageMin: 10 });

  const r = await run([c1, c2, c3]);

  assert.equal(r.counts.assigned, 1, 'exactly one assigned');
  assert.equal(r.counts.skipped, 2, 'the other two are full');
  const got = r.assigned[0];
  assert.equal(got.doctorId, doc);
  assert.equal(got.projectedLoad, 5);
  assert.equal(got.cap, 5);
  for (const s of r.skipped) assert.equal(s.reason, 'all_doctors_at_capacity');
  assert.equal(await loadOf(doc), 5, 'doctor ended at exactly 5, never 6+');
});

// ── every skip reason ─────────────────────────────────────────────────────────
test('skip reasons: not_found / already_assigned / payment_not_confirmed / not_assignable / no_specialty / flagged_manual_review', async () => {
  const spec = await mkSpec();
  await mkDoctor(spec, { name: 'Z Doc' });
  const notFound = uid('ghost');
  const alreadyAssigned = await mkCase(spec, { doctor: 'someone-' + SUFFIX });
  const unpaid = await mkCase(spec, { paid: false, payment: 'unpaid' });
  const notAssignable = await mkCase(spec, { status: 'submitted' }); // paid but status≠paid
  const noSpecialty = await mkCase(null);
  const manual = await mkCase(spec, { assignment: 'manual_queue' });

  const r = await run([notFound, alreadyAssigned, unpaid, notAssignable, noSpecialty, manual]);

  assert.equal(r.counts.assigned, 0);
  assert.equal(pick(r.skipped, notFound).reason, 'not_found');
  assert.equal(pick(r.skipped, alreadyAssigned).reason, 'already_assigned');
  assert.equal(pick(r.skipped, unpaid).reason, 'payment_not_confirmed');
  assert.equal(pick(r.skipped, notAssignable).reason, 'not_assignable');
  assert.equal(pick(r.skipped, noSpecialty).reason, 'no_specialty');
  assert.equal(pick(r.skipped, manual).reason, 'flagged_manual_review');
});

test('skip reasons: no_doctor_for_specialty + no_available_doctor (only doctor is paused)', async () => {
  const specEmpty = await mkSpec();                 // no doctors
  const specPaused = await mkSpec();
  await mkDoctor(specPaused, { name: 'Paused', paused: true });
  const noDoctor = await mkCase(specEmpty);
  const allPaused = await mkCase(specPaused);

  const r = await run([noDoctor, allPaused]);

  assert.equal(pick(r.skipped, noDoctor).reason, 'no_doctor_for_specialty');
  assert.equal(pick(r.skipped, allPaused).reason, 'no_available_doctor');
});

// ── manual_queue is excluded even when a doctor IS available (the real point) ──
test('manual_queue exclusion: a manual case with an available doctor is still skipped, writes nothing', async () => {
  const spec = await mkSpec();
  await mkDoctor(spec, { name: 'Free Doc' }); // has capacity
  const manual = await mkCase(spec, { assignment: 'manual_queue' });

  const r = await run([manual]);

  assert.equal(r.counts.assigned, 0);
  assert.equal(pick(r.skipped, manual).reason, 'flagged_manual_review');
  assert.equal((await dbOrder(manual)).doctor_id, null, 'never auto-routed');
  assert.equal(await assignCount(manual), 0);
});

// ── partial success + invariant ───────────────────────────────────────────────
test('partial success: mixed batch → some assigned, some skipped, assigned+skipped===requested', async () => {
  const spec = await mkSpec();
  await mkDoctor(spec, { name: 'Mix Doc' });
  const ok = await mkCase(spec);
  const manual = await mkCase(spec, { assignment: 'manual_pending' });
  const noSpec = await mkCase(null);

  const r = await run([ok, manual, noSpec]);

  assert.equal(r.counts.requested, 3);
  assert.equal(r.counts.assigned, 1);
  assert.equal(r.counts.skipped, 2);
  assert.equal(r.assigned.length + r.skipped.length, r.requested);
  assert.equal(pick(r.assigned, ok) !== undefined, true);
  assert.equal(pick(r.skipped, manual).reason, 'flagged_manual_review');
  assert.equal(pick(r.skipped, noSpec).reason, 'no_specialty');
});

// ── dryRun: identical plan, ZERO writes ───────────────────────────────────────
test('dryRun: returns the plan but persists nothing', async () => {
  const spec = await mkSpec();
  await mkDoctor(spec, { name: 'Dry Doc' });
  const c1 = await mkCase(spec);
  const c2 = await mkCase(spec);

  const r = await run([c1, c2], true);

  assert.equal(r.dryRun, true);
  assert.equal(r.counts.assigned, 2, 'plan shows what WOULD happen');
  // DB unchanged:
  assert.equal((await dbOrder(c1)).doctor_id, null);
  assert.equal((await dbOrder(c1)).status, 'paid');
  assert.equal(await assignCount(c1), 0);
  assert.equal(await assignCount(c2), 0);
});

// ── atomicity #1: per-case savepoint rollback, siblings persist ───────────────
test('atomicity: a fault on case #2 audit insert rolls back ONLY case #2; #1 and #3 commit', async () => {
  const spec = await mkSpec();
  const doc = await mkDoctor(spec, { name: 'Atom Doc' }); // uncapped
  const c1 = await mkCase(spec, { ageMin: 30 });
  const c2 = await mkCase(spec, { ageMin: 20 });
  const c3 = await mkCase(spec, { ageMin: 10 });

  const real = await pool.connect();
  const proxy = faultClient(real, (sql, params) =>
    typeof sql === 'string' && /INSERT INTO error_logs/i.test(sql)
      && Array.isArray(params) && params.some((p) => typeof p === 'string' && p.includes(c2)));

  let r;
  try {
    r = await bulkAutoAssign(proxy, { caseIds: [c1, c2, c3], actorId: ACTOR, dryRun: false });
  } finally {
    real.release();
  }

  assert.equal(r.counts.assigned, 2);
  assert.equal(pick(r.skipped, c2).reason, 'write_error');
  // #1 and #3 persisted:
  assert.equal((await dbOrder(c1)).doctor_id, doc);
  assert.equal((await dbOrder(c3)).doctor_id, doc);
  assert.equal(await assignCount(c1), 1);
  assert.equal(await assignCount(c3), 1);
  // #2 fully rolled back:
  assert.equal((await dbOrder(c2)).doctor_id, null);
  assert.equal((await dbOrder(c2)).status, 'paid');
  assert.equal(await assignCount(c2), 0);
});

// ── atomicity #2: a fault at COMMIT rolls back the WHOLE batch ─────────────────
test('atomicity: a fault at COMMIT rolls back the entire batch — nothing persists', async () => {
  const spec = await mkSpec();
  await mkDoctor(spec, { name: 'Batch Doc' });
  const c1 = await mkCase(spec, { ageMin: 20 });
  const c2 = await mkCase(spec, { ageMin: 10 });

  const real = await pool.connect();
  const proxy = faultClient(real, (sql) => typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT');

  await assert.rejects(
    () => bulkAutoAssign(proxy, { caseIds: [c1, c2], actorId: ACTOR, dryRun: false }),
    /injected fault/
  );
  real.release();

  // Whole batch rolled back:
  assert.equal((await dbOrder(c1)).doctor_id, null);
  assert.equal((await dbOrder(c2)).doctor_id, null);
  assert.equal(await assignCount(c1), 0);
  assert.equal(await assignCount(c2), 0);
});
