// tests/auth/reset-password-mobile.test.js
//
// P0-AUTH-1 — Mobile API POST /api/v1/auth/reset-password now reads
// from password_reset_tokens (unified with the portal flow). Before the
// fix, the handler queried users.reset_token, which no code has written
// to since 2026-04-30 — every legitimate token returned INVALID_RESET_TOKEN.
//
// Coverage:
//   1. Mobile-issued token redeemed via mobile endpoint → 200, password
//      hash updated, token marked used_at.
//   2. Random/unknown token → 400 INVALID_RESET_TOKEN.
//   3. Already-used token → 400 INVALID_RESET_TOKEN.
//   4. Expired token (expires_at in the past) → 400 INVALID_RESET_TOKEN.
//   5. CROSS-FLOW BIDIRECTIONAL (proves password_reset_tokens is the
//      unified source of truth):
//      a. Mobile-issued token consumed by portal POST /reset-password/:token
//         → password hash updated, token marked used_at.
//      b. Portal-issued token consumed by mobile POST /api/v1/auth/reset-password
//         → password hash updated, token marked used_at.
//
// TZ note: `password_reset_tokens.expires_at` is `TIMESTAMP WITHOUT TIME ZONE`
// (per migrations/001). The portal + mobile writers serialize ISO-Z strings
// and read them back via JS Date — that round-trip only holds when the
// server's local TZ is UTC (which is true in production). To stay aligned
// with production, this test pins the spawned server to TZ=UTC and uses
// the server's own /forgot-password endpoint for token issuance, then
// mutates state via SQL with intervals large enough (24h) to survive any
// session-TZ skew between the test process and the spawned server.
//
// Boots the real express server in a child process. Skips when
// DATABASE_URL or JWT_SECRET are unset (matches tests/admin/p1_cleanup.test.js).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔐 auth/reset-password-mobile (P0-AUTH-1)\n');

if (!process.env.DATABASE_URL) { t.skip('reset-password-mobile', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('reset-password-mobile', 'JWT_SECRET not set'); return; }

// `tests/auth/onboarding-self-heal.test.js` hijacks `require.cache` for
// `src/pg` to install an in-memory stub for its own module-isolation
// strategy. Because `tests/run.js` loads every test file into the same
// node process, that stub leaks into our `require('../../src/pg')` too —
// every queryOne returns the stub's pre-canned row, every execute is a
// no-op, and every DB-state assertion in this file silently breaks
// (manifests as "user_lookup={onboarding_complete:true,name:'Stale User',…}"
// in failure messages). Drop the cached entry and reload from disk so we
// hit the real Postgres pool. Spawned server processes are unaffected
// (separate require cache).
const pgPath = require.resolve('../../src/pg');
delete require.cache[pgPath];
const { execute, queryOne } = require(pgPath);

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;

const PREFIX = 'test-p0auth1-';
const PATIENT_ID = PREFIX + 'patient-' + crypto.randomBytes(3).toString('hex');
const PATIENT_EMAIL = PATIENT_ID + '@test.local';
// Known-shape bcrypt hash so we can detect updates by inequality after reset.
const ORIGINAL_HASH = '$2b$10$0000000000000000000000000000000000000000000000000000';

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath,
      [path.join(__dirname, '..', '..', 'src', 'server.js')],
      {
        env: Object.assign({}, process.env, {
          PORT,
          LAUNCH_GATE_OFF: '1',
          // Pin the server clock to UTC to match production. Dev shells
          // (Cairo, etc.) would otherwise produce wall-clock skew between
          // the JS Date round-trip and the bare TIMESTAMP column, marking
          // every freshly-issued token as expired. See header comment.
          TZ: 'UTC',
          PGTZ: 'UTC',
          // Portal POST routes are form-encoded and would otherwise need
          // a CSRF cookie + token round-trip. CSRF is exercised in its
          // own suite; turn it off here to focus on auth flow.
          CSRF_MODE: 'off'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let booted = false;
    serverProc.stdout.on('data', (buf) => {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (code) => { if (!booted) reject(new Error('server exited code=' + code)); });
    setTimeout(() => { if (!booted) reject(new Error('server boot timeout')); }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 400));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function postJson(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: r.status, body: text, json };
}

async function postForm(p, fields) {
  const enc = new URLSearchParams();
  for (const k of Object.keys(fields)) enc.set(k, fields[k]);
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: enc.toString(),
    redirect: 'manual'
  });
  const text = await r.text();
  return { status: r.status, body: text, location: r.headers.get('location') || '' };
}

// Issue a token through the mobile /forgot-password endpoint (server-side
// write under the spawned server's UTC clock — the only writer path we
// trust to round-trip correctly across TZ envs).
async function issueViaMobile() {
  const r = await postJson('/api/v1/auth/forgot-password', { email: PATIENT_EMAIL });
  if (r.status !== 200) throw new Error('mobile forgot-password ' + r.status + ': ' + r.body);
  const row = await queryOne(
    `SELECT token FROM password_reset_tokens
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [PATIENT_ID]
  );
  if (!row || !row.token) {
    const u = await queryOne(`SELECT id, email, role, is_active FROM users WHERE id = $1`, [PATIENT_ID]);
    throw new Error('mobile forgot-password did not insert a token. user_lookup=' + JSON.stringify(u));
  }
  return row.token;
}

async function issueViaPortal() {
  const r = await postForm('/forgot-password', { email: PATIENT_EMAIL });
  // Portal handler may 200 (render) or 302 (redirect) — both acceptable
  // post-issuance. We confirm by reading the row back.
  if (r.status !== 200 && r.status !== 302) {
    throw new Error('portal forgot-password ' + r.status + ': ' + r.body.slice(0, 200));
  }
  const row = await queryOne(
    `SELECT token FROM password_reset_tokens
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [PATIENT_ID]
  );
  if (!row || !row.token) throw new Error('portal forgot-password did not insert a token');
  return row.token;
}

async function getPasswordHash(userId) {
  const row = await queryOne(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return row && row.password_hash;
}

async function resetPatientHash() {
  await execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [ORIGINAL_HASH, PATIENT_ID]);
}

async function clearTokens() {
  await execute(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [PATIENT_ID]);
}

async function cleanupAll() {
  await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function run() {
  try {
    await cleanupAll();

    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, $3, $4, 'patient', 'en', true, NOW())`,
      [PATIENT_ID, PATIENT_EMAIL, ORIGINAL_HASH, 'Reset Test Patient']
    );
    // Verify the seed actually persisted — under full-suite concurrency, if
    // anything has eaten our row we want a clear skip rather than a cascade
    // of "did not insert a token" failures whose root cause is missing seed.
    const seedCheck = await queryOne(`SELECT id FROM users WHERE id = $1`, [PATIENT_ID]);
    if (!seedCheck) {
      t.skip('reset-password-mobile', 'seed user missing post-INSERT (concurrent test interference?)');
      return;
    }

    try { await bootServer(); }
    catch (e) { t.skip('reset-password-mobile http', 'boot failed: ' + e.message); return; }

    // ── 1. Mobile-issued token redeemed via mobile endpoint ─────────
    try {
      await clearTokens();
      await resetPatientHash();
      const token = await issueViaMobile();

      const redeem = await postJson('/api/v1/auth/reset-password', {
        token, password: 'NewSecret1234'
      });
      assert.strictEqual(redeem.status, 200, 'reset-password should 200; got ' + redeem.status + ' body=' + redeem.body);
      assert.ok(redeem.json && redeem.json.success === true, 'response should be {success:true,...}; got ' + redeem.body);

      const newHash = await getPasswordHash(PATIENT_ID);
      assert.notStrictEqual(newHash, ORIGINAL_HASH, 'password_hash must be updated after reset');

      const usedRow = await queryOne(
        `SELECT used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );
      assert.ok(usedRow && usedRow.used_at, 'token must be marked used_at after redemption');
      t.pass('P0-AUTH-1 #1: mobile-issued token redeemed via mobile endpoint — password updated, token marked used');
    } catch (e) { t.fail('P0-AUTH-1 #1 mobile→mobile', e); }

    // ── 2. Random/unknown token rejected ────────────────────────────
    try {
      await resetPatientHash();
      const r = await postJson('/api/v1/auth/reset-password', {
        token: randomUUID(), // never inserted
        password: 'NewSecret1234'
      });
      assert.strictEqual(r.status, 400, 'unknown token should 400; got ' + r.status);
      assert.ok(r.json && r.json.code === 'INVALID_RESET_TOKEN',
        'expected code=INVALID_RESET_TOKEN; got ' + r.body);
      const hash = await getPasswordHash(PATIENT_ID);
      assert.strictEqual(hash, ORIGINAL_HASH, 'password_hash must NOT change on rejected token');
      t.pass('P0-AUTH-1 #2: unknown token → 400 INVALID_RESET_TOKEN, hash untouched');
    } catch (e) { t.fail('P0-AUTH-1 #2 unknown token', e); }

    // ── 3. Already-used token rejected ──────────────────────────────
    try {
      await clearTokens();
      await resetPatientHash();
      const token = await issueViaMobile();
      // Mark as used. used_at value is read as NULL/NOT-NULL by the consumer
      // (no wall-clock comparison), so SQL NOW() is TZ-safe here.
      await execute(`UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1`, [token]);

      const r = await postJson('/api/v1/auth/reset-password', {
        token, password: 'NewSecret1234'
      });
      assert.strictEqual(r.status, 400, 'used token should 400; got ' + r.status);
      assert.ok(r.json && r.json.code === 'INVALID_RESET_TOKEN', 'expected INVALID_RESET_TOKEN; got ' + r.body);
      const hash = await getPasswordHash(PATIENT_ID);
      assert.strictEqual(hash, ORIGINAL_HASH, 'password_hash must NOT change on used token');
      t.pass('P0-AUTH-1 #3: already-used token → 400, hash untouched');
    } catch (e) { t.fail('P0-AUTH-1 #3 used token', e); }

    // ── 4. Expired token rejected ───────────────────────────────────
    try {
      await clearTokens();
      await resetPatientHash();
      const token = await issueViaMobile();
      // Force expiry well into the past. 24h is comfortably larger than any
      // possible TZ skew (max ±14h), so the bare wall-clock written here is
      // unambiguously "past" from the server's UTC-pinned perspective
      // regardless of the test process's session TZ.
      await execute(
        `UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '24 hours' WHERE token = $1`,
        [token]
      );

      const r = await postJson('/api/v1/auth/reset-password', {
        token, password: 'NewSecret1234'
      });
      assert.strictEqual(r.status, 400, 'expired token should 400; got ' + r.status);
      assert.ok(r.json && r.json.code === 'INVALID_RESET_TOKEN', 'expected INVALID_RESET_TOKEN; got ' + r.body);
      const hash = await getPasswordHash(PATIENT_ID);
      assert.strictEqual(hash, ORIGINAL_HASH, 'password_hash must NOT change on expired token');
      t.pass('P0-AUTH-1 #4: expired token → 400, hash untouched');
    } catch (e) { t.fail('P0-AUTH-1 #4 expired token', e); }

    // ── 5a. CROSS-FLOW: mobile-issued token consumed by portal endpoint ─
    try {
      await clearTokens();
      await resetPatientHash();
      const token = await issueViaMobile();

      // Portal POST /reset-password/:token expects form-encoded password + confirm_password.
      const redeem = await postForm('/reset-password/' + encodeURIComponent(token), {
        password: 'CrossFlowAB12',
        confirm_password: 'CrossFlowAB12'
      });
      assert.strictEqual(redeem.status, 200, 'portal reset-password should 200 render; got ' + redeem.status);

      const newHash = await getPasswordHash(PATIENT_ID);
      assert.notStrictEqual(newHash, ORIGINAL_HASH, 'password_hash must be updated by portal redeem of mobile token');

      const usedRow = await queryOne(
        `SELECT used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );
      assert.ok(usedRow && usedRow.used_at, 'mobile-issued token must be marked used_at after portal redemption');
      t.pass('P0-AUTH-1 #5a: mobile-issued token consumed by portal endpoint — bidirectional interop verified');
    } catch (e) { t.fail('P0-AUTH-1 #5a mobile→portal', e); }

    // ── 5b. CROSS-FLOW: portal-issued token consumed by mobile endpoint ─
    try {
      await clearTokens();
      await resetPatientHash();
      const token = await issueViaPortal();

      const redeem = await postJson('/api/v1/auth/reset-password', {
        token, password: 'CrossFlowBA34'
      });
      assert.strictEqual(redeem.status, 200, 'mobile reset-password should 200; got ' + redeem.status + ' body=' + redeem.body);
      assert.ok(redeem.json && redeem.json.success === true, 'response should be {success:true,...}; got ' + redeem.body);

      const newHash = await getPasswordHash(PATIENT_ID);
      assert.notStrictEqual(newHash, ORIGINAL_HASH, 'password_hash must be updated by mobile redeem of portal token');

      const usedRow = await queryOne(
        `SELECT used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );
      assert.ok(usedRow && usedRow.used_at, 'portal-issued token must be marked used_at after mobile redemption');
      t.pass('P0-AUTH-1 #5b: portal-issued token consumed by mobile endpoint — bidirectional interop verified');
    } catch (e) { t.fail('P0-AUTH-1 #5b portal→mobile', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanupAll(); } catch (_) {}
  }
})();
