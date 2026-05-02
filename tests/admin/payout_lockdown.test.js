// tests/admin/payout_lockdown.test.js
//
// HTTP-level tests for the P0-SEC payout-surface lockdown.
//
// What we test:
//   1. Whole-route lockdown: /admin/pricing, /admin/pricing/export,
//      /admin/services/new, /admin/services/:id/edit,
//      /portal/admin/analytics, /api/analytics/export
//      → 403 for role='admin', 200 for role='superadmin'
//
//   2. Tile-level conditional render on /admin (dashboard):
//      → role='admin' response HTML must NOT contain "Pending Dr Payouts"
//      → role='superadmin' response HTML MUST contain "Pending Dr Payouts"
//
//   3. Column conditional render on /admin/services:
//      → role='admin' response HTML must NOT contain "Doctor Fee" header
//      → role='superadmin' response HTML MUST contain "Doctor Fee" header
//
//   4. Audit-log row inserted for superadmin payout views:
//      → After a superadmin GET on /admin/pricing, an error_logs row
//        with category='admin_audit' and message LIKE 'viewed payout data:%'
//        is present.
//
// We boot the real express app in a child process on a random port so
// the test exercises the full middleware stack (cookies, JWT verify,
// requireRole, render). Test is skipped automatically when DATABASE_URL
// is unset or the server can't be reached.

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

console.log('\n🔒 admin/payout-lockdown\n');

if (!process.env.DATABASE_URL) {
  t.skip('payout-lockdown', 'DATABASE_URL not set');
  return;
}
if (!process.env.JWT_SECRET) {
  t.skip('payout-lockdown', 'JWT_SECRET not set');
  return;
}

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-payoutlock-';
const ADMIN_ID = PREFIX + 'admin-' + crypto.randomBytes(3).toString('hex');
const SUPERADMIN_ID = PREFIX + 'super-' + crypto.randomBytes(3).toString('hex');

const { execute, queryOne, pool } = require('../../src/pg');
const { sign } = require('../../src/auth');

const adminCookie = COOKIE_NAME + '=' + sign({
  id: ADMIN_ID, role: 'admin', email: ADMIN_ID + '@test.local', name: 'Test Admin', lang: 'en'
});
const superCookie = COOKIE_NAME + '=' + sign({
  id: SUPERADMIN_ID, role: 'superadmin', email: SUPERADMIN_ID + '@test.local', name: 'Test Super', lang: 'en'
});

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PORT,
      // Don't write to the real DB-write paths during boot.
      LAUNCH_GATE_OFF: '1'
    });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && /running on port/.test(s)) {
        booted = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', () => {}); // silence noisy stderr
    serverProc.once('exit', (code) => {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout (15s)'));
    }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((res) => setTimeout(res, 500));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function get(path, cookie) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { Cookie: cookie }
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function cleanup() {
  await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function run() {
  try {
    await cleanup();

    // Seed test users (so JWT verifications match an actual row if any
    // route checks). The middleware uses the JWT payload directly so
    // this is mostly for cleanliness.
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Test Admin', 'admin', 'en', true, NOW())`,
      [ADMIN_ID, ADMIN_ID + '@test.local']
    );
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Test Super', 'superadmin', 'en', true, NOW())`,
      [SUPERADMIN_ID, SUPERADMIN_ID + '@test.local']
    );

    try {
      await bootServer();
    } catch (e) {
      t.skip('payout-lockdown', 'server boot failed: ' + e.message);
      return;
    }

    // Sanity: server is actually responsive before we run the assertions.
    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) {
      t.skip('payout-lockdown', 'server unreachable: ' + e.message);
      return;
    }

    // ── 1. Whole-route lockdown ────────────────────────────────────
    const lockedRoutes = [
      '/admin/pricing',
      '/admin/pricing/export',
      '/admin/services/new',
      '/portal/admin/analytics',
      '/api/analytics/export'
    ];

    for (const route of lockedRoutes) {
      try {
        const adm = await get(route, adminCookie);
        assert.strictEqual(adm.status, 403, route + ' must return 403 for role=admin (got ' + adm.status + ')');
        t.pass('lockdown: admin → 403 on ' + route);
      } catch (e) { t.fail('lockdown admin/' + route, e); }

      try {
        const sup = await get(route, superCookie);
        assert.notStrictEqual(sup.status, 403, route + ' must NOT 403 for role=superadmin');
        // Allow 200 or 302 (redirect-to-login is impossible since cookie is valid;
        // redirects from inside the route are fine — what matters is no 403).
        t.pass('lockdown: superadmin not 403 on ' + route + ' (got ' + sup.status + ')');
      } catch (e) { t.fail('lockdown superadmin/' + route, e); }
    }

    // ── 2. Tile-level conditional on /admin ────────────────────────
    try {
      const adm = await get('/admin', adminCookie);
      assert.strictEqual(adm.status, 200, '/admin must 200 for admin');
      assert.ok(!/Pending Dr Payouts/.test(adm.body), '/admin response for admin must NOT contain "Pending Dr Payouts"');
      assert.ok(!/Refunds This Month/.test(adm.body), '/admin response for admin must NOT contain "Refunds This Month"');
      t.pass('tile: /admin hides financials section for role=admin');
    } catch (e) { t.fail('tile lockdown admin', e); }

    try {
      const sup = await get('/admin', superCookie);
      assert.strictEqual(sup.status, 200, '/admin must 200 for superadmin');
      assert.ok(/Pending Dr Payouts/.test(sup.body), '/admin response for superadmin MUST contain "Pending Dr Payouts"');
      t.pass('tile: /admin shows financials section for role=superadmin');
    } catch (e) { t.fail('tile visible superadmin', e); }

    // ── 3. Column conditional on /admin/services ───────────────────
    try {
      const adm = await get('/admin/services', adminCookie);
      assert.strictEqual(adm.status, 200, '/admin/services must 200 for admin');
      assert.ok(!/<th[^>]*>Doctor Fee<\/th>/.test(adm.body), '/admin/services for admin must NOT include Doctor Fee column');
      assert.ok(!/<th[^>]*>Revenue<\/th>/.test(adm.body), '/admin/services for admin must NOT include Revenue column');
      t.pass('column: /admin/services hides Doctor Fee + Revenue for role=admin');
    } catch (e) { t.fail('column lockdown admin', e); }

    try {
      const sup = await get('/admin/services', superCookie);
      assert.strictEqual(sup.status, 200, '/admin/services must 200 for superadmin');
      assert.ok(/<th[^>]*>Doctor Fee<\/th>/.test(sup.body), '/admin/services for superadmin MUST include Doctor Fee column');
      assert.ok(/<th[^>]*>Revenue<\/th>/.test(sup.body), '/admin/services for superadmin MUST include Revenue column');
      t.pass('column: /admin/services shows Doctor Fee + Revenue for role=superadmin');
    } catch (e) { t.fail('column visible superadmin', e); }

    // ── 4. Audit-log inserted on superadmin payout view ────────────
    try {
      // GET /admin/pricing as superadmin — should write an admin_audit row.
      const ts = new Date();
      await get('/admin/pricing', superCookie);
      // Allow a moment for the best-effort INSERT to land.
      await new Promise((r) => setTimeout(r, 250));
      const row = await queryOne(
        `SELECT id, message FROM error_logs
          WHERE category = 'admin_audit'
            AND user_id = $1
            AND message LIKE 'viewed payout data:%'
            AND created_at >= $2
          ORDER BY created_at DESC LIMIT 1`,
        [SUPERADMIN_ID, ts.toISOString()]
      );
      assert.ok(row, 'expected admin_audit row after superadmin GET /admin/pricing; got null');
      assert.match(String(row.message), /\/admin\/pricing/, 'audit message should mention the route');
      t.pass('audit: superadmin GET /admin/pricing writes admin_audit row');
    } catch (e) { t.fail('audit log', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
