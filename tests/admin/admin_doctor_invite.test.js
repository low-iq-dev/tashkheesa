'use strict';

// Doctor INVITE / resend-welcome — slice 2b. Hermetic suite on a REAL local
// Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_doctor_approve.test.js. Covers the IN-TXN write only (the notification
// is post-commit/off-txn and is mock-asserted in the route test):
//   - invite happy → token row (7-day expiry, used_at null), welcome stamp,
//     audit 'invited_doctor', payload magicLinkUrl carries the token
//   - DOCTOR_NOT_ACTIVE (pending/inactive doctor) → 409, NO token, NO stamp
//   - DOCTOR_NOT_FOUND (missing id / non-doctor role)
//   - resend ALLOWED → an already-invited ACTIVE doctor succeeds, new token row
//   - atomicity → a fault on the audit insert rolls back token + stamp
//
// Run: node --test tests/admin/admin_doctor_invite.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)
//
// All fixtures carry a per-process SUFFIX; cleaned up in after(). No prod.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { inviteDoctor } = require('../../src/services/admin_doctor_invite');

const SUFFIX = 'di-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;
const BASE_URL = 'https://portal.test';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
const uid = (p) => p + '-' + SUFFIX + '-' + (seq++);

// An ACTIVE doctor: role='doctor', is_active=true (the state /invite requires).
// `active:false` seeds an inactive/pending doctor for the DOCTOR_NOT_ACTIVE
// reject. `invited:true` pre-stamps welcome_email_last_sent_at (the "already
// invited" signal) so the resend path can be exercised. users only requires
// `id` (everything else defaulted).
async function mkDoctor({ active = true, role = 'doctor', invited = false, name = 'Dr. Sarah Test', lang = 'en' } = {}) {
  const id = uid('doc');
  await q(
    `INSERT INTO users (id, role, is_active, pending_approval, name, lang, welcome_email_last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, role, active, !active, name, lang, invited ? '2026-01-01T00:00:00.000Z' : null]
  );
  return id;
}

async function getDoctor(id) {
  return (await q(
    `SELECT id, role, is_active, welcome_email_last_sent_at FROM users WHERE id = $1`,
    [id]
  )).rows[0];
}

// token rows for a user, with a tz-independent TTL: expires_at - created_at are
// both written from the same NOW() in one INSERT, so the diff is EXACTLY the
// configured interval regardless of session timezone.
async function tokenRows(userId) {
  return (await q(
    `SELECT token, used_at, EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl_secs
       FROM password_reset_tokens WHERE user_id = $1`,
    [userId]
  )).rows;
}

async function auditCount(target) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM error_logs
      WHERE category = 'admin_audit' AND user_id = $1 AND message = $2`,
    [ACTOR, `invited_doctor: ${target}`]
  );
  return Number(r.rows[0].n) || 0;
}

async function run(opts) {
  const client = await pool.connect();
  try {
    return await inviteDoctor(client, { actorId: ACTOR, baseUrl: BASE_URL, ...opts });
  } finally {
    client.release();
  }
}

async function expectReject(opts, code) {
  const client = await pool.connect();
  try {
    await inviteDoctor(client, { actorId: ACTOR, baseUrl: BASE_URL, ...opts });
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
  await q(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await q(`DELETE FROM error_logs WHERE user_id = $1`, [ACTOR]);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

// ─────────────────────────── invite happy ───────────────────────────

test('invite: ACTIVE never-invited → token (7-day, unused) + welcome stamp + audit; payload carries the token', async () => {
  const id = await mkDoctor({ active: true, invited: false });
  const out = await run({ doctorId: id });

  // returned payload shape
  assert.ok(out.welcomePayload, 'welcomePayload returned');
  assert.equal(out.welcomePayload.firstName, 'Sarah', 'Dr. prefix stripped, first token');
  assert.equal(out.welcomePayload.doctorName, 'Dr. Sarah Test');
  assert.equal(out.welcomePayload.portalUrl, `${BASE_URL}/portal/doctor/today`);
  assert.equal(out.welcomePayload.expiryDays, 7);
  assert.ok(out.lastInvitedAt, 'lastInvitedAt is an ISO string');

  // exactly one token row, unused, ~7-day TTL
  const rows = await tokenRows(id);
  assert.equal(rows.length, 1, 'one password_reset_tokens row created');
  assert.equal(rows[0].used_at, null, 'token is unused');
  assert.ok(Math.abs(rows[0].ttl_secs - 7 * 24 * 3600) < 5, '~168h expiry');

  // the magic link embeds the freshly-issued token
  assert.equal(out.welcomePayload.magicLinkUrl, `${BASE_URL}/magic-login/${rows[0].token}?lang=en`);
  assert.equal(out.welcomePayload.password_setup_link, out.welcomePayload.magicLinkUrl, 'alias for the template');

  // welcome stamp written; audit row written
  const row = await getDoctor(id);
  assert.ok(row.welcome_email_last_sent_at, 'welcome_email_last_sent_at stamped');
  assert.equal(await auditCount(id), 1, 'one invited_doctor audit row');
});

// ─────────────────────────── DOCTOR_NOT_ACTIVE (no partial write) ───────────────────────────

test('invite an inactive/pending doctor → DOCTOR_NOT_ACTIVE (409), no token, no stamp', async () => {
  const id = await mkDoctor({ active: false, invited: false });
  const err = await expectReject({ doctorId: id }, 'DOCTOR_NOT_ACTIVE');
  assert.equal(err.http, 409);

  assert.equal((await tokenRows(id)).length, 0, 'no token row created');
  const row = await getDoctor(id);
  assert.equal(row.welcome_email_last_sent_at, null, 'no welcome stamp');
  assert.equal(await auditCount(id), 0, 'no audit row');
});

// ─────────────────────────── DOCTOR_NOT_FOUND ───────────────────────────

test('invite a non-existent id → DOCTOR_NOT_FOUND (404)', async () => {
  const err = await expectReject({ doctorId: 'no-such-' + SUFFIX }, 'DOCTOR_NOT_FOUND');
  assert.equal(err.http, 404);
});

test('invite a non-doctor (role=patient) → DOCTOR_NOT_FOUND, row untouched', async () => {
  const id = await mkDoctor({ active: true, role: 'patient' });
  await expectReject({ doctorId: id }, 'DOCTOR_NOT_FOUND');
  assert.equal((await tokenRows(id)).length, 0, 'no token row created');
  const row = await getDoctor(id);
  assert.equal(row.welcome_email_last_sent_at, null, 'patient row untouched');
});

// ─────────────────────────── resend allowed ───────────────────────────

test('invite an ALREADY-invited ACTIVE doctor → succeeds (resend), fresh token, stamp refreshed', async () => {
  const id = await mkDoctor({ active: true, invited: true });
  const before = await getDoctor(id);
  assert.ok(before.welcome_email_last_sent_at, 'seeded as already-invited');

  const out = await run({ doctorId: id });
  assert.ok(out.welcomePayload.magicLinkUrl, 'resend produced a magic link');

  const rows = await tokenRows(id);
  assert.equal(rows.length, 1, 'a fresh token row created on resend');
  assert.equal(rows[0].used_at, null);

  const after = await getDoctor(id);
  assert.ok(
    new Date(after.welcome_email_last_sent_at).getTime() > new Date(before.welcome_email_last_sent_at).getTime(),
    'welcome_email_last_sent_at advanced'
  );
  assert.equal(await auditCount(id), 1, 'resend audited');
});

// ─────────────────────────── atomicity proof ───────────────────────────

test('atomicity: a failure on the audit insert rolls back the token + stamp', async () => {
  const id = await mkDoctor({ active: true, invited: false });
  const real = await pool.connect();
  let threw = false;
  try {
    // Throw on the error_logs (audit) insert — which runs AFTER token + stamp.
    await inviteDoctor(throwingClient(real, /error_logs/i), { doctorId: id, actorId: ACTOR, baseUrl: BASE_URL });
  } catch (_) {
    threw = true;
  } finally {
    real.release();
  }
  assert.equal(threw, true, 'the injected failure propagated');

  // Token + stamp must have rolled back; no audit row.
  assert.equal((await tokenRows(id)).length, 0, 'token INSERT rolled back');
  const row = await getDoctor(id);
  assert.equal(row.welcome_email_last_sent_at, null, 'welcome stamp rolled back');
  assert.equal(await auditCount(id), 0, 'no audit row persisted');
});
