'use strict';

// Doctor REJECT (pending → rejected) — slice 3. Hermetic suite on a REAL local
// Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_doctor_approve.test.js. Covers: reject happy with an explicit reason,
// reject happy with no reason (defaults to 'Not approved'), NOT_PENDING /
// DOCTOR_NOT_FOUND rejections (each asserting the row is UNCHANGED), and the
// atomicity proof. The internal notification is post-commit/off-txn and is
// mock-asserted in the route test, NOT here.
//
// Run: node --test tests/admin/admin_doctor_reject.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { setDoctorRejection } = require('../../src/services/admin_doctor_reject');

const SUFFIX = 'dr-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// A pending doctor: pending_approval=true, is_active=false (the state reject
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

async function auditRow(target) {
  const r = await q(
    `SELECT message, context FROM error_logs
      WHERE category = 'admin_audit' AND user_id = $1 AND message = $2 LIMIT 1`,
    [ACTOR, `rejected_doctor: ${target}`]
  );
  return r.rows[0] || null;
}
async function auditCount(target) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM error_logs
      WHERE category = 'admin_audit' AND user_id = $1 AND message = $2`,
    [ACTOR, `rejected_doctor: ${target}`]
  );
  return Number(r.rows[0].n) || 0;
}
// context may come back as text (JSON string) or jsonb (object) depending on the
// column type — parse defensively.
function ctxOf(row) {
  if (!row) return null;
  return typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
}

async function run(opts) {
  const client = await pool.connect();
  try {
    return await setDoctorRejection(client, { actorId: ACTOR, ...opts });
  } finally {
    client.release();
  }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  try {
    await setDoctorRejection(client, { actorId: ACTOR, ...opts });
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

// ─────────────────────────── reject happy ───────────────────────────

test('reject: pending → rejected with an explicit reason; audit carries the reason', async () => {
  const id = await mkDoctor({ pending: true });
  const out = await run({ doctorId: id, reason: 'Credentials could not be verified' });

  assert.equal(out.id, id);
  assert.equal(out.pendingApproval, false);
  assert.equal(out.isActive, false);
  assert.equal(out.rejectionReason, 'Credentials could not be verified');

  const row = await getDoctor(id);
  assert.equal(row.pending_approval, false);
  assert.equal(row.is_active, false);
  assert.equal(row.approved_at, null, 'approved_at cleared');
  assert.equal(row.rejection_reason, 'Credentials could not be verified');

  assert.equal(await auditCount(id), 1, 'one audit row');
  const ctx = ctxOf(await auditRow(id));
  assert.equal(ctx.action, 'rejected_doctor');
  assert.equal(ctx.target, id);
  assert.equal(ctx.reason, 'Credentials could not be verified', 'reason captured in audit context');
});

test("reject: no reason supplied → rejection_reason defaults to 'Not approved'", async () => {
  const id = await mkDoctor({ pending: true });
  const out = await run({ doctorId: id }); // reason omitted → service receives undefined

  assert.equal(out.rejectionReason, 'Not approved');
  const row = await getDoctor(id);
  assert.equal(row.rejection_reason, 'Not approved');
  const ctx = ctxOf(await auditRow(id));
  assert.equal(ctx.reason, 'Not approved');
});

// ─────────────────────────── rejections (no partial write) ───────────────────────────

test('reject an already-approved doctor → NOT_PENDING, row unchanged', async () => {
  const id = await mkDoctor({ pending: false });
  const before = await getDoctor(id);
  const err = await expectReject({ doctorId: id, reason: 'x' }, 'NOT_PENDING');
  assert.equal(err.http, 409);
  const after = await getDoctor(id);
  assert.deepEqual(
    { p: after.pending_approval, a: after.is_active, r: after.rejection_reason },
    { p: before.pending_approval, a: before.is_active, r: before.rejection_reason },
    'flags + reason unchanged'
  );
  assert.equal(await auditCount(id), 0, 'no audit row written');
});

test('reject a non-existent id → DOCTOR_NOT_FOUND (404)', async () => {
  const err = await expectReject({ doctorId: 'no-such-' + SUFFIX, reason: 'x' }, 'DOCTOR_NOT_FOUND');
  assert.equal(err.http, 404);
});

test('reject a non-doctor (role=patient) → DOCTOR_NOT_FOUND, row unchanged', async () => {
  const id = await mkDoctor({ pending: true, role: 'patient' });
  await expectReject({ doctorId: id, reason: 'x' }, 'DOCTOR_NOT_FOUND');
  const row = await getDoctor(id);
  assert.equal(row.pending_approval, true, 'patient row untouched');
  assert.equal(row.is_active, false);
  assert.equal(row.rejection_reason, null);
});

// ─────────────────────────── atomicity proof ───────────────────────────

test('atomicity: failure on the audit insert rolls back the reject', async () => {
  const id = await mkDoctor({ pending: true });
  const real = await pool.connect();
  let threw = false;
  try {
    // Throw on the error_logs (audit) insert — which runs AFTER the UPDATE.
    await setDoctorRejection(throwingClient(real, /error_logs/i), { doctorId: id, reason: 'x', actorId: ACTOR });
  } catch (_) {
    threw = true;
  } finally {
    real.release();
  }
  assert.equal(threw, true, 'the injected failure propagated');

  // The UPDATE must have rolled back — still pending/inactive, no reason, no audit.
  const row = await getDoctor(id);
  assert.equal(row.pending_approval, true, 'pending_approval rolled back to true');
  assert.equal(row.is_active, false, 'is_active rolled back to false');
  assert.equal(row.rejection_reason, null, 'rejection_reason rolled back');
  assert.equal(await auditCount(id), 0, 'no audit row persisted');
});
