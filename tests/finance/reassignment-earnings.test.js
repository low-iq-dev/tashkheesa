// tests/finance/reassignment-earnings.test.js
//
// Reassignment earnings + audit trail + auto-pause.
//
// BATCH B (fix plan 2026-09-15, B2) — rewritten with the policy: a case
// reassigned away from a doctor earns them ZERO. The P1-FIN-2 10% partial-pay
// token row is gone; markPartialPayOnReassignment became
// markReassignedOnReassignment, and the SLA auto-pause counter the token rows
// used to carry lives in doctor_sla_events (migration 109), written in the
// same transaction under the same guards.
//
// Covers:
//   1. markReassignedOnReassignment flips the original pending row to
//      'reassigned' at earned_amount 0, stamps reassignment_reason, writes
//      the doctor_sla_events row, and writes NO 'earn-reassign-%' token.
//   2. Idempotency:
//      - Called twice for same (doctor, order) → second call returns
//        { idempotent: true } without a second event.
//      - Called when status='paid' (payout already ran) → skipped, no claw-back.
//      - Called when no main row exists → skipped, no INSERT.
//   3. Atomicity: wrapped in withTransaction with FOR UPDATE (source-verified).
//   4. Auto-pause (now counting doctor_sla_events):
//      - Threshold 3 in 30 days: 1 event → no pause; 3rd → users.is_paused = true.
//      - admin_manual events do NOT count (non-fault reassignment).
//      - Already-paused doctor → checkAndAutoPauseDoctor returns alreadyPaused.
//      - Audit log row written to error_logs (category='admin_audit').
//      - EQUIVALENCE: the retired token-row query and the events query agree
//        for the same doctor, including the admin_manual exclusion.
//   5. SLA worker excludes paused doctors from findAlternateDoctor.
//   6. The booted-doctor email says a reassigned case carries no fee — and no
//      longer promises a 10% partial payment.
//
// Skips when DATABASE_URL is unset (mirrors other DB tests).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💰 Batch B reassignment earnings + audit + auto-pause\n');

if (!process.env.DATABASE_URL) { t.skip(path.basename(__filename, '.test.js'), 'DATABASE_URL not set'); return; }

const PREFIX = 'test-fin2-' + crypto.randomBytes(3).toString('hex') + '-';
const ORIG_DOC = PREFIX + 'orig';
const NEW_DOC = PREFIX + 'new';
const PAUSED_DOC = PREFIX + 'paused';
const PATIENT = PREFIX + 'pat';
const ORDER_1 = PREFIX + 'order1';
const ORDER_2 = PREFIX + 'order2';
const ORDER_3 = PREFIX + 'order3';
const ORDER_4 = PREFIX + 'order4';

const { execute, queryOne, queryAll, pool } = require('../../src/pg');
const {
  markReassignedOnReassignment,
  REASSIGN_EARNINGS_PREFIX,
  MAIN_EARNINGS_PREFIX
} = require('../../src/services/earnings_writer');
const { checkAndAutoPauseDoctor } = require('../../src/services/doctor_pause');

async function cleanup() {
  await execute(`DELETE FROM doctor_earnings WHERE doctor_id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM doctor_sla_events WHERE doctor_id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']).catch(() => {});
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']).catch(() => {});
}

async function seedDoctor(id, opts) {
  opts = opts || {};
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, is_paused, created_at)
     VALUES ($1, $2, NULL, $3, 'doctor', 'en', true, $4, NOW())`,
    [id, id + '@test.local', 'Dr ' + id, !!opts.is_paused]
  );
}

async function seedPatient(id) {
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
     VALUES ($1, $2, NULL, 'Test Patient', 'patient', 'en', true, NOW())`,
    [id, id + '@test.local']
  );
}

async function seedOrder(orderId, patientId, doctorId, doctorFee) {
  await execute(
    `INSERT INTO orders (id, patient_id, doctor_id, doctor_fee, price, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'in_review', NOW(), NOW())`,
    [orderId, patientId, doctorId, doctorFee, doctorFee + 100]
  );
}

async function seedPendingEarnings(orderId, doctorId, baseShare) {
  const id = MAIN_EARNINGS_PREFIX + crypto.randomUUID();
  await execute(
    `INSERT INTO doctor_earnings
       (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, created_at)
     VALUES ($1, $2, $3, $4, 100, $5, 'pending', NOW())`,
    [id, doctorId, orderId, baseShare, baseShare]
  );
  return id;
}

// The RETIRED token-row counter, verbatim from the old doctor_pause.js — kept
// here as the equivalence baseline for the migration-109 re-home.
async function legacyTokenCount(doctorId, windowDays) {
  const r = await queryOne(
    `SELECT COUNT(*)::int AS n
       FROM doctor_earnings
      WHERE doctor_id = $1
        AND status = 'reassigned'
        AND id LIKE 'earn-reassign-%'
        AND COALESCE(reassignment_reason, '') NOT LIKE 'admin\\_manual%'
        AND created_at >= NOW() - ($2 * INTERVAL '1 day')`,
    [doctorId, windowDays]
  );
  return Number(r && r.n) || 0;
}

async function eventCount(doctorId, windowDays) {
  const r = await queryOne(
    `SELECT COUNT(*)::int AS n
       FROM doctor_sla_events
      WHERE doctor_id = $1
        AND COALESCE(reason, '') NOT LIKE 'admin\\_manual%'
        AND created_at >= NOW() - ($2 * INTERVAL '1 day')`,
    [doctorId, windowDays]
  );
  return Number(r && r.n) || 0;
}

module.exports = (async function run() {
  try {
    await cleanup();

    // Common seeds
    await seedPatient(PATIENT);
    await seedDoctor(ORIG_DOC);
    await seedDoctor(NEW_DOC);
    await seedDoctor(PAUSED_DOC, { is_paused: true });

    // ── 1. Happy path: main row flipped to 0, event written, NO token row
    try {
      await seedOrder(ORDER_1, PATIENT, ORIG_DOC, 200);
      const oldRowId = await seedPendingEarnings(ORDER_1, ORIG_DOC, 200);
      const r = await markReassignedOnReassignment(ORIG_DOC, ORDER_1, 'sla_breach');
      assert.ok(r.written, 'returned written=true: ' + JSON.stringify(r));
      assert.strictEqual(r.oldRowId, oldRowId, 'oldRowId matches seeded row');
      assert.ok(r.slaEventId, 'slaEventId returned');

      // Old row flipped to ZERO, reason stamped
      const oldRow = await queryOne('SELECT status, earned_amount, commission_pct, reassignment_reason, gross_amount FROM doctor_earnings WHERE id = $1', [oldRowId]);
      assert.strictEqual(oldRow.status, 'reassigned', 'old row status=reassigned');
      assert.strictEqual(Number(oldRow.earned_amount), 0, 'old row earned_amount=0 — a reassigned case earns nothing');
      assert.strictEqual(Number(oldRow.commission_pct), 0, 'old row commission_pct=0');
      assert.strictEqual(oldRow.reassignment_reason, 'sla_breach', 'old row reason stamped');
      assert.strictEqual(Number(oldRow.gross_amount), 200, 'gross_amount kept as the reconciliation record');

      // NO token row
      const tok = await queryOne(
        `SELECT COUNT(*)::int AS n FROM doctor_earnings
          WHERE id LIKE '${REASSIGN_EARNINGS_PREFIX}%' AND appointment_id = $1`,
        [ORDER_1]
      );
      assert.strictEqual(Number(tok.n), 0, 'no earn-reassign-% token row is written any more');

      // The sla event
      const evt = await queryOne('SELECT * FROM doctor_sla_events WHERE id = $1', [r.slaEventId]);
      assert.ok(evt, 'doctor_sla_events row exists');
      assert.strictEqual(evt.doctor_id, ORIG_DOC, 'event doctor_id');
      assert.strictEqual(evt.order_id, ORDER_1, 'event order_id');
      assert.strictEqual(evt.reason, 'sla_breach', 'event reason');
      t.pass('happy path: flip-to-zero + sla event, and no token row');
    } catch (e) { t.fail('happy path', e); }

    // ── 2. Idempotency: second call no-ops, still exactly one event
    try {
      const r2 = await markReassignedOnReassignment(ORIG_DOC, ORDER_1, 'sla_breach');
      assert.ok(r2.idempotent === true, 'second call idempotent: ' + JSON.stringify(r2));
      const cnt = await queryOne(
        `SELECT COUNT(*)::int AS n FROM doctor_sla_events WHERE order_id = $1 AND doctor_id = $2`,
        [ORDER_1, ORIG_DOC]
      );
      assert.strictEqual(Number(cnt.n), 1, 'still exactly 1 event after second call');
      t.pass('idempotency: second call returns existing state, no duplicate event');
    } catch (e) { t.fail('idempotency', e); }

    // ── 3. Race guard: status='paid' (payout already ran) → skipped
    try {
      await seedOrder(ORDER_2, PATIENT, ORIG_DOC, 300);
      const paidId = MAIN_EARNINGS_PREFIX + crypto.randomUUID();
      await execute(
        `INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, paid_at, created_at)
         VALUES ($1, $2, $3, 300, 100, 300, 'paid', NOW(), NOW())`,
        [paidId, ORIG_DOC, ORDER_2]
      );
      const r = await markReassignedOnReassignment(ORIG_DOC, ORDER_2, 'sla_breach');
      assert.strictEqual(r.skipped, 'already_paid', 'skipped=already_paid: ' + JSON.stringify(r));
      const paidRow = await queryOne('SELECT status, earned_amount FROM doctor_earnings WHERE id = $1', [paidId]);
      assert.strictEqual(paidRow.status, 'paid', 'paid row still paid (no claw-back)');
      assert.strictEqual(Number(paidRow.earned_amount), 300, 'paid amount unchanged');
      const cnt = await queryOne(
        `SELECT COUNT(*)::int AS n FROM doctor_sla_events WHERE order_id = $1`, [ORDER_2]
      );
      assert.strictEqual(Number(cnt.n), 0, 'no event for the skipped case (same guard the token had)');
      t.pass('race guard: settled money not clawed back, no event written');
    } catch (e) { t.fail('race guard', e); }

    // ── 4. No main row → skipped (original doctor never accepted)
    try {
      await seedOrder(ORDER_3, PATIENT, ORIG_DOC, 150);
      const r = await markReassignedOnReassignment(ORIG_DOC, ORDER_3, 'sla_breach');
      assert.strictEqual(r.skipped, 'no_main_row', 'skipped=no_main_row: ' + JSON.stringify(r));
      const cnt = await queryOne(
        `SELECT COUNT(*)::int AS n FROM doctor_sla_events WHERE order_id = $1`, [ORDER_3]
      );
      assert.strictEqual(Number(cnt.n), 0, 'no event without a main row (same guard the token had)');
      t.pass('no main row: skipped cleanly, no spurious writes');
    } catch (e) { t.fail('no main row', e); }

    // ── 5. Atomicity: withTransaction + FOR UPDATE (source-verified)
    try {
      await seedOrder(ORDER_4, PATIENT, ORIG_DOC, 100);
      const oldRowId = await seedPendingEarnings(ORDER_4, ORIG_DOC, 100);
      const fs = require('fs');
      const writerSrc = fs.readFileSync(require.resolve('../../src/services/earnings_writer'), 'utf8');
      const fnIdx = writerSrc.indexOf('async function markReassignedOnReassignment');
      assert.ok(fnIdx >= 0, 'markReassignedOnReassignment exists');
      const fnSlice = writerSrc.substring(fnIdx, fnIdx + 4000);
      assert.ok(/withTransaction/.test(fnSlice),
        'markReassignedOnReassignment uses withTransaction (flip + event are atomic)');
      assert.ok(/FOR UPDATE/.test(fnSlice),
        'lock the main row for concurrent-call safety');
      assert.ok(/INSERT INTO doctor_sla_events/.test(fnSlice),
        'the sla event is written inside the same function/transaction');
      const oldRow = await queryOne('SELECT status FROM doctor_earnings WHERE id = $1', [oldRowId]);
      assert.strictEqual(oldRow.status, 'pending', 'pre-call: row still pending (control)');
      t.pass('atomicity: helper uses withTransaction + FOR UPDATE + in-txn event (source-verified)');
    } catch (e) { t.fail('atomicity', e); }

    // ── 6. Auto-pause: under threshold = no pause (counts events now)
    try {
      // ORIG_DOC has exactly 1 qualifying event from the happy-path test
      const r = await checkAndAutoPauseDoctor(ORIG_DOC);
      assert.strictEqual(r.paused, false, 'no pause when below threshold (1 < 3)');
      assert.strictEqual(r.breaches, 1, 'breaches count = 1');
      const u = await queryOne('SELECT is_paused FROM users WHERE id = $1', [ORIG_DOC]);
      assert.strictEqual(u.is_paused, false, 'users.is_paused stays false');
      t.pass('auto-pause: 1 breach < threshold(3) → no pause');
    } catch (e) { t.fail('auto-pause under threshold', e); }

    // ── 7. admin_manual events do NOT count (non-fault reassignment)
    try {
      await execute(
        `INSERT INTO doctor_sla_events (id, doctor_id, order_id, reason, created_at)
         VALUES ($1, $2, $3, 'admin_manual: doctor on leave', NOW())`,
        ['slaevt-' + crypto.randomUUID(), ORIG_DOC, PREFIX + 'order-manual']
      );
      const r = await checkAndAutoPauseDoctor(ORIG_DOC);
      assert.strictEqual(r.breaches, 1, 'admin_manual event excluded from the count: ' + JSON.stringify(r));
      assert.strictEqual(r.paused, false, 'still no pause');
      t.pass('auto-pause: operator-initiated (admin_manual) reassignment never counts');
    } catch (e) { t.fail('admin_manual exclusion', e); }

    // ── 8. EQUIVALENCE: old token query and new event signal agree
    try {
      // Mirror the current events as legacy token rows (what migration 109's
      // backfill does in reverse), then compare the two counters.
      const evts = await queryAll(
        `SELECT id, order_id, reason, created_at FROM doctor_sla_events WHERE doctor_id = $1`,
        [ORIG_DOC]
      );
      for (const e of evts) {
        await execute(
          `INSERT INTO doctor_earnings (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, reassignment_reason, created_at)
           VALUES ($1, $2, $3, 0, 0, 0, 'reassigned', $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [REASSIGN_EARNINGS_PREFIX + crypto.randomUUID(), ORIG_DOC, e.order_id, e.reason, e.created_at]
        );
      }
      const legacy = await legacyTokenCount(ORIG_DOC, 30);
      const events = await eventCount(ORIG_DOC, 30);
      assert.strictEqual(events, legacy,
        'old token-row count (' + legacy + ') === new event count (' + events + '), admin_manual excluded from both');
      // Clean the mirror rows so later counts are not double-fed
      await execute(
        `DELETE FROM doctor_earnings WHERE doctor_id = $1 AND id LIKE '${REASSIGN_EARNINGS_PREFIX}%'`,
        [ORIG_DOC]
      );
      t.pass('equivalence: token-row query and doctor_sla_events count the same N (incl. admin_manual exclusion)');
    } catch (e) { t.fail('counter equivalence', e); }

    // ── 9. Auto-pause: AT threshold = pause + audit log + reason set
    try {
      for (var i = 0; i < 2; i++) {
        await execute(
          `INSERT INTO doctor_sla_events (id, doctor_id, order_id, reason, created_at)
           VALUES ($1, $2, $3, 'sla_breach', NOW())`,
          ['slaevt-' + crypto.randomUUID(), ORIG_DOC, PREFIX + 'order-bonus-' + i]
        );
      }
      const r = await checkAndAutoPauseDoctor(ORIG_DOC);
      assert.strictEqual(r.paused, true, 'pause triggered: ' + JSON.stringify(r));
      assert.strictEqual(r.breaches, 3, 'breaches=3');
      assert.strictEqual(r.threshold, 3, 'threshold=3');
      assert.strictEqual(r.windowDays, 30, 'window=30');
      const u = await queryOne('SELECT is_paused, paused_at, pause_reason FROM users WHERE id = $1', [ORIG_DOC]);
      assert.strictEqual(u.is_paused, true, 'users.is_paused now true');
      assert.ok(u.paused_at, 'paused_at stamped');
      assert.ok(/^auto:sla_breach_threshold:/.test(u.pause_reason), 'pause_reason: ' + u.pause_reason);
      const audit = await queryOne(
        `SELECT context FROM error_logs WHERE category = 'admin_audit' AND user_id = $1 ORDER BY id DESC LIMIT 1`,
        [ORIG_DOC]
      );
      assert.ok(audit, 'audit log row exists');
      assert.ok(/auto_paused_doctor/.test(audit.context), 'audit context mentions auto_paused_doctor');
      t.pass('auto-pause: 3 events → users.is_paused=true + audit log written');
    } catch (e) { t.fail('auto-pause at threshold', e); }

    // ── 10. Auto-pause: already-paused doctor short-circuits
    try {
      const r = await checkAndAutoPauseDoctor(ORIG_DOC);
      assert.strictEqual(r.alreadyPaused, true, 'second call returns alreadyPaused: ' + JSON.stringify(r));
      assert.strictEqual(r.paused, false, 'paused=false (was already paused, not newly)');
      t.pass('auto-pause: already-paused doctor short-circuits');
    } catch (e) { t.fail('already-paused short-circuit', e); }

    // ── 11. SLA worker excludes paused doctors from findAlternateDoctor
    try {
      const fs = require('fs');
      const workerSrc = fs.readFileSync(require.resolve('../../src/case_sla_worker'), 'utf8');
      assert.ok(/COALESCE\(u\.is_paused, false\) = false/.test(workerSrc),
        'buildAlternateDoctorQuery excludes paused doctors');
      t.pass('SLA worker: findAlternateDoctor excludes is_paused=true');
    } catch (e) { t.fail('paused exclusion grep', e); }

    // ── 12. Source-grep: reassignCase wires earnings + audit + notify + pause
    try {
      const fs = require('fs');
      const lifecycleSrc = fs.readFileSync(require.resolve('../../src/case_lifecycle'), 'utf8');
      assert.ok(/markReassignedOnReassignment/.test(lifecycleSrc), 'reassignCase calls markReassignedOnReassignment');
      assert.ok(/reassigned_to_doctor_id\s*=\s*\$1/.test(lifecycleSrc), 'orders audit fields UPDATE present');
      assert.ok(/order_reassigned_from_doctor/.test(lifecycleSrc), 'queues notification to original doctor');
      assert.ok(/checkAndAutoPauseDoctor/.test(lifecycleSrc), 'invokes auto-pause check');
      const workerSrc = fs.readFileSync(require.resolve('../../src/notification_worker'), 'utf8');
      assert.ok(/order_reassigned_from_doctor:\s*'case-reassigned-original'/.test(workerSrc),
        'notification_worker maps template');
      t.pass('reassignCase: earnings + audit + notify + pause all wired');
    } catch (e) { t.fail('reassignCase wiring', e); }

    // ── 13. Notification template: no fee is payable — and no 10% promise
    try {
      const { renderEmail } = require('../../src/services/emailService');
      const html = renderEmail('case-reassigned-original', 'en', {
        doctorName: 'Test Doctor',
        caseReference: 'TSH-2026-001',
        isAcceptanceBreach: false
      });
      assert.ok(html, 'rendered HTML');
      assert.ok(/Case Reassigned/.test(html), 'EN headline present');
      assert.ok(/Dr\. Test Doctor/.test(html), 'doctorName interpolated');
      assert.ok(/TSH-2026-001/.test(html), 'caseReference interpolated');
      assert.ok(/no fee is payable/.test(html), 'EN states plainly that a reassigned case carries no fee');
      assert.ok(!/partial pay/i.test(html), 'the 10% partial-pay promise is gone');
      assert.ok(/your report was submitted/.test(html), 'isAcceptanceBreach=false branch');
      const htmlAcc = renderEmail('case-reassigned-original', 'en', {
        doctorName: 'Test', caseReference: 'X', isAcceptanceBreach: true
      });
      assert.ok(/you accepted the case/.test(htmlAcc), 'isAcceptanceBreach=true branch');
      // AR
      const htmlAr = renderEmail('case-reassigned-original', 'ar', {
        doctorName: 'تجريبي', caseReference: 'TSH-X', isAcceptanceBreach: false
      });
      assert.ok(/تم إعادة تعيين الحالة/.test(htmlAr), 'AR headline present');
      assert.ok(/لا تُستحق أي أتعاب/.test(htmlAr), 'AR states no fee is payable');
      assert.ok(/تقديم تقريرك/.test(htmlAr), 'AR isAcceptanceBreach=false branch');
      t.pass('templates: EN + AR say a reassigned case carries no fee, with no partial-pay promise');
    } catch (e) { t.fail('template rendering', e); }

  } finally {
    await cleanup();
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})().catch(function (err) {
  t.fail('harness crashed', err);
});
