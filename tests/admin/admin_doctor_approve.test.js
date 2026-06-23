'use strict';

// Doctor approve (pending → active) — slice 2a, SILENT. Hermetic suite on a REAL
// local Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_doctor_pause.test.js. Covers: approve happy, NOT_PENDING / DOCTOR_NOT_FOUND
// rejections (each asserting the row is UNCHANGED), the atomicity proof, and that
// the write is SILENT (no password_reset_tokens row, no notifications row).
//
// Run: node --test tests/admin/admin_doctor_approve.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setDoctorApproval } = require('../../src/services/admin_doctor_approve');

const SUFFIX = 'da-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A pending doctor: pending_approval=true, is_active=false (the state approve
// transitions FROM). `pending:false` seeds an already-approved doctor for the
// NOT_PENDING reject. users only requires `id` (everything else defaulted).
async function mkDoctor({ pending = true, role = 'doctor' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, pending_approval, approved_at, approved_by, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, role, !pending, pending, pending ? null : new Date().toISOString(), pending ? null : 'seed', null]
  );
  return id;
}

async function getDoctor(id) {
  return (await q(
    `SELECT id, role, is_active, pending_approval, approved_at, approved_by, rejection_reason FROM users WHERE id = $1`,
    [id]
  )).rows[0];
}

async function auditCount(target) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM error_logs
      WHERE category = 'admin_audit' AND user_id = $1 AND message = $2`,
    [ACTOR, `approved_doctor: ${target}`]
  );
  return Number(r.rows[0].n) || 0;
}

async function tokenCount(userId) {
  const r = await q(`SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`, [userId]);
  return Number(r.rows[0].n) || 0;
}
async function notifCount(userId) {
  const r = await q(`SELECT COUNT(*)::int AS n FROM notifications WHERE to_user_id = $1`, [userId]);
  return Number(r.rows[0].n) || 0;
}

async function run(opts) {
  const client = await pool.connect();
  try {
    return await setDoctorApproval(client, { actorId: ACTOR, ...opts });
  } finally {
    client.release();
  }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  try {
    await setDoctorApproval(client, { actorId: ACTOR, ...opts });
    throw new Error(`expected ${code} but call resolved`);
  } catch (err) {
    if (err.code !== code) throw err;
    return err;
  } finally {
    client.release();
  }
}

// Proxy pg client that delegates to a real client but throws on the first query
// whose SQL matches `throwOn` — injects a mid-write failure.
function throwingClient(real, throwOn) {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql, params) => {
          if (typeof sql === 'string' && throwOn.test(sql)) return Promise.reject(new Error('injected failure'));
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

// ─────────────────────────── approve happy ───────────────────────────

test('approve: pending → active, stamps approved_at + approved_by, audit; SILENT', async () => {
  const id = await mkDoctor({ pending: true });
  const out = await run({ doctorId: id });

  assert.equal(out.id, id);
  assert.equal(out.pendingApproval, false);
  assert.equal(out.isActive, true);
  assert.ok(out.approvedAt, 'approvedAt set (ISO)');
  assert.equal(out.approvedBy, ACTOR);

  const row = await getDoctor(id);
  assert.equal(row.pending_approval, false);
  assert.equal(row.is_active, true);
  assert.ok(row.approved_at, 'approved_at stored');
  assert.equal(row.approved_by, ACTOR);
  assert.equal(row.rejection_reason, null);
  assert.equal(await auditCount(id), 1, 'one audit row');

  // SILENT: no token, no notification side-effects.
  assert.equal(await tokenCount(id), 0, 'no password_reset_tokens row created');
  assert.equal(await notifCount(id), 0, 'no notifications row created');
});

// ─────────────────────────── rejections (no partial write) ───────────────────────────

test('approve an already-approved doctor → NOT_PENDING, row unchanged', async () => {
  const id = await mkDoctor({ pending: false });
  const before = await getDoctor(id);
  await expectReject({ doctorId: id }, 'NOT_PENDING');
  const after = await getDoctor(id);
  assert.deepEqual(
    { p: after.pending_approval, a: after.is_active, by: after.approved_by },
    { p: before.pending_approval, a: before.is_active, by: before.approved_by },
    'flags unchanged'
  );
  assert.equal(await auditCount(id), 0, 'no audit row written');
});

test('approve a non-existent id → DOCTOR_NOT_FOUND', async () => {
  await expectReject({ doctorId: 'no-such-' + SUFFIX }, 'DOCTOR_NOT_FOUND');
});

test('approve a non-doctor (role=patient) → DOCTOR_NOT_FOUND, row unchanged', async () => {
  const id = await mkDoctor({ pending: true, role: 'patient' });
  await expectReject({ doctorId: id }, 'DOCTOR_NOT_FOUND');
  const row = await getDoctor(id);
  assert.equal(row.pending_approval, true, 'patient row untouched');
  assert.equal(row.is_active, false);
});

// ─────────────────────────── atomicity proof ───────────────────────────

test('atomicity: failure on the audit insert rolls back the approve', async () => {
  const id = await mkDoctor({ pending: true });
  const real = await pool.connect();
  let threw = false;
  try {
    // Throw on the error_logs (audit) insert — which runs AFTER the UPDATE.
    await setDoctorApproval(throwingClient(real, /error_logs/i), { doctorId: id, actorId: ACTOR });
  } catch (_) {
    threw = true;
  } finally {
    real.release();
  }
  assert.equal(threw, true, 'the injected failure propagated');

  // The UPDATE must have rolled back — still pending/inactive, no audit row.
  const row = await getDoctor(id);
  assert.equal(row.pending_approval, true, 'pending_approval rolled back to true');
  assert.equal(row.is_active, false, 'is_active rolled back to false');
  assert.equal(row.approved_at, null, 'approved_at rolled back');
  assert.equal(row.approved_by, null, 'approved_by rolled back');
  assert.equal(await auditCount(id), 0, 'no audit row persisted');
});
