// tests/core/dashboard-earnings-honest.test.js
//
// A10 (AUDIT 2026-09-09) — the doctor dashboard "Earnings this month" tile must
// agree with the earnings page. It used to SUM orders.doctor_fee for completed
// cases: the full fee, ignoring the uplift share, add-ons and clawbacks, so it
// showed money the doctor will not be paid (up to 5x reality). It now reads
// earned_amount from the SAME doctor_earnings (+ addon_earnings) source the
// /portal/doctor/earnings page uses, with the same Approved / Not-yet-approved
// split — and never the words "paid out" / "transferred" (doctor_earnings.status
// flips to 'paid' at report submission, not when money moves).
//
// Source-grep. Verified NEGATIVELY: restoring the SUM(doctor_fee) tile query
// fails the "reads doctor_earnings" assertion.

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

check('the tile earnings come from doctor_earnings + addon_earnings', () => {
  if (!mBody) return 'month-metrics block not found';
  if (!/FROM doctor_earnings/.test(mBody)) return 'tile does not read doctor_earnings';
  if (!/FROM addon_earnings/.test(mBody)) return 'tile does not read addon_earnings';
  if (!/earned_amount/.test(mBody)) return 'tile does not sum earned_amount';
});

check('the tile no longer sums orders.doctor_fee as the earnings figure', () => {
  if (/SUM\(doctor_fee\)[\s\S]{0,80}AS earnings_this_month/.test(mBody)) {
    return 'tile still sums orders.doctor_fee (the full-fee bug)';
  }
});

check('the tile splits Approved vs Not-yet-approved from the ledger status', () => {
  if (!/status = 'paid'/.test(mBody)) return 'no Approved (paid) split';
  if (!/status IN \('pending', 'reassigned'\)/.test(mBody)) return 'no Not-yet-approved (pending) split';
  if (!/earningsApproved/.test(mBody) || !/earningsNotYetApproved/.test(mBody)) return 'the split is not surfaced to the view';
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
