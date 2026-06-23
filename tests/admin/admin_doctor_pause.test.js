'use strict';

// Doctor pause / reactivate — hermetic suite on a REAL local Postgres (real
// types, real COMMIT/ROLLBACK; NOT mocks — mocks can't catch SQL/type bugs).
// Modeled on admin_refund.test.js. The FIRST mutating writes in the Command app,
// so: pause happy, reactivate happy, every rejection (each asserting the row's
// pause flags are UNCHANGED — no partial write), and the atomicity proof
// (failure on the audit insert → whole txn rolls back).
//
// Run: node --test tests/admin/admin_doctor_pause.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setDoctorPause } = require('../../src/services/admin_doctor_pause');

const SUFFIX = 'dp-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A doctor row. `paused:true` seeds the three pause columns so the "unchanged"
// assertions can verify they're preserved on reject / cleared on reactivate.
// users only requires `id` (everything else nullable/defaulted).
async function mkDoctor({ paused = false, role = 'doctor' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, is_paused, paused_at, pause_reason)
       VALUES ($1, $2, true, $3, $4, $5)`,
    [id, role, paused, paused ? new Date().toISOString() : null, paused ? 'seed:already-paused' : null]
  );
  return id;
}

async function getDoctor(id) {
  return (await q(`SELECT id, role, is_paused, paused_at, pause_reason FROM users WHERE id = $1`, [id])).rows[0];
}

async function auditCount(action, target) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM error_logs
      WHERE category = 'admin_audit' AND user_id = $1 AND message = $2`,
    [ACTOR, `${action}: ${target}`]
  );
  return Number(r.rows[0].n) || 0;
}

async function run(opts) {
  const client = await pool.connect();
  try {
    return await setDoctorPause(client, { actorId: ACTOR, ...opts });
  } finally {
    client.release();
  }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  try {
    await setDoctorPause(client, { actorId: ACTOR, ...opts });
    throw new Error(`expected ${code} but call resolved`);
  } catch (err) {
    if (err.code !== code) throw err;
    return err;
  } finally {
    client.release();
  }
}

// Proxy pg client that delegates to a real client but throws on the first query
// whose SQL matches `throwOn` — used to inject a mid-write failure.
function throwingClient(real, throwOn) {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql, params) => {
          if (typeof sql === 'string' && throwOn.test(sql)) {
            return Promise.reject(new Error('injected failure'));
          }
          return target.query(sql, params);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test.after(async () => {
  await q(`DELETE FROM error_logs WHERE user_id = $1`, [ACTOR]);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

// ─────────────────────────── pause happy ───────────────────────────

test('pause: flips is_paused, stamps paused_at + reason, writes audit', async () => {
  const id = await mkDoctor({ paused: false });
  const out = await run({ doctorId: id, paused: true, reason: 'manual: under review' });

  assert.equal(out.id, id);
  assert.equal(out.isPaused, true);
  assert.ok(out.pausedAt, 'pausedAt set (ISO)');
  assert.equal(out.pauseReason, 'manual: under review');

  const row = await getDoctor(id);
  assert.equal(row.is_paused, true);
  assert.ok(row.paused_at, 'paused_at stored');
  assert.equal(row.pause_reason, 'manual: under review');
  assert.equal(await auditCount('paused_doctor', id), 1, 'one audit row');
});

// ─────────────────────────── reactivate happy ───────────────────────────

test('reactivate: clears all three pause columns, writes audit', async () => {
  const id = await mkDoctor({ paused: true });
  const out = await run({ doctorId: id, paused: false });

  assert.equal(out.isPaused, false);
  assert.equal(out.pausedAt, null);
  assert.equal(out.pauseReason, null);

  const row = await getDoctor(id);
  assert.equal(row.is_paused, false);
  assert.equal(row.paused_at, null);
  assert.equal(row.pause_reason, null);
  assert.equal(await auditCount('reactivated_doctor', id), 1, 'one audit row');
});

// ─────────────────────────── rejections (no partial write) ───────────────────────────

test('pause when already paused → ALREADY_PAUSED, row unchanged', async () => {
  const id = await mkDoctor({ paused: true });
  const before = await getDoctor(id);
  await expectReject({ doctorId: id, paused: true, reason: 'again' }, 'ALREADY_PAUSED');
  const after = await getDoctor(id);
  assert.deepEqual(
    { p: after.is_paused, at: after.paused_at, r: after.pause_reason },
    { p: before.is_paused, at: before.paused_at, r: before.pause_reason },
    'flags unchanged'
  );
  assert.equal(await auditCount('paused_doctor', id), 0, 'no audit row written');
});

test('reactivate when not paused → NOT_PAUSED, row unchanged', async () => {
  const id = await mkDoctor({ paused: false });
  await expectReject({ doctorId: id, paused: false }, 'NOT_PAUSED');
  const row = await getDoctor(id);
  assert.equal(row.is_paused, false);
  assert.equal(row.paused_at, null);
  assert.equal(await auditCount('reactivated_doctor', id), 0, 'no audit row written');
});

test('pause a non-existent id → DOCTOR_NOT_FOUND', async () => {
  await expectReject({ doctorId: 'no-such-' + SUFFIX, paused: true, reason: 'x' }, 'DOCTOR_NOT_FOUND');
});

test('pause a non-doctor (role=patient) → DOCTOR_NOT_FOUND, row unchanged', async () => {
  const id = await mkDoctor({ paused: false, role: 'patient' });
  await expectReject({ doctorId: id, paused: true, reason: 'x' }, 'DOCTOR_NOT_FOUND');
  const row = await getDoctor(id);
  assert.equal(row.is_paused, false, 'patient row untouched');
});

// ─────────────────────────── atomicity proof ───────────────────────────

test('atomicity: failure on the audit insert rolls back the flag write', async () => {
  const id = await mkDoctor({ paused: false });
  const real = await pool.connect();
  let threw = false;
  try {
    // Throw on the error_logs (audit) insert — which runs AFTER the UPDATE.
    await setDoctorPause(throwingClient(real, /error_logs/i), {
      doctorId: id, paused: true, reason: 'manual: atomicity', actorId: ACTOR,
    });
  } catch (_) {
    threw = true;
  } finally {
    real.release();
  }
  assert.equal(threw, true, 'the injected failure propagated');

  // The UPDATE must have rolled back — doctor still unpaused, no audit row.
  const row = await getDoctor(id);
  assert.equal(row.is_paused, false, 'is_paused rolled back to false');
  assert.equal(row.paused_at, null, 'paused_at rolled back');
  assert.equal(row.pause_reason, null, 'pause_reason rolled back');
  assert.equal(await auditCount('paused_doctor', id), 0, 'no audit row persisted');
});
