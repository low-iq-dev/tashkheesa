// Batch B verification — reconciliation, the Cairo boundary, idempotency,
// atomicity. Runs against a scratch Postgres loaded with verify_schema.sql:
//
//   createdb tashkheesa_batchb_verify
//   psql -q tashkheesa_batchb_verify < docs/reviews/batch-b-2026-09-21/verify_schema.sql
//   DATABASE_URL=postgresql://localhost/tashkheesa_batchb_verify \
//     node docs/reviews/batch-b-2026-09-21/verify_batch_b.js
//
// (The pause-counter equivalence and the writer-semantics suite run
// separately: tests/finance/reassignment-earnings.test.js and
// tests/services/earnings_writer.test.js against the same DATABASE_URL.)
//
// External side effects are stubbed at the module seam (require.cache):
// report-generator (R2 upload) returns a fake URL and counts calls; notify
// counts queued notifications; case_lifecycle's best-effort bookkeeping
// transition is a no-op so the run exercises exactly the Batch B writes.

'use strict';

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const R = (p) => require.resolve(path.join(ROOT, 'src', p));

// ── Stubs (installed before anything requires the real modules) ────────────
let pdfCalls = 0;
require.cache[R('report-generator.js')] = {
  id: R('report-generator.js'), filename: R('report-generator.js'), loaded: true,
  exports: {
    generateMedicalReportPdf: async ({ caseId }) => { pdfCalls += 1; return 'https://r2.example/reports/' + caseId + '.pdf'; }
  }
};
const notifyCalls = [];
require.cache[R('notify.js')] = {
  id: R('notify.js'), filename: R('notify.js'), loaded: true,
  exports: {
    queueNotification: async () => ({ ok: true }),
    queueMultiChannelNotification: async (args) => { notifyCalls.push(args); return { ok: true, results: {} }; },
    notifyAdmins: async () => ({ ok: true }),
    doctorNotify: async () => ({ ok: true })
  }
};
require.cache[R('case_lifecycle.js')] = {
  id: R('case_lifecycle.js'), filename: R('case_lifecycle.js'), loaded: true,
  exports: {
    transitionCase: async () => ({}),
    logCaseEvent: async () => ({}),
    CANON_STATUS: { IN_REVIEW: 'IN_REVIEW', COMPLETED: 'COMPLETED' },
    CASE_STATUS: { IN_REVIEW: 'IN_REVIEW', COMPLETED: 'COMPLETED' },
    toDbStatus: (s) => ({ COMPLETED: 'completed', IN_REVIEW: 'in_review' }[s] || null),
    toCanonStatus: (s) => String(s || '').toUpperCase(),
    markSlaBreach: async () => ({})
  }
};

const { queryOne, queryAll, execute, pool } = require(R('pg.js'));
const writer = require(R('services/earnings_writer.js'));
const reader = require(R('services/earnings_reader.js'));
const { submitDoctorReport } = require(R('services/report_submission.js'));

const OUT = [];
function log(line) { OUT.push(line); console.log(line); }
function money(n) { return Math.round(n * 100) / 100; }

const D = 'vb-doc-1';
const P = 'vb-pat-1';

async function seedOrder({ id, fee, uplift, status = 'in_review', completedAtUtc = null, tier = 'standard' }) {
  await execute(
    `INSERT INTO orders (id, patient_id, doctor_id, service_id, specialty_id, status, payment_status,
                         price, base_price, doctor_fee, urgency_uplift_amount, urgency_tier, sla_hours,
                         paid_at, accepted_at, completed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'svc-1', 'sp-1', $4, 'paid',
             $5, $6, $7, $8, $9, 48,
             NOW(), NOW(), $10, NOW(), NOW())`,
    [id, P, D, status, (fee * 5) + Number(uplift), fee * 5, fee, uplift, tier, completedAtUtc]
  );
}

(async function main() {
  // ── Seed the fixed world ─────────────────────────────────────────────────
  await execute(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, 'Dr Verify', 'doctor')`, [D, D + '@t.local']);
  await execute(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, 'Pat Verify', 'patient')`, [P, P + '@t.local']);
  await execute(`INSERT INTO specialties (id, name) VALUES ('sp-1', 'Cardiology')`);
  await execute(`INSERT INTO services (id, name, urgency_uplift_doctor_pct) VALUES ('svc-1', 'Cardiac MR Review', 30)`);

  log('══ Batch B verification — ' + new Date().toISOString() + ' ══');
  log('');
  log('SEED (the brief\'s mix, all completing in the CURRENT Cairo month unless stated):');

  // (a) Completed standard case — fee 600, no uplift → 600.
  await seedOrder({ id: 'vb-o-std', fee: 600, uplift: 0 });
  await writer.writePendingForCase('vb-o-std');
  await writer.settleCaseEarningsOnCompletion('vb-o-std', D);
  await execute(`UPDATE orders SET status='completed', completed_at=NOW() WHERE id='vb-o-std'`);
  log('  a) standard completed: fee 600, uplift 0            → earns 600');

  // (b) Completed VIP case — fee 600, uplift 900 → 600 + 270 = 870.
  await seedOrder({ id: 'vb-o-vip', fee: 600, uplift: 900, tier: 'vip' });
  await writer.writePendingForCase('vb-o-vip');
  await writer.settleCaseEarningsOnCompletion('vb-o-vip', D);
  await execute(`UPDATE orders SET status='completed', completed_at=NOW() WHERE id='vb-o-vip'`);
  log('  b) VIP completed: fee 600, uplift 900 (30% share)   → earns 870');

  // (c) SLA-breached but DELIVERED VIP case — uplift reversed, base stands → 600.
  await seedOrder({ id: 'vb-o-breach', fee: 600, uplift: 900, tier: 'vip' });
  await writer.writePendingForCase('vb-o-breach');
  await execute(`UPDATE orders SET urgency_uplift_amount = 0 WHERE id='vb-o-breach'`); // sla_breach.js does this
  const breach = await writer.recomputeOnBreach('vb-o-breach');
  assert.strictEqual(breach.newEarnedAmount, 600, 'breach leaves base only');
  await writer.settleCaseEarningsOnCompletion('vb-o-breach', D);
  await execute(`UPDATE orders SET status='completed', completed_at=NOW() WHERE id='vb-o-breach'`);
  log('  c) VIP breached, still delivered: uplift reversed   → earns 600 (base stands)');

  // (d) Reassigned-away case — earns ZERO, and the sla event is recorded.
  await seedOrder({ id: 'vb-o-reass', fee: 500, uplift: 0 });
  await writer.writePendingForCase('vb-o-reass');
  const re = await writer.markReassignedOnReassignment(D, 'vb-o-reass', 'sla_breach');
  assert.ok(re.written && re.slaEventId, 'reassignment write-down + sla event');
  log('  d) reassigned away: fee 500                         → earns 0 (+1 pause-counter event)');

  // (e) Video add-on on the VIP case — 1000 @ 85% → 850 in addon_earnings.
  const addonRow = await queryOne(
    `INSERT INTO order_addons (order_id, addon_service_id, status, price_at_purchase_egp, doctor_commission_pct_at_purchase, fulfilled_at)
     VALUES ('vb-o-vip', 'video_consult', 'fulfilled', 1000, 85, NOW()) RETURNING id`
  );
  const { getAddon } = require(R('services/addons/registry.js'));
  const videoSvc = getAddon('video_consult');
  const addonFull = await queryOne(`SELECT * FROM order_addons WHERE id = $1`, [addonRow.id]);
  await videoSvc.onComplete({ order: { id: 'vb-o-vip' }, addon: addonFull, doctorId: D });
  log('  e) video add-on: 1000 EGP @ 85%                     → earns 850 (addon ledger)');

  // (f) The Cairo month boundary pair. Africa/Cairo is UTC+3 in August
  //     (EEST): 2026-08-31T20:30Z = 23:30 Cairo Aug 31;
  //             2026-08-31T21:30Z = 00:30 Cairo Sep 1.
  //     Both share the same UTC calendar day — the naive-UTC bucketing every
  //     old surface used puts them in ONE month; Cairo splits them.
  for (const [id, fee, utc] of [
    ['vb-o-aug', 100, '2026-08-31T20:30:00Z'],
    ['vb-o-sep', 200, '2026-08-31T21:30:00Z'],
  ]) {
    await seedOrder({ id, fee, uplift: 0 });
    await writer.writePendingForCase(id);
    await writer.settleCaseEarningsOnCompletion(id, D);
    await execute(`UPDATE orders SET status='completed', completed_at=$1 WHERE id=$2`, [utc, id]);
  }
  log('  f) boundary pair: 100 EGP @ 23:30 Cairo Aug 31, 200 EGP @ 00:30 Cairo Sep 1');
  log('     (same UTC day — 20:30Z and 21:30Z on Aug 31)');
  log('');

  // ── 1. ONE NUMBER, FOUR PLACES ───────────────────────────────────────────
  // Hand-computed (this run happens in September 2026, Cairo):
  //   current-Cairo-month pending = 600 + 870 + 600 (+ 850 add-on)
  //                               + 200 (the 00:30-Cairo Sep 1 boundary row)
  //                               = 3120; reassigned contributes 0; the
  //                               23:30-Cairo Aug 31 row (100) is LAST month.
  //   Owed overall (pending, any month) = 3120 + 100 = 3220.
  const HAND = { monthPending: 3120, owedTotal: 3220, mainOwed: 2370, addonOwed: 850 };
  log('── 1. One number, four places ──');
  log('   hand-computed: current-Cairo-month not-yet-approved = 600+870+600+850+200 = ' + HAND.monthPending);
  log('   hand-computed: owed overall (any month)             = 3120+100            = ' + HAND.owedTotal);

  const tile = await reader.getDoctorMonthSummary(D);
  log('   dashboard tile   (getDoctorMonthSummary):  notYetApproved = ' + tile.notYetApproved + ', approved = ' + tile.approved);
  assert.strictEqual(tile.notYetApproved, HAND.monthPending, 'tile month figure');
  assert.strictEqual(tile.approved, 0, 'nothing paid out yet');

  const life = await reader.getDoctorLifetimeTotals(D);
  log('   earnings page    (getDoctorLifetimeTotals): pending = ' + life.pending + ', paid = ' + life.paid + ', reassigned = ' + life.reassigned);
  assert.strictEqual(life.pending, HAND.owedTotal, 'earnings page lifetime pending');
  assert.strictEqual(life.reassigned, 0, 'reassigned money is zero');

  const owedRows = await reader.getOwedByDoctor({ limit: 10 });
  const mine = owedRows.find((r) => r.doctorId === D);
  log('   Command finance  (getOwedByDoctor):        owed = ' + mine.owedEgp + ' (cases ' + mine.owedCasesEgp + ' + addons ' + mine.owedAddonsEgp + ')');
  assert.strictEqual(mine.owedEgp, HAND.owedTotal, 'Command owed');
  assert.strictEqual(mine.owedCasesEgp, HAND.mainOwed, 'Command owed case split');
  assert.strictEqual(mine.owedAddonsEgp, HAND.addonOwed, 'Command owed addon split');

  const globalOwed = await reader.getGlobalOwedTotals();
  log('   web admin tile   (getGlobalOwedTotals):    owedTotal = ' + globalOwed.owedTotalEgp);
  assert.strictEqual(globalOwed.owedTotalEgp, HAND.owedTotal, 'global owed');

  const analytics = await reader.getDoctorTotalEarned(D);
  log('   doctor analytics (getDoctorTotalEarned):   total = ' + analytics);
  assert.strictEqual(analytics, HAND.owedTotal, 'analytics total (pending+paid)');

  log('   ✓ five surfaces, one number — and the reassigned case is 0 on every one of them');
  log('');

  // ── 2. THE CAIRO BOUNDARY ────────────────────────────────────────────────
  log('── 2. The Cairo month boundary ──');
  const stmt = await reader.getDoctorMonthlyStatement(D, { limitMonths: 24 });
  // node-pg parses the ::date month as a JS Date; format it in UTC (the
  // process zone the app pins) rather than trusting String().
  const monthOf = (row) => new Date(row.month).toISOString().slice(0, 7);
  const aug = stmt.main.find((m) => monthOf(m) === '2026-08');
  const sep = stmt.main.find((m) => monthOf(m) === '2026-09');
  log('   statement: 2026-08 main total = ' + (aug && Number(aug.total)) + ' | 2026-09 main total = ' + (sep && Number(sep.total)));
  assert.ok(aug && money(Number(aug.total)) === 100, 'the 23:30-Cairo row lands in August, alone');
  // The 00:30-Cairo row joins the CURRENT September bucket alongside the
  // current-month completions: 600 + 870 + 600 + 200 = 2270.
  assert.ok(sep && money(Number(sep.total)) === 2270, 'the 00:30-Cairo row lands in September (2270 = 600+870+600+200)');

  const series = await reader.getDoctorMonthlySeries(D, {});
  const sAug = series.find((r) => r.month === '2026-08');
  const sSep = series.find((r) => r.month === '2026-09');
  log('   analytics series: 2026-08 = ' + (sAug && sAug.earnings) + ' EGP / ' + (sAug && sAug.cases) + ' case; 2026-09 = ' + (sSep && sSep.earnings) + ' EGP');
  assert.ok(sAug && sAug.earnings === 100 && sAug.cases === 1, 'series splits the pair the same way');
  assert.ok(sSep && sSep.earnings === 2270, 'series September agrees with the statement');

  // The month-end payout respects the same boundary: paying August stamps
  // ONLY the August row.
  const aug1 = await writer.markMonthEndPaid({ month: '2026-08', doctorId: D, actor: 'verify' });
  log('   markMonthEndPaid(2026-08): stamped ' + aug1.caseRows + ' row(s), ' + aug1.caseEgp + ' EGP');
  assert.strictEqual(aug1.caseRows, 1, 'exactly the August row');
  assert.strictEqual(aug1.caseEgp, 100, 'the August 100, never the September 200');
  const sepRow = await queryOne(`SELECT status FROM doctor_earnings WHERE appointment_id = 'vb-o-sep'`);
  assert.strictEqual(sepRow.status, 'pending', 'the 00:30-Cairo row is untouched by the August payout');
  const aug2 = await writer.markMonthEndPaid({ month: '2026-08', doctorId: D, actor: 'verify' });
  assert.strictEqual(aug2.caseRows, 0, 're-running the month is a no-op');
  log('   ✓ 23:30 Cairo vs 00:30 Cairo fall in different months on the statement, the series and the payout run');
  log('');

  // ── 3. (Pause-counter equivalence runs in tests/finance/reassignment-
  //        earnings.test.js against this same DB — see the runner output.) ──

  // ── 4. IDEMPOTENCY — submit the same report twice ────────────────────────
  log('── 4. Idempotency: the same report submitted twice ──');
  await seedOrder({ id: 'vb-o-submit', fee: 400, uplift: 0 });
  await writer.writePendingForCase('vb-o-submit');
  const fields = { diagnosisText: 'Findings text.', impressionText: 'Impression text.', recommendationsText: 'Rest.' };

  const s1 = await submitDoctorReport(Object.assign({ orderId: 'vb-o-submit', doctorId: D }, fields));
  assert.ok(s1.ok && s1.completed, 'first submit completes: ' + JSON.stringify(s1));
  const s2 = await submitDoctorReport(Object.assign({ orderId: 'vb-o-submit', doctorId: D }, fields));
  assert.ok(s2.ok && s2.alreadyCompleted, 'second submit reports alreadyCompleted: ' + JSON.stringify(s2));

  const exportsN = await queryOne(`SELECT COUNT(*)::int AS n FROM report_exports WHERE case_id = 'vb-o-submit'`);
  const evtN = await queryOne(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = 'vb-o-submit' AND label = 'order_completed'`);
  const earnN = await queryOne(`SELECT COUNT(*)::int AS n, MIN(status) AS st FROM doctor_earnings WHERE appointment_id = 'vb-o-submit'`);
  const notified = notifyCalls.filter((c) => c.orderId === 'vb-o-submit' && c.template === 'report_ready_patient').length;
  const ordRow = await queryOne(`SELECT status, report_url FROM orders WHERE id = 'vb-o-submit'`);
  log('   report_exports rows: ' + exportsN.n + ' | order_completed events: ' + evtN.n +
      ' | earnings rows: ' + earnN.n + ' (status ' + earnN.st + ') | patient notifications: ' + notified +
      ' | PDF renders: ' + pdfCalls);
  assert.strictEqual(exportsN.n, 1, 'ONE report record');
  assert.strictEqual(evtN.n, 1, 'ONE completion event');
  assert.strictEqual(earnN.n, 1, 'ONE earnings row');
  assert.strictEqual(earnN.st, 'pending', 'settled at pending — paid is the month-end payout\'s');
  assert.strictEqual(notified, 1, 'ONE patient notification');
  assert.strictEqual(ordRow.status, 'completed', 'ONE status change');
  assert.ok(ordRow.report_url, 'report_url stored');
  log('   ✓ one report, one status change, one earnings row, one patient notification');

  // And a genuinely CONCURRENT double submit on a fresh case.
  await seedOrder({ id: 'vb-o-race', fee: 400, uplift: 0 });
  await writer.writePendingForCase('vb-o-race');
  const [r1, r2] = await Promise.all([
    submitDoctorReport(Object.assign({ orderId: 'vb-o-race', doctorId: D }, fields)),
    submitDoctorReport(Object.assign({ orderId: 'vb-o-race', doctorId: D }, fields)),
  ]);
  const winners = [r1, r2].filter((r) => r.ok && r.completed).length;
  const raceExports = await queryOne(`SELECT COUNT(*)::int AS n FROM report_exports WHERE case_id = 'vb-o-race'`);
  const raceNotifs = notifyCalls.filter((c) => c.orderId === 'vb-o-race').length;
  log('   concurrent race: winners = ' + winners + ' | report_exports = ' + raceExports.n + ' | notifications = ' + raceNotifs);
  assert.strictEqual(winners, 1, 'exactly one racer wins the conditional flip');
  assert.strictEqual(raceExports.n, 1, 'one report record under the race');
  assert.strictEqual(raceNotifs, 1, 'one notification under the race');
  log('   ✓ a true concurrent double-submit still yields exactly one of everything');
  log('');

  // ── 5. ATOMICITY — force the status change to fail ───────────────────────
  log('── 5. Atomicity: the status change itself fails ──');
  await seedOrder({ id: 'vb-o-atomic', fee: 400, uplift: 0 });
  await writer.writePendingForCase('vb-o-atomic');
  await execute(`INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at) VALUES ('vb-da-1', 'vb-o-atomic', $1, NOW())`, [D]);
  const preEarn = await queryOne(`SELECT status, earned_amount FROM doctor_earnings WHERE appointment_id = 'vb-o-atomic'`);

  await execute(`
    CREATE OR REPLACE FUNCTION vb_block_complete() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'completed' THEN RAISE EXCEPTION 'verification: completion blocked'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await execute(`CREATE TRIGGER vb_block_complete BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION vb_block_complete()`);

  const notifsBefore = notifyCalls.length;
  const blocked = await submitDoctorReport(Object.assign({ orderId: 'vb-o-atomic', doctorId: D }, fields));
  assert.strictEqual(blocked.ok, false, 'submission reports failure');
  assert.strictEqual(blocked.code, 'report_complete_failed', 'the completion failure code');

  await execute(`DROP TRIGGER vb_block_complete ON orders`);

  const aOrd = await queryOne(`SELECT status FROM orders WHERE id = 'vb-o-atomic'`);
  const aExp = await queryOne(`SELECT COUNT(*)::int AS n FROM report_exports WHERE case_id = 'vb-o-atomic'`);
  const aEvt = await queryOne(`SELECT COUNT(*)::int AS n FROM order_events WHERE order_id = 'vb-o-atomic' AND label = 'order_completed'`);
  const aAsg = await queryOne(`SELECT completed_at FROM doctor_assignments WHERE id = 'vb-da-1'`);
  const aEarn = await queryOne(`SELECT status, earned_amount FROM doctor_earnings WHERE appointment_id = 'vb-o-atomic'`);
  const aText = await queryOne(`SELECT diagnosis_text FROM orders WHERE id = 'vb-o-atomic'`);
  log('   status: ' + aOrd.status + ' | report_exports: ' + aExp.n + ' | completion events: ' + aEvt.n +
      ' | assignment closed: ' + (aAsg.completed_at ? 'YES' : 'no') +
      ' | earnings: ' + aEarn.status + '/' + aEarn.earned_amount + ' (was ' + preEarn.status + '/' + preEarn.earned_amount + ')' +
      ' | notifications sent: ' + (notifyCalls.length - notifsBefore));
  assert.notStrictEqual(String(aOrd.status).toLowerCase(), 'completed', 'case NOT completed');
  assert.strictEqual(aExp.n, 0, 'no report record landed');
  assert.strictEqual(aEvt.n, 0, 'no completion event landed');
  assert.strictEqual(aAsg.completed_at, null, 'assignment still open');
  assert.strictEqual(Number(aEarn.earned_amount), Number(preEarn.earned_amount), 'earnings untouched');
  assert.strictEqual(notifyCalls.length - notifsBefore, 0, 'no patient notification');
  assert.strictEqual(String(aText.diagnosis_text), 'Findings text.', 'the doctor\'s TEXT survives (draft write is deliberately outside the transaction)');
  log('   ✓ the transaction rolled back whole: nothing landed except the draft text, and the case is retryable');

  // Prove the retry then works.
  const retry = await submitDoctorReport(Object.assign({ orderId: 'vb-o-atomic', doctorId: D }, fields));
  assert.ok(retry.ok && retry.completed, 'retry after the failure completes cleanly');
  log('   ✓ the retry after the failure completes cleanly');
  log('');
  log('══ ALL BATCH B VERIFICATIONS PASSED ══');

  await pool.end();
})().catch(async (e) => {
  console.error('\nVERIFICATION FAILED:', e && e.stack || e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
