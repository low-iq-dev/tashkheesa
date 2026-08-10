'use strict';

// Bulk welcome-to-passwordless — Package 2 (Task 30). Hermetic suite on a REAL
// local Postgres (real types, real COMMIT/ROLLBACK; not mocks). Modeled on
// admin_doctor_invite.test.js. Covers the service loop only (notifications are
// the route's post-commit concern, exercised here via the onInvited callback):
//   - selects role='doctor' AND is_active=true AND password_hash IS NULL only
//   - two password-less active doctors each get exactly ONE live (unused) token
//   - a password-HOLDER is excluded (password_hash IS NULL), no token
//   - an INACTIVE password-less doctor is excluded (is_active), no token
//   - re-running within the cooldown does NOT double-send (skipped → still 1 token)
//   - returns { sent, skipped, failed } with matching id arrays
//
// ISOLATION: each test uses its OWN group tag, so its idPrefix (doc-<SUFFIX>-<g>-)
// is disjoint from every other test's fixtures. The bulk SELECT is scoped by that
// prefix, so cross-test rows can never pollute a test's sent/skipped accounting.
//
// Run: node --test tests/admin/admin_doctor_bulk_invite.test.js
//   (uses the hardcoded localhost default below unless DATABASE_URL is set)

// Load .env FIRST — the service requires ../pg, whose pool reads DATABASE_URL +
// PG_SSL at module-load (src/pg.js:50-52, ssl defaults ON unless PG_SSL='false').
// In the full suite a sibling test's dotenv already populated process.env; this
// makes an isolated `node --test` run self-sufficient too. Harmless no-op if the
// env is already set (dotenv never overwrites existing vars).
try { require('dotenv').config(); } catch (_) {}

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { bulkWelcomePasswordlessDoctors } = require('../../src/services/admin_doctor_bulk_invite');

const SUFFIX = 'bwi-' + process.pid + '-' + Date.now();
const ACTOR = 'superadmin-' + SUFFIX;
const BASE_URL = 'https://portal.test';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa',
  ssl: String(process.env.PG_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});
function q(sql, params) { return pool.query(sql, params); }

let seq = 0;
function groupPrefix(group) { return 'doc-' + SUFFIX + '-' + group + '-'; }

// Seed a doctor. hasPw=true sets password_hash (→ excluded by password_hash IS
// NULL). active=false seeds inactive (→ excluded by is_active). invitedAt
// pre-stamps welcome_email_last_sent_at so the cooldown path can be exercised.
async function mkDoctor(group, { active = true, role = 'doctor', hasPw = false, invitedAt = null, name = 'Dr. Sarah Test', lang = 'en' } = {}) {
  const id = groupPrefix(group) + (seq++);
  await q(
    `INSERT INTO users (id, role, is_active, pending_approval, password_hash, name, lang, welcome_email_last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, role, active, !active, hasPw ? 'x-bcrypt-hash' : null, name, lang, invitedAt]
  );
  return id;
}

async function liveTokenCount(userId) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return Number(r.rows[0].n) || 0;
}

async function runBulk(group, opts = {}) {
  const client = await pool.connect();
  try {
    return await bulkWelcomePasswordlessDoctors(client, {
      actorId: ACTOR, baseUrl: BASE_URL, idPrefix: groupPrefix(group), ...opts,
    });
  } finally {
    client.release();
  }
}

test.after(async () => {
  await q(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await q(`DELETE FROM error_logs WHERE user_id = $1`, [ACTOR]);
  await q(`DELETE FROM users WHERE id LIKE $1`, ['doc-' + SUFFIX + '-%']);
  await pool.end();
});

test('bulk: two passwordless active doctors each get one live token; holder + inactive excluded', async () => {
  const a = await mkDoctor('t1', { active: true, hasPw: false });
  const b = await mkDoctor('t1', { active: true, hasPw: false });
  const holder = await mkDoctor('t1', { active: true, hasPw: true });      // has a password → not selected
  const inactive = await mkDoctor('t1', { active: false, hasPw: false });  // inactive → not selected

  const collected = [];
  const res = await runBulk('t1', { onInvited: (id, payload) => collected.push({ id, payload }) });

  assert.equal(res.sent, 2, 'exactly the two passwordless active doctors invited');
  assert.deepEqual(res.invited.map((x) => x.doctorId).sort(), [a, b].sort());
  assert.equal(res.skipped, 0, 'first run of never-invited doctors: nobody in cooldown, no double-count of the just-sent');
  assert.equal(res.failed, 0, 'no failures');
  assert.equal(await liveTokenCount(a), 1, 'doctor a has one live token');
  assert.equal(await liveTokenCount(b), 1, 'doctor b has one live token');
  assert.equal(await liveTokenCount(holder), 0, 'password holder untouched (excluded by password_hash IS NULL)');
  assert.equal(await liveTokenCount(inactive), 0, 'inactive doctor untouched (excluded by is_active)');

  // onInvited fired once per committed invite, carrying the welcome payload
  assert.equal(collected.length, 2, 'onInvited fired per committed invite');
  assert.ok(collected[0].payload.magicLinkUrl, 'payload carries a magic link');
});

test('bulk: re-running within cooldown does not double-send (skipped → still one token each)', async () => {
  const a = await mkDoctor('t2', { active: true, hasPw: false });

  const first = await runBulk('t2');
  assert.equal(first.sent, 1);
  assert.equal(first.skipped, 0, 'first run: nobody in cooldown yet');
  assert.equal(await liveTokenCount(a), 1);

  // Immediate re-run: welcome_email_last_sent_at is fresh → cooldown skip.
  const second = await runBulk('t2');
  assert.equal(second.sent, 0, 'no second send within cooldown');
  assert.equal(second.skipped, 1, 'the freshly-invited doctor is now cooldown-skipped');
  assert.deepEqual(second.skippedIds, [a]);
  assert.equal(await liveTokenCount(a), 1, 'still exactly one live token (no double-mint)');
});
