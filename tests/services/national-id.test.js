// tests/services/national-id.test.js
//
// DB-touching tests for src/services/national-id.js. Uses pgcrypto's
// pgp_sym_encrypt() to seed a fake doctor row with a known plaintext, then
// calls getDecryptedNationalId() and asserts round-trip equality. Also
// covers the error/null branches (missing key, non-doctor role, missing
// row, NULL encrypted column).
//
// IMPORTANT: This test never reads the real NATIONAL_ID_ENCRYPTION_KEY.
// It sets its own throwaway key into process.env for the duration of the
// run and restores the prior value at teardown, so a real key in .env is
// neither used nor exposed.
//
// Skipped automatically when DATABASE_URL is not set (e.g. CI without a
// PG service), matching the project's "skip rather than crash" pattern.

'use strict';

// Load .env so DATABASE_URL is available when run via `node tests/...`.
// Best-effort — already-set env vars take precedence; missing dotenv is
// not fatal because the script can also run with env passed inline.
try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔐 services/national-id\n');

if (!process.env.DATABASE_URL) {
  t.skip('national-id', 'DATABASE_URL not set');
  return;
}

const TEST_PREFIX = 'test-natid-';
const TEST_KEY = 'unit-test-key-not-for-prod-' + crypto.randomBytes(8).toString('hex');
const PRIOR_KEY = process.env.NATIONAL_ID_ENCRYPTION_KEY;

// Lazy require so we don't initialize the pool when DATABASE_URL is missing.
const { pool, execute } = require('../../src/pg');
const { getDecryptedNationalId } = require('../../src/services/national-id');

function uid(label) {
  return TEST_PREFIX + label + '-' + crypto.randomBytes(4).toString('hex');
}

async function insertEncryptedDoctor(plaintext) {
  const id = uid('doc');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, national_id_encrypted, created_at, is_active)
     VALUES ($1, $2, $3, 'doctor', 'x', pgp_sym_encrypt($4, $5), NOW(), true)`,
    [id, id + '@test.local', 'Test Doctor ' + id.slice(-6), plaintext, TEST_KEY]
  );
  return id;
}

async function insertDoctorWithNoEncryptedId() {
  const id = uid('doc-noid');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active)
     VALUES ($1, $2, $3, 'doctor', 'x', NOW(), true)`,
    [id, id + '@test.local', 'Test Doctor No-ID']
  );
  return id;
}

async function insertNonDoctor() {
  const id = uid('patient');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active)
     VALUES ($1, $2, $3, 'patient', 'x', NOW(), true)`,
    [id, id + '@test.local', 'Test Patient']
  );
  return id;
}

async function cleanup() {
  await execute(`DELETE FROM users WHERE id LIKE $1`, [TEST_PREFIX + '%']);
}

(async function run() {
  try {
    process.env.NATIONAL_ID_ENCRYPTION_KEY = TEST_KEY;

    // ── 1. Happy path: round-trip a known plaintext ──────────────────
    try {
      const plaintext = '29008240101246';
      const id = await insertEncryptedDoctor(plaintext);
      const decrypted = await getDecryptedNationalId(id);
      assert.strictEqual(
        decrypted,
        plaintext,
        'expected round-trip to return ' + plaintext + ', got ' + decrypted
      );
      t.pass('round-trip: pgp_sym_encrypt -> getDecryptedNationalId returns plaintext');
    } catch (e) { t.fail('round-trip', e); }

    // ── 2. Doctor exists but has no encrypted ID ─────────────────────
    try {
      const id = await insertDoctorWithNoEncryptedId();
      const decrypted = await getDecryptedNationalId(id);
      assert.strictEqual(decrypted, null, 'expected null when national_id_encrypted is NULL');
      t.pass('returns null when doctor has no encrypted ID stored');
    } catch (e) { t.fail('null encrypted column', e); }

    // ── 3. No such user ──────────────────────────────────────────────
    try {
      const decrypted = await getDecryptedNationalId('non-existent-' + crypto.randomUUID());
      assert.strictEqual(decrypted, null, 'expected null when user does not exist');
      t.pass('returns null when no user row matches userId');
    } catch (e) { t.fail('non-existent user', e); }

    // ── 4. User exists but is not a doctor → throws ──────────────────
    try {
      const id = await insertNonDoctor();
      let threw = null;
      try { await getDecryptedNationalId(id); } catch (err) { threw = err; }
      assert.ok(threw, 'expected getDecryptedNationalId to throw for non-doctor');
      assert.match(threw.message, /not a doctor/i, 'error message should mention role');
      t.pass('throws when user role is not doctor');
    } catch (e) { t.fail('non-doctor user', e); }

    // ── 5. Missing NATIONAL_ID_ENCRYPTION_KEY → throws ───────────────
    try {
      const saved = process.env.NATIONAL_ID_ENCRYPTION_KEY;
      delete process.env.NATIONAL_ID_ENCRYPTION_KEY;
      let threw = null;
      try { await getDecryptedNationalId('any-id'); } catch (err) { threw = err; }
      process.env.NATIONAL_ID_ENCRYPTION_KEY = saved;
      assert.ok(threw, 'expected throw when env var is missing');
      assert.match(threw.message, /NATIONAL_ID_ENCRYPTION_KEY/, 'error message should name the env var');
      t.pass('throws when NATIONAL_ID_ENCRYPTION_KEY is not set');
    } catch (e) { t.fail('missing env var', e); }

    // ── 6. Wrong key cannot decrypt rows written with TEST_KEY ───────
    // Belt-and-suspenders: confirms pgp_sym_decrypt actually uses the key
    // and isn't returning a constant on this PG build.
    try {
      const id = await insertEncryptedDoctor('11111111111111');
      process.env.NATIONAL_ID_ENCRYPTION_KEY = 'a-completely-different-key';
      let threw = null;
      try { await getDecryptedNationalId(id); } catch (err) { threw = err; }
      process.env.NATIONAL_ID_ENCRYPTION_KEY = TEST_KEY;
      assert.ok(threw, 'expected pg error when decrypting with wrong key');
      t.pass('decryption with wrong key surfaces a wrapped pg error');
    } catch (e) { t.fail('wrong key', e); }
  } finally {
    try { await cleanup(); } catch (_) {}
    if (PRIOR_KEY === undefined) {
      delete process.env.NATIONAL_ID_ENCRYPTION_KEY;
    } else {
      process.env.NATIONAL_ID_ENCRYPTION_KEY = PRIOR_KEY;
    }
    // Close the pool so `node tests/services/national-id.test.js` exits.
    // When run under tests/run.js other test files still need the pool, so
    // only close when running standalone.
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
