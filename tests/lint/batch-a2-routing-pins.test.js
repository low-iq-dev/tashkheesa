'use strict';
// Batch A2 (2026-09-21) — source pins for the routing/eligibility fixes.
//
// Each pin holds a line of the fix in place: the canonical-helper call that
// replaced a local re-implementation, or the banned shape of the defect. The
// semantic halves live in tests/core/a2-eligibility-parity.test.js; these
// pins make sure the wiring that CALLS those helpers does not quietly revert.
//
// Runner-harness style (global._testRunner), NOT node:test: tests/run.js —
// the suite the baseline gates on — tallies only this harness.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
function check(name, fn) {
  try { fn(); t.pass(name); } catch (err) { t.fail(name, err); }
}

console.log('\n📌 A2 — routing/eligibility source pins\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Slice a top-level `async function name(...) { ... }` out of a source file by
// brace counting, so a ban scoped to one function cannot false-positive on the
// rest of a 5000-line file.
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

check('A2-1 (X4): broadcast capacity comes from capFor + doctorLoadSql — the local column-picking is gone', () => {
  const src = read('src/notify/broadcast.js');
  // the canonical calls
  assert.ok(src.includes("require('../services/doctor_eligibility')") && src.includes('capFor('),
    'broadcast no longer calls capFor');
  assert.ok(src.includes('doctorLoadSql('), 'broadcast no longer counts load with doctorLoadSql');
  // the banned shapes: the VIP-on-urgent-column ternary and its private defaults
  assert.ok(!src.includes('capColumn'), 'the local cap-column picking is back in broadcast');
  assert.ok(!/max_active_cases_urgent'\s*:\s*'max_active_cases/.test(src),
    'the VIP→max_active_cases_urgent ternary is back in broadcast');
  assert.ok(!src.includes('defaultCap'), 'the private 5/8 cap defaults are back in broadcast');
  // the banned load predicate (exclusion list) — the load is doctorLoadSql now.
  // Matched on the SQL shape (LOWER(...) NOT IN) so the explanatory comment
  // that names the old exclusion does not trip it.
  assert.ok(!/LOWER\(o\.status\) NOT IN/.test(src),
    'the hand-typed exclusion-list load count is back in broadcast');
});

check('A2-2 (X5): broadcast filters the fan-out on sla_tiers_supported with auto_assign\'s predicate', () => {
  const src = read('src/notify/broadcast.js');
  assert.ok(src.includes(`COALESCE(u.sla_tiers_supported, '["standard"]'::jsonb) ?| $2`),
    'the tier predicate left the broadcast query');
  assert.ok(src.includes("require('../auto_assign')") && src.includes('tierSpellings('),
    'broadcast no longer takes its tier vocabulary from auto_assign.tierSpellings');
});

check('A2-2 (X5): every pool arm of the queue/dashboard queries carries the tier clause', () => {
  const src = read('src/routes/doctor.js');
  // the derivation helpers are the ones from doctor_eligibility
  assert.ok(src.includes('allowedOrderTierValues') && src.includes('orderTierSql'),
    'doctor.js no longer derives the pool tier clause from doctor_eligibility');
  // one clause builder, four users
  const uses = (src.match(/poolTierClause\(doctorSlaTiers/g) || []).length;
  assert.ok(uses >= 4,
    `expected the tier clause in all 4 pool queries (countPortalCasesUnassigned, buildPortalCasesUnassigned, countQueueNewCases, buildQueueNewCasesPaged); found ${uses}`);
  // and both handlers read the switches LIVE
  const reads = (src.match(/readDoctorSlaTiersRaw\(doctorId\)/g) || []).length;
  assert.ok(reads >= 2, 'the dashboard/queue handlers no longer read the live tier switches');
});

check('A2-3 (X8): the reassignment target picker is a composition of the canonical helpers', () => {
  const src = read('src/routes/doctor.js');
  const fn = sliceFunction(src, 'findNextAvailableDoctor');
  assert.ok(fn.includes('eligibleDoctorsFor({'),
    'the picker no longer routes through auto_assign.eligibleDoctorsFor');
  assert.ok(fn.includes('capFor(row, tier)'),
    'the picker no longer takes each candidate\'s cap from capFor');
  assert.ok(fn.includes('countActiveCasesForDoctor('),
    'the picker no longer counts load with the canonical counter');
  // banned shapes of the old picker
  assert.ok(!fn.includes('MAX_ACTIVE_CASES'),
    'the hardcoded global cap of 4 is back in the picker');
  assert.ok(!fn.includes("'assigned','in_review','rejected_files','breached','sla_breach'"),
    'the hand-typed five-status load count is back in the picker');
  // and the caller hands it the ORDER (tier + service ride along), not a bare specialty
  assert.ok(src.includes('findNextAvailableDoctor(order, doctorId)'),
    'the overflow caller no longer passes the order to the picker');
});

check('A2-4 (A4/S5): slot_notes is withheld until accept, on every side path', () => {
  const dca = read('src/services/doctor_case_access.js');
  assert.ok(/'slot_notes',/.test(dca), 'slot_notes left WITHHELD_UNTIL_ACCEPT');

  const doctor = read('src/routes/doctor.js');
  assert.ok(doctor.includes('pendingVideoAppt = redactWithheldUntilAccept(pendingVideoAppt)'),
    'the case page no longer strips the pending video appointment pre-accept');

  const video = read('src/routes/video.js');
  assert.ok(video.includes('redactWithheldUntilAccept(appointment)'),
    'the video appointment page no longer strips the withheld keys for an unaccepted doctor');
  assert.ok(video.includes('redactWithheldUntilAccept(redactPatientIdentity(a))'),
    'the doctor appointments board no longer strips the withheld keys on unaccepted rows');
});

check('A2-5 (A6/S3): reassigning a completed/cancelled/refunded case stays refused, and the operator sees why', () => {
  const cl = read('src/case_lifecycle.js');
  // the allowlist that refuses terminal states — exactly these four may reassign
  assert.ok(cl.includes('[CASE_STATUS.ASSIGNED, CASE_STATUS.IN_REVIEW, CASE_STATUS.SLA_BREACH, CASE_STATUS.REASSIGNED].includes(currentStatus)'),
    'reassignCase\'s status allowlist changed — completed/cancelled/refunded may be movable again');
  assert.ok(cl.includes('Cannot reassign case in status'),
    'reassignCase no longer names the refused status');

  // the operator-facing surface: the throw lands as ?error=reassign_failed.
  // Pinned as the redirect's template literal (fix round S6) — the bare
  // ?error= string also appears in an explanatory comment, which must not be
  // able to satisfy this pin on its own.
  const sa = read('src/routes/superadmin.js');
  assert.ok(sa.includes('res.redirect(`/superadmin/orders/${orderId}?error=reassign_failed`)'),
    'the superadmin reassign catch no longer surfaces the refusal');
  // … and the banner names the refused states rather than reading as a dead click
  const view = read('src/views/superadmin_order_detail.ejs');
  assert.ok(view.includes('completed, cancelled or refunded cases cannot be moved'),
    'the order page banner no longer explains the terminal-state refusal');
  assert.ok(view.includes('reassign_ineligible'),
    'the order page banner no longer renders the ineligible-doctor refusal');
});
