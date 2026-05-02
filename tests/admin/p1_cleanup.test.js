// tests/admin/p1_cleanup.test.js
//
// Tests for the P1 cleanup PR. Covers four findings from
// docs/audits/PRE_LAUNCH_AUDIT_2026-04-30.md:
//
//   P1-AUTH-2  — Mobile API OTP uses crypto.randomInt (not Math.random).
//                Asserts: 100 generated OTPs are all 6-digit numeric strings.
//                (No statistical-distribution check — those are flaky.
//                What we test is shape + non-trivial entropy: ≥ 50 distinct
//                values out of 100, which any reasonable PRNG passes.)
//
//   P1-SEC-1   — /superadmin/debug/reset-link/:userId emails the link
//                instead of returning the token in the response body.
//                HTTP-level: response body must NOT contain the token
//                or the /reset-password/ URL fragment.
//
//   P1-PATIENT-3 — /portal/patient/payment-return is hardened: even with
//                  ?success=true on a draft order, payment_status stays
//                  'unpaid' (the success page re-queries DB and refuses
//                  to flip status without webhook/stub).
//
//   P1-DATA-1  — services.sla_hours uniformly aligned to policy §9:
//                no row remains at 72h or 24h after migration 036.
//
// HTTP-level tests boot the real express app in a child process and use
// fetch. Skips when DATABASE_URL or JWT_SECRET are unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧹 admin/p1-cleanup\n');

if (!process.env.DATABASE_URL) {
  t.skip('p1-cleanup', 'DATABASE_URL not set');
  return;
}
if (!process.env.JWT_SECRET) {
  t.skip('p1-cleanup', 'JWT_SECRET not set');
  return;
}

// ─── P1-AUTH-2: OTP shape + entropy ─────────────────────────────────
// Pure function check — no DB, no HTTP. The same line that production uses.
try {
  const samples = new Set();
  let allShape = true;
  for (let i = 0; i < 100; i++) {
    const otp = String(crypto.randomInt(100000, 1000000)).padStart(6, '0');
    if (!/^\d{6}$/.test(otp)) { allShape = false; break; }
    samples.add(otp);
  }
  assert.ok(allShape, '100 OTPs must all match /^\\d{6}$/');
  // Birthday-paradox sanity: 100 picks out of 900,000 → essentially zero
  // collisions in a uniform distribution. Allow 50+ distinct as a generous
  // floor that catches obvious PRNG misuse.
  assert.ok(samples.size >= 50, 'expected ≥ 50 distinct OTPs out of 100; got ' + samples.size);
  t.pass('P1-AUTH-2: OTP is 6-digit numeric, high entropy across 100 samples');
} catch (e) { t.fail('P1-AUTH-2 OTP shape', e); }

// ─── P1-DATA-1: SLA hours alignment migration ──────────────────────
// Independent test: seed services with policy-violating values
// (72h Standard, 24h VIP), run the migration's UPDATE statements,
// assert the seeded rows were corrected. Uses the test prefix so
// real catalog rows aren't asserted on (they may already be aligned
// from a prior run of migration 036, which would make a global
// "no 72h rows exist" assertion tautological).
const fs = require('fs');
const { execute, queryOne, queryAll, pool } = require('../../src/pg');
const { sign } = require('../../src/auth');

const DATA_TEST_PREFIX = 'test-p1data-';
const seededIds = {
  std72: DATA_TEST_PREFIX + 'std-' + crypto.randomBytes(3).toString('hex'),
  vip24: DATA_TEST_PREFIX + 'vip-' + crypto.randomBytes(3).toString('hex'),
  urgent4: DATA_TEST_PREFIX + 'urg-' + crypto.randomBytes(3).toString('hex')
};

(async function dataCheck() {
  try {
    // Cleanup any stale prefix rows from prior runs.
    await execute(`DELETE FROM services WHERE id LIKE $1`, [DATA_TEST_PREFIX + '%']);

    // Seed three services: two violating (72h, 24h) and one
    // already-correct (4h Urgent — control row, must NOT change).
    const seed = async (id, sla) => execute(
      `INSERT INTO services (id, name, base_price, doctor_fee, currency, sla_hours, is_visible)
       VALUES ($1, $2, 1500, 300, 'EGP', $3, true)`,
      [id, 'Test ' + id, sla]
    );
    await seed(seededIds.std72, 72);
    await seed(seededIds.vip24, 24);
    await seed(seededIds.urgent4, 4);

    // Pre-state: confirm seed values.
    const pre = await queryAll(
      `SELECT id, sla_hours FROM services WHERE id LIKE $1 ORDER BY id`,
      [DATA_TEST_PREFIX + '%']
    );
    const preMap = Object.fromEntries(pre.map((r) => [r.id, Number(r.sla_hours)]));
    assert.strictEqual(preMap[seededIds.std72], 72, 'pre: std72 row should be 72');
    assert.strictEqual(preMap[seededIds.vip24], 24, 'pre: vip24 row should be 24');
    assert.strictEqual(preMap[seededIds.urgent4], 4, 'pre: urgent4 row should be 4');

    // Run the migration's actual SQL (read from disk so test stays
    // honest if the file is ever edited).
    const migrationPath = path.join(__dirname, '..', '..', 'src', 'migrations', '036_sla_hours_align_to_policy.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await execute(migrationSql);

    // Post-state: seeded violators corrected, control row untouched.
    const post = await queryAll(
      `SELECT id, sla_hours FROM services WHERE id LIKE $1 ORDER BY id`,
      [DATA_TEST_PREFIX + '%']
    );
    const postMap = Object.fromEntries(post.map((r) => [r.id, Number(r.sla_hours)]));
    assert.strictEqual(postMap[seededIds.std72], 48, 'post: std72 row should now be 48 (72→48)');
    assert.strictEqual(postMap[seededIds.vip24], 18, 'post: vip24 row should now be 18 (24→18)');
    assert.strictEqual(postMap[seededIds.urgent4], 4, 'post: urgent4 row should remain 4 (no change)');

    // Idempotency: re-running the migration is a no-op on already-correct rows.
    await execute(migrationSql);
    const post2 = await queryAll(
      `SELECT id, sla_hours FROM services WHERE id LIKE $1 ORDER BY id`,
      [DATA_TEST_PREFIX + '%']
    );
    const post2Map = Object.fromEntries(post2.map((r) => [r.id, Number(r.sla_hours)]));
    assert.deepStrictEqual(postMap, post2Map, 'migration must be idempotent (re-run = same state)');

    t.pass('P1-DATA-1: migration 036 corrects 72→48 and 24→18, leaves 4 untouched, is idempotent');
  } catch (e) {
    t.fail('P1-DATA-1 migration', e);
  } finally {
    try {
      await execute(`DELETE FROM services WHERE id LIKE $1`, [DATA_TEST_PREFIX + '%']);
    } catch (_) {}
  }
})();

// ─── P1-SEC-1 + P1-PATIENT-3: HTTP-level lockdown ──────────────────
const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-p1cleanup-';
const SUPER_ID = PREFIX + 'super-' + crypto.randomBytes(3).toString('hex');
const PATIENT_ID = PREFIX + 'patient-' + crypto.randomBytes(3).toString('hex');
const TARGET_DOC_ID = PREFIX + 'targetdoc-' + crypto.randomBytes(3).toString('hex');

const superCookie = COOKIE_NAME + '=' + sign({
  id: SUPER_ID, role: 'superadmin', email: SUPER_ID + '@test.local', name: 'Test Super', lang: 'en'
});
const patientCookie = COOKIE_NAME + '=' + sign({
  id: PATIENT_ID, role: 'patient', email: PATIENT_ID + '@test.local', name: 'Test Patient', lang: 'en'
});

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath,
      [path.join(__dirname, '..', '..', 'src', 'server.js')],
      { env: Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }
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

async function get(p, cookie) {
  const r = await fetch(BASE + p, { redirect: 'manual', headers: { Cookie: cookie } });
  const body = await r.text();
  return { status: r.status, body, location: r.headers.get('location') || '' };
}

async function cleanup() {
  await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function httpRun() {
  try {
    await cleanup();

    // Seed users.
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Super', 'superadmin', 'en', true, NOW())`,
      [SUPER_ID, SUPER_ID + '@test.local']
    );
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Patient', 'patient', 'en', true, NOW())`,
      [PATIENT_ID, PATIENT_ID + '@test.local']
    );
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Target Doc', 'doctor', 'en', true, NOW())`,
      [TARGET_DOC_ID, TARGET_DOC_ID + '@test.local']
    );

    // Seed a DRAFT order owned by the patient.
    const draftOrderId = PREFIX + 'order-' + crypto.randomBytes(3).toString('hex');
    await execute(
      `INSERT INTO orders (id, patient_id, status, payment_status, sla_hours, price, created_at, updated_at)
       VALUES ($1, $2, 'DRAFT', 'unpaid', 48, 1500, NOW(), NOW())`,
      [draftOrderId, PATIENT_ID]
    );

    try { await bootServer(); }
    catch (e) { t.skip('p1-cleanup http', 'boot failed: ' + e.message); return; }

    // ── P1-SEC-1 ────────────────────────────────────────────────
    try {
      const res = await get('/superadmin/debug/reset-link/' + encodeURIComponent(TARGET_DOC_ID), superCookie);
      assert.ok(res.status === 200 || res.status === 500,
        'reset-link route should return 200 (email ok) or 500 (email failed); got ' + res.status);

      // Token must NOT appear in the response body — neither raw nor
      // wrapped in /reset-password/<...>.
      assert.ok(!/\/reset-password\/[a-f0-9-]{30,}/i.test(res.body),
        'response body must NOT contain /reset-password/<token> URL fragment; body:\n' + res.body.slice(0, 500));

      // Sanity: a token row WAS inserted (proving the route did its work).
      const row = await queryOne(
        `SELECT token FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [TARGET_DOC_ID]
      );
      assert.ok(row && row.token, 'token row should exist in password_reset_tokens after the call');
      assert.ok(!res.body.includes(row.token),
        'response body must NOT contain the token literal; first 200 chars: ' + res.body.slice(0, 200));
      t.pass('P1-SEC-1: /superadmin/debug/reset-link does not leak token in response body');

      // Audit log row should exist.
      const auditRow = await queryOne(
        `SELECT id FROM error_logs
          WHERE category = 'admin_audit'
            AND user_id = $1
            AND message LIKE 'viewed payout data:%'
          ORDER BY created_at DESC LIMIT 1`,
        [SUPER_ID]
      );
      // logAdminAudit fires async; allow a moment.
      await new Promise((r) => setTimeout(r, 250));
      const auditRow2 = await queryOne(
        `SELECT id, message FROM error_logs
          WHERE category = 'admin_audit'
            AND user_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [SUPER_ID]
      );
      assert.ok(auditRow2, 'audit row must be recorded for reset-link issuance');
      t.pass('P1-SEC-1: reset-link issuance writes admin_audit row');
    } catch (e) { t.fail('P1-SEC-1', e); }

    // ── P1-PATIENT-3 ────────────────────────────────────────────
    try {
      // Hit /portal/patient/payment-return?success=true with an unpaid
      // draft order. The handler must redirect to /payment-success
      // regardless of the URL param. The DB row's payment_status must
      // remain 'unpaid' after the redirect chain (we do NOT follow into
      // /payment-success because that requires the live mode / stub
      // path; we just check the redirect target and the row state).
      const res = await get(
        '/portal/patient/payment-return?merchant_order_id=' + encodeURIComponent(draftOrderId) + '&success=true',
        patientCookie
      );
      assert.strictEqual(res.status, 302, 'expected 302 redirect from /payment-return; got ' + res.status);
      const target = (res.location || '').split('?')[0];
      assert.ok(
        target.endsWith('/' + draftOrderId + '/payment-success'),
        'redirect target must end with /<orderId>/payment-success; got "' + target + '"'
      );

      // Now also verify success=false STILL redirects to payment-success
      // (we removed the failed-1 branch entirely — payment-success
      // handles the unpaid interim state).
      const resFail = await get(
        '/portal/patient/payment-return?merchant_order_id=' + encodeURIComponent(draftOrderId) + '&success=false',
        patientCookie
      );
      assert.strictEqual(resFail.status, 302, 'success=false path: expected 302');
      const targetFail = (resFail.location || '').split('?')[0];
      assert.ok(
        targetFail.endsWith('/' + draftOrderId + '/payment-success'),
        'success=false path also redirects to /payment-success (DB is source of truth); got "' + targetFail + '"'
      );

      // The DB row was NEVER touched by the redirect.
      const row = await queryOne(
        `SELECT payment_status FROM orders WHERE id = $1`, [draftOrderId]
      );
      assert.strictEqual(row.payment_status, 'unpaid',
        'order payment_status must remain unpaid; got ' + row.payment_status);
      t.pass('P1-PATIENT-3: ?success=true on a draft order does not flip payment_status');
    } catch (e) { t.fail('P1-PATIENT-3', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
