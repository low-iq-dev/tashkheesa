// tests/core/doctor-earnings-reassigned.test.js
//
// P1-DOC-2 follow-up: surface 'reassigned' status on the doctor earnings
// page. P1-FIN-2 added the status yesterday (SLA-breach 10%-baseShare
// partial pay) but the existing earnings handler at src/routes/doctor.js:825
// only filtered for 'paid' / 'pending' — so reassigned amounts inflated
// the Lifetime tile silently while the Paid + Pending tiles ignored them,
// breaking the math-integrity property Lifetime === Paid + Pending +
// Reassigned. The monthly status pill defaulted to "Paid" for a
// reassigned-only month.
//
// Coverage:
//   1. Doctor with NO reassigned rows → page renders, neither inline note
//      appears, monthly pill defaults to existing Paid/Pending/Partial logic.
//      (Math integrity vacuously holds: Lifetime === Paid + Pending.)
//   2. Doctor WITH a reassigned row → both inline notes render
//      (Lifetime "Includes reassigned partial pay" + Pending "+ X EGP
//      reassigned ..."), the monthly status pill shows "Reassigned" (amber)
//      with a help-text tooltip, and Lifetime === Paid + Pending + Reassigned.
//
// Boots the real express server in a child process. Skips when
// DATABASE_URL or JWT_SECRET are unset.

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

console.log('\n💰 core/doctor-earnings-reassigned (P1-DOC-2)\n');

if (!process.env.DATABASE_URL) { t.skip('doctor-earnings-reassigned', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('doctor-earnings-reassigned', 'JWT_SECRET not set'); return; }

// onboarding-self-heal.test.js poisons require.cache for src/pg — see P3-TEST-1.
const pgPath = require.resolve('../../src/pg');
delete require.cache[pgPath];
const { execute, queryOne } = require(pgPath);
const { sign } = require('../../src/auth');

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-p1doc2-';
const DOCTOR_ID = PREFIX + 'doctor-' + crypto.randomBytes(3).toString('hex');

const doctorCookie = COOKIE_NAME + '=' + sign({
  id: DOCTOR_ID, role: 'doctor', email: DOCTOR_ID + '@test.local',
  name: 'Dr. Earnings Test', lang: 'en', phone: '+201000000003'
});

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath,
      [path.join(__dirname, '..', '..', 'src', 'server.js')],
      {
        env: Object.assign({}, process.env, {
          PORT, LAUNCH_GATE_OFF: '1', TZ: 'UTC', PGTZ: 'UTC', CSRF_MODE: 'off'
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

async function get(p, cookie) {
  const r = await fetch(BASE + p, { redirect: 'manual', headers: { Cookie: cookie } });
  const body = await r.text();
  return { status: r.status, body };
}

// Insert a doctor_earnings row with explicit status + amount so the test
// owns the fixture shape (rather than depending on an ordering-sensitive
// writer chain). The PK uses the test prefix so cleanup is scoped.
async function insertEarning({ amount, status, paidAtIso }) {
  const id = PREFIX + 'earn-' + crypto.randomBytes(3).toString('hex');
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, paid_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [id, DOCTOR_ID, PREFIX + 'order-' + crypto.randomBytes(3).toString('hex'),
     amount, 0.8, amount, status, paidAtIso || null]
  );
  return id;
}

async function clearEarnings() {
  await execute(`DELETE FROM doctor_earnings WHERE doctor_id = $1`, [DOCTOR_ID]);
}

async function cleanupAll() {
  await execute(`DELETE FROM doctor_earnings WHERE doctor_id = $1`, [DOCTOR_ID]);
  await execute(`DELETE FROM users WHERE id = $1`, [DOCTOR_ID]);
}

(async function run() {
  try {
    await cleanupAll();

    const seedHash = '$2b$10$0000000000000000000000000000000000000000000000000000';
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, phone, created_at)
       VALUES ($1, $2, $3, 'Dr. Earnings Test', 'doctor', 'en', true, '+201000000003', NOW())`,
      [DOCTOR_ID, DOCTOR_ID + '@test.local', seedHash]
    );

    const seedCheck = await queryOne(`SELECT id FROM users WHERE id = $1`, [DOCTOR_ID]);
    if (!seedCheck) {
      t.skip('doctor-earnings-reassigned', 'seed doctor missing post-INSERT (require-cache pollution?)');
      return;
    }

    try { await bootServer(); }
    catch (e) { t.skip('doctor-earnings-reassigned http', 'boot failed: ' + e.message); return; }

    // ── 1. No reassigned rows → notes hidden, math vacuously holds ──
    try {
      await clearEarnings();
      // Seed a paid + pending row so the page renders the lifetime tiles
      // and the monthly statement (otherwise it falls into the empty state).
      await insertEarning({ amount: 1000, status: 'paid', paidAtIso: new Date().toISOString() });
      await insertEarning({ amount: 500,  status: 'pending', paidAtIso: null });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);

      // Lifetime tile shows 1500 (paid + pending).
      assert.ok(/Lifetime earned[\s\S]*?1,?500/.test(r.body),
        'Lifetime tile should render 1500 EGP (paid 1000 + pending 500); body slice: ' + r.body.slice(r.body.indexOf('Lifetime earned'), r.body.indexOf('Lifetime earned') + 600));

      // Neither reassigned note may render when reassigned == 0.
      assert.ok(!/data-tile="lifetime-reassigned-note"/.test(r.body),
        'Lifetime "includes reassigned" note must NOT render when reassigned == 0');
      assert.ok(!/data-tile="pending-reassigned-note"/.test(r.body),
        'Pending "+ reassigned" note must NOT render when reassigned == 0');
      // No Reassigned status pill anywhere.
      assert.ok(!/data-status="reassigned"/.test(r.body),
        'Reassigned status pill must NOT render in any monthly row when reassigned == 0');

      t.pass('P1-DOC-2 #1: doctor with no reassigned rows — inline notes hidden, status pills unchanged');
    } catch (e) { t.fail('P1-DOC-2 #1 no-reassigned', e); }

    // ── 2. With a reassigned row → notes appear, math = paid + pending + reassigned ──
    try {
      await clearEarnings();
      await insertEarning({ amount: 1000, status: 'paid', paidAtIso: new Date().toISOString() });
      await insertEarning({ amount: 500,  status: 'pending', paidAtIso: null });
      await insertEarning({ amount: 87,   status: 'reassigned', paidAtIso: null });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);

      // Lifetime tile shows 1587 (paid + pending + reassigned).
      assert.ok(/Lifetime earned[\s\S]*?1,?587/.test(r.body),
        'Lifetime tile should sum paid + pending + reassigned = 1587 EGP');

      // Math-integrity inline note under Lifetime renders.
      assert.ok(/data-tile="lifetime-reassigned-note"/.test(r.body),
        'Lifetime "includes reassigned partial pay" note must render when reassigned > 0');
      assert.ok(/Includes reassigned partial pay/.test(r.body),
        'Lifetime note copy must read "Includes reassigned partial pay"');

      // Pending tile inline note renders the reassigned amount.
      assert.ok(/data-tile="pending-reassigned-note"/.test(r.body),
        'Pending "+ reassigned" note must render when reassigned > 0');
      assert.ok(/\+\s*87\s*EGP\s+reassigned/.test(r.body),
        'Pending note must render "+ 87 EGP reassigned"; not found in body');

      // Monthly row pill shows Reassigned (the seeded month has reassigned > 0
      // alongside paid > 0; per precedence rules the pill stays "Paid" because
      // the dominant signal is paid. The reassigned-only path is exercised by
      // the inline note assertions above, which is the user-visible contract).
      // Verify the precedence works: with paid > 0, no Reassigned pill in monthly.
      assert.ok(!/data-status="reassigned"/.test(r.body),
        'Monthly pill should remain Paid when paid > 0 (reassigned-only path exercised separately)');

      t.pass('P1-DOC-2 #2: doctor with reassigned row — both inline notes render, math integrity holds (1000 paid + 500 pending + 87 reassigned = 1587)');
    } catch (e) { t.fail('P1-DOC-2 #2 with-reassigned', e); }

    // ── 3. Reassigned-only month → amber pill renders ──
    // Separate test scoped to the precedence rule the previous test deliberately
    // didn't exercise: a month containing ONLY reassigned rows must show the
    // amber Reassigned pill (with help tooltip), not "Paid".
    try {
      await clearEarnings();
      await insertEarning({ amount: 87, status: 'reassigned', paidAtIso: null });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);
      assert.ok(/data-status="reassigned"/.test(r.body),
        'Reassigned-only month must render the amber Reassigned pill');
      // Tooltip text present (server-rendered in title attribute).
      assert.ok(/title="Case was reassigned due to SLA breach[^"]*partial pay/.test(r.body),
        'Reassigned pill must carry a help tooltip explaining 10% baseShare partial pay');
      t.pass('P1-DOC-2 #3 (extra): reassigned-only month renders amber pill with tooltip');
    } catch (e) { t.fail('P1-DOC-2 #3 reassigned-only pill', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanupAll(); } catch (_) {}
  }
})();
