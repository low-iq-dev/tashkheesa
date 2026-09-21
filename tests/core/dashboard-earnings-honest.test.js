// tests/core/dashboard-earnings-honest.test.js
//
// A10 (AUDIT 2026-09-09) — the doctor dashboard "Earnings this month" tile must
// agree with the earnings page. It used to SUM orders.doctor_fee for completed
// cases: the full fee, ignoring the uplift share, add-ons and clawbacks, so it
// showed money the doctor will not be paid (up to 5x reality).
//
// BATCH B (B1, 2026-09-21): the tile now reads through
// services/earnings_reader.getDoctorMonthSummary — the ONE aggregation module
// every surface uses — so the assertions here are (a) the tile calls the
// reader, and (b) the reader itself carries the ledger discipline (both
// ledgers, earned_amount, the paid/pending split, reassigned excluded from
// money). 'Not yet approved' no longer includes 'reassigned': a reassigned
// case earns zero by policy, and summing it showed the doctor money the
// platform would never pay. The view wording rules are unchanged — note that
// under Batch B 'paid' DOES now mean the month-end payout ran, but the tile
// keeps the Approved wording (payout timing lives on the earnings page).
//
// Source-grep. Verified NEGATIVELY: restoring the SUM(doctor_fee) tile query
// fails the "reads through the shared earnings reader" assertion.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💵 A10 — dashboard "Earnings this month" reads the honest ledger\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const doc = code('src/routes/doctor.js');

// Carve out the month-metrics block so the assertions are about the tile, not
// the (legitimate) doctor_fee reads elsewhere in the file.
const mStart = doc.indexOf('var monthMetrics =');
const mBody = mStart >= 0 ? doc.slice(mStart, mStart + 2200) : '';

check('the tile earnings come from the shared earnings reader', () => {
  if (!mBody) return 'month-metrics block not found';
  if (!/earningsReader\.getDoctorMonthSummary/.test(mBody)) {
    return 'tile does not call earningsReader.getDoctorMonthSummary — it must not keep its own SQL';
  }
  if (!/earningsApproved/.test(mBody) || !/earningsNotYetApproved/.test(mBody)) return 'the split is not surfaced to the view';
});

check('the tile no longer sums orders.doctor_fee as the earnings figure', () => {
  if (/SUM\(doctor_fee\)[\s\S]{0,80}AS earnings_this_month/.test(mBody)) {
    return 'tile still sums orders.doctor_fee (the full-fee bug)';
  }
  if (/FROM doctor_earnings|FROM addon_earnings/.test(mBody)) {
    return 'tile grew its own ledger SQL back — every aggregation belongs in services/earnings_reader';
  }
});

// The reader is what carries the discipline the tile used to be asserted on.
const reader = code('src/services/earnings_reader.js');
check('the reader month summary reads both ledgers with the paid/pending split', () => {
  const rStart = reader.indexOf('async function getDoctorMonthSummary');
  const rBody = rStart >= 0 ? reader.slice(rStart, rStart + 2600) : '';
  if (!rBody) return 'getDoctorMonthSummary not found in earnings_reader';
  if (!/FROM doctor_earnings/.test(rBody)) return 'month summary does not read doctor_earnings';
  if (!/FROM addon_earnings/.test(rBody)) return 'month summary does not read addon_earnings';
  if (!/earned_amount/.test(rBody)) return 'month summary does not sum earned_amount';
  if (!/status = 'paid'/.test(rBody)) return 'no Approved (paid) split';
  if (!/status = 'pending'/.test(rBody)) return 'no Not-yet-approved (pending) split';
  if (/status IN \('pending', 'reassigned'\)/.test(rBody)) {
    return "the month summary counts 'reassigned' as money again — a reassigned case earns zero";
  }
});

// The view: the tile's copy matches the earnings page and never claims payout.
const view = fs.readFileSync(path.join(ROOT, 'src/views/portal_doctor_dashboard.ejs'), 'utf8');
check('the tile shows the Approved / Not-yet-approved wording', () => {
  if (!/approved/i.test(view)) return 'view does not show the approved split';
  if (!/not yet approved/i.test(view)) return 'view does not show the not-yet-approved split';
});

check('the tile never says "paid out" or "transferred" (EN or AR)', () => {
  const banned = [/paid out/i, /transferred/i, /قيد التحويل/, /تم التحويل/, /مدفوعة للطبيب/];
  // Strip EJS comments — a <%# ... %> that NAMES the banned words (to warn a
  // future editor off them) is not rendered and must not trip the check.
  const rendered = view.replace(/<%#[\s\S]*?%>/g, '');
  const tStart = rendered.indexOf('Earnings this month');
  const region = tStart >= 0 ? rendered.slice(Math.max(0, tStart - 200), tStart + 400) : rendered;
  for (const re of banned) {
    if (re.test(region)) return 'the earnings tile uses a banned "money moved" phrase: ' + re;
  }
});
