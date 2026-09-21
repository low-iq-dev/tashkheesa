// tests/core/doctor-earnings-reassigned.test.js
//
// P1-DOC-2 follow-up, REWRITTEN for BATCH B (fix plan 2026-09-15): a
// reassigned case earns the outgoing doctor ZERO. The earnings page reads
// the shared reader (services/earnings_reader), whose money figures pin
// reassigned to 0 — so the old "+ X EGP reassigned partial pay" promise can
// only render for a LEGACY adjustment row, and its copy no longer calls it
// partial pay. A reassigned-only month still explains itself via the amber
// pill, now keyed on the reassigned COUNT (the money is always 0).
//
// Coverage:
//   1. Doctor with NO reassigned rows → page renders, neither inline note
//      appears, monthly pill defaults to existing Paid/Pending/Partial logic.
//   2. Doctor with a POST-BATCH-B reassigned main row (earned 0) → the notes
//      stay hidden (there is no reassigned money), Lifetime === Paid +
//      Pending, and a month that also holds paid money reads Approved.
//   3. Reassigned-only month (earned 0) → the amber Reassigned pill renders,
//      keyed on the count, with the no-fee tooltip (never "partial pay").
//   4. LEGACY nonzero reassigned adjustment row → the disclosure notes render
//      with the legacy-adjustment copy, and Lifetime === Paid + Pending +
//      Reassigned still holds.
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
// writer chain). `idPrefix` picks the row KIND the reader distinguishes:
// 'earn-main-' for a real main-case row (the post-Batch-B shape), or the
// default test prefix for a legacy/unclassified row.
async function insertEarning({ amount, status, paidAtIso, idPrefix }) {
  const id = (idPrefix || (PREFIX + 'earn-')) + crypto.randomBytes(3).toString('hex');
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

module.exports = (async function run() {
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

    // ── 2. Post-Batch-B reassigned main row (earned 0) → no money, no notes ──
    try {
      await clearEarnings();
      await insertEarning({ amount: 1000, status: 'paid', paidAtIso: new Date().toISOString(), idPrefix: 'earn-main-' + PREFIX });
      await insertEarning({ amount: 500,  status: 'pending', paidAtIso: null, idPrefix: 'earn-main-' + PREFIX });
      await insertEarning({ amount: 0,    status: 'reassigned', paidAtIso: null, idPrefix: 'earn-main-' + PREFIX });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);

      // Lifetime tile shows 1500 — the reassigned case contributes NOTHING.
      assert.ok(/Lifetime earned[\s\S]*?1,?500/.test(r.body),
        'Lifetime tile should be 1500 (paid 1000 + pending 500 + reassigned 0)');
      assert.ok(!/data-tile="lifetime-reassigned-note"/.test(r.body),
        'no disclosure note for a zero-amount reassigned row — there is no money to disclose');
      assert.ok(!/data-tile="pending-reassigned-note"/.test(r.body),
        'no pending-note either');
      // With paid > 0 in the month, the pill stays on the dominant signal.
      assert.ok(!/data-status="reassigned"/.test(r.body),
        'Monthly pill should not be Reassigned when the month also holds paid money');

      t.pass('Batch B #2: a reassigned case earns zero — Lifetime = Paid + Pending, no partial-pay note');
    } catch (e) { t.fail('Batch B #2 zero-earning reassigned row', e); }

    // ── 3. Reassigned-only month → amber pill keyed on COUNT, no-fee tooltip ──
    try {
      await clearEarnings();
      await insertEarning({ amount: 0, status: 'reassigned', paidAtIso: null, idPrefix: 'earn-main-' + PREFIX });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);
      assert.ok(/data-status="reassigned"/.test(r.body),
        'Reassigned-only month must render the amber Reassigned pill (keyed on the count — the money is 0)');
      assert.ok(/title="Case was reassigned before delivery[^"]*no fee/.test(r.body),
        'Reassigned pill tooltip must state the no-fee policy');
      assert.ok(!/partial pay/i.test(r.body),
        'the page must never promise partial pay for a reassigned case');
      t.pass('Batch B #3: reassigned-only month renders amber pill with the no-fee tooltip');
    } catch (e) { t.fail('Batch B #3 reassigned-only pill', e); }

    // ── 4. Legacy nonzero reassigned adjustment → disclosure notes, math holds ──
    try {
      await clearEarnings();
      await insertEarning({ amount: 1000, status: 'paid', paidAtIso: new Date().toISOString(), idPrefix: 'earn-main-' + PREFIX });
      await insertEarning({ amount: 500,  status: 'pending', paidAtIso: null, idPrefix: 'earn-main-' + PREFIX });
      // A legacy row that still carries money under status reassigned.
      await insertEarning({ amount: 87,   status: 'reassigned', paidAtIso: null, idPrefix: 'earn-main-' + PREFIX });

      const r = await get('/portal/doctor/earnings', doctorCookie);
      assert.strictEqual(r.status, 200, '/portal/doctor/earnings should 200; got ' + r.status);
      assert.ok(/Lifetime earned[\s\S]*?1,?587/.test(r.body),
        'Lifetime tile should sum paid + pending + legacy reassigned = 1587 EGP (a discrepancy made visible, not hidden)');
      assert.ok(/data-tile="lifetime-reassigned-note"/.test(r.body),
        'Lifetime disclosure note must render when a legacy reassigned amount exists');
      assert.ok(/legacy reassigned-case adjustment/.test(r.body),
        'the note copy calls it a legacy adjustment — never partial pay');
      assert.ok(/data-tile="pending-reassigned-note"/.test(r.body),
        'Pending disclosure note must render too');
      assert.ok(!/partial pay/i.test(r.body),
        'no partial-pay wording anywhere');
      t.pass('Batch B #4: legacy nonzero reassigned adjustment is disclosed honestly, math integrity holds');
    } catch (e) { t.fail('Batch B #4 legacy adjustment disclosure', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanupAll(); } catch (_) {}
  }
})();
