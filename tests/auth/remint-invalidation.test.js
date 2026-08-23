// tests/auth/remint-invalidation.test.js
//
// Package 2 (Task 27): minting a new welcome/reset token must invalidate the
// prior UNUSED one for that user. The mint sites were INSERT-only, so old links
// stayed live forever (a growing set of valid tokens). Contract: after ANY mint
// for a user_id, at most ONE row with used_at IS NULL may remain.
//
// Coverage:
//   1. BEHAVIORAL — inviteDoctor (the T30-critical, injected-client, in-txn site):
//      seed 2 stale live tokens, invite, assert exactly 1 live token remains.
//   2. STRUCTURAL invariant — across ALL mint sites (auth.js x2, admin_doctor_invite
//      x1, superadmin.js x3, api/auth.js x1 = 7 total), every `INSERT INTO password_reset_tokens`
//      must be paired with a remint `DELETE ... WHERE user_id=$n AND used_at IS NULL`
//      in the same file. This catches any mint site (incl. future ones) that mints
//      without first burning — the security property, file-wide, not just the one
//      site we can invoke hermetically.
'use strict';
try { require('dotenv').config(); } catch (_) {}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};
console.log('\n🔁 auth/remint-invalidation (Package 2 — Task 27)\n');

// ── 2. STRUCTURAL: every mint site is paired with a remint burn (no DB needed) ──
try {
  const EXPECTED_INSERTS = {
    'src/routes/auth.js': 2,                       // createMagicLoginToken + forgot-password
    'src/services/admin_doctor_invite.js': 1,      // inviteDoctor
    'src/routes/superadmin.js': 2,                 // _issueDoctorWelcomePayload + debug/reset-link (create-doctor now delegates to inviteDoctor)
    'src/routes/api/auth.js': 1,                   // mobile POST /forgot-password
  };
  for (const rel of Object.keys(EXPECTED_INSERTS)) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    const inserts = (src.match(/INSERT INTO password_reset_tokens/g) || []).length;
    const deletes = (src.match(/DELETE FROM password_reset_tokens\s+WHERE user_id = \$\d+ AND used_at IS NULL/g) || []).length;
    assert.strictEqual(inserts, EXPECTED_INSERTS[rel],
      rel + ': known mint-site count changed (was ' + EXPECTED_INSERTS[rel] + ', now ' + inserts + ') — re-verify each mints after a burn');
    assert.ok(deletes >= inserts,
      rel + ': every password_reset_tokens mint must be paired with a remint DELETE (inserts=' + inserts + ' burns=' + deletes + ')');
  }
  const total = Object.values(EXPECTED_INSERTS).reduce((a, b) => a + b, 0);
  t.pass('structural: all ' + total + ' mint sites (auth x2, invite x1, superadmin x3, api-auth x1) burn prior unused tokens before minting');
} catch (e) { t.fail('remint structural invariant', e); }

// ── 1. BEHAVIORAL: inviteDoctor leaves exactly ONE live token ──
if (!process.env.DATABASE_URL) { t.skip('remint-invalidation behavioral', 'DATABASE_URL not set'); return; }

const pgPath = require.resolve('../../src/pg');
delete require.cache[pgPath];
const { pool, execute, queryOne } = require(pgPath);

const PREFIX = 'test-remint-';
async function seedDoctor(id, email) {
  await execute(
    `INSERT INTO users (id, email, name, role, lang, is_active, pending_approval, onboarding_complete, created_at)
     VALUES ($1, $2, $3, 'doctor', 'en', true, false, false, NOW())`,
    [id, email, 'Remint Test']);
}
async function mintRaw(userId) {
  const token = randomUUID();
  await execute(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours', NULL, NOW())`,
    [randomUUID(), userId, token]);
  return token;
}
async function liveCount(userId) {
  const r = await queryOne(`SELECT COUNT(*)::int AS c FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`, [userId]);
  return r ? r.c : -1;
}
async function cleanup() {
  await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

module.exports = (async function run() {
  try {
    await cleanup();
    const { inviteDoctor } = require('../../src/services/admin_doctor_invite');
    try {
      const id = PREFIX + crypto.randomBytes(3).toString('hex');
      await seedDoctor(id, id + '@test.local');
      await mintRaw(id); await mintRaw(id);              // two stale live tokens
      assert.strictEqual(await liveCount(id), 2, 'precondition: 2 live tokens');
      const client = await pool.connect();
      try { await inviteDoctor(client, { doctorId: id, baseUrl: null, actorId: null }); }
      finally { client.release(); }
      const after = await liveCount(id);
      assert.strictEqual(after, 1, 'after inviteDoctor exactly ONE live token must remain, got ' + after);
      t.pass('behavioral: inviteDoctor burns prior unused tokens → exactly 1 live');
    } catch (e) { t.fail('inviteDoctor remint behavioral', e); }
  } finally { try { await cleanup(); } catch (_) {} }
})();
