// tests/auth/practice-cases-isolation.test.js
//
// AUDIT-PRACTICE-CASES-2026-09-22
//
// Practice cases are real rows in the doctor's real queue, so onboarding
// doctors learn the real interface rather than a mock of it. That is the whole
// point - and it is also the whole danger, because every query that counts a
// doctor's orders would count them too.
//
// These tests pin the exclusions. The money one matters most: finance already
// has eight aggregations of "owed" that disagree with each other, and a pending
// earnings row for a case nobody paid for would be indistinguishable from a
// real one without joining back to orders.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧪 AUDIT-PRACTICE-CASES - training cases never become money or metrics\n');

const writer = fs.readFileSync(path.join(__dirname, '../../src/services/earnings_writer.js'), 'utf8');
const doctor = fs.readFileSync(path.join(__dirname, '../../src/routes/doctor.js'), 'utf8');

// 1. THE MONEY GUARANTEE - the one that must never regress.
try {
  const fn = writer.slice(writer.indexOf('async function writePendingForCase'),
                          writer.indexOf('async function', writer.indexOf('async function writePendingForCase') + 10));
  assert.ok(/is_practice === true\)\s*return\s*\{\s*skipped:\s*'practice_case'/.test(fn),
    'writePendingForCase does not bail out on a practice case');
  // the guard must sit BEFORE the insert, not after it
  const guardAt = fn.indexOf("skipped: 'practice_case'");
  const insertAt = fn.indexOf('INSERT INTO doctor_earnings');
  assert.ok(guardAt > -1, 'guard missing');
  assert.ok(insertAt === -1 || guardAt < insertAt,
    'the practice guard sits AFTER the doctor_earnings insert - it would not prevent the row');
  t.pass('a practice case can never create a doctor_earnings row');
} catch (e) { t.fail('a practice case can never create a doctor_earnings row', e); }

// 2. The flag has to be readable, or the guard can never be true.
try {
  assert.ok(/o\.is_practice/.test(writer),
    'loadEarningsOrderRow does not select is_practice, so the guard reads undefined and never fires');
  t.pass('earnings_writer actually selects is_practice');
} catch (e) { t.fail('earnings_writer actually selects is_practice', e); }

// 3. All FOUR earnings inserts accounted for. The first draft of this test
//    asserted there was only one and was wrong - there are four, and the
//    important one was settleCaseEarningsOnCompletion, which fires when the
//    doctor SUBMITS THE REPORT. That is exactly what practising looks like.
//
//    Two are guarded outright. The other two are unreachable for a practice
//    case by construction, and this test states why so the reasoning is
//    checkable rather than remembered:
//      - markReassignedOnReassignment bails with 'no_main_row' when no
//        earnings row exists, and a practice case never creates one.
//      - writeVideoAppointmentEarning is keyed on a video appointment, and
//        practice cases are seeded with video off.
try {
  const inserts = (writer.match(/INSERT INTO doctor_earnings/gi) || []).length;
  assert.strictEqual(inserts, 4,
    `earnings_writer now has ${inserts} inserts, not the 4 this test was written against - a new one needs its own practice guard or a documented reason it cannot fire`);

  const guards = (writer.match(/is_practice === true\)\s*return\s*\{\s*skipped:\s*'practice_case'/g) || []).length;
  assert.strictEqual(guards, 2,
    `expected 2 practice guards (acceptance + settlement), found ${guards}`);

  const settle = writer.slice(writer.indexOf('async function settleCaseEarningsOnCompletion'));
  const gAt = settle.indexOf("skipped: 'practice_case'");
  const iAt = settle.indexOf('INSERT INTO doctor_earnings');
  assert.ok(gAt > -1 && gAt < iAt,
    'the settlement guard does not sit before its insert - a completed practice case would still mint a payable');

  assert.ok(/no_main_row/.test(writer),
    'markReassignedOnReassignment no longer bails on a missing main row, so it may now create one for a practice case');
  t.pass('all 4 earnings inserts are guarded or provably unreachable');
} catch (e) { t.fail('all 4 earnings inserts are guarded or provably unreachable', e); }

// 4. Dashboard stats a doctor is judged on must exclude practice.
[
  ["streak, completed last 7 days (updated_at)", "updated_at >= NOW() - INTERVAL '7 days'"],
  ["streak, completed last 7 days (completed_at)", "completed_at >= NOW() - INTERVAL '7 days'"],
].forEach(function (row) {
  const label = row[0], anchor = row[1];
  try {
    const at = doctor.indexOf(anchor);
    assert.ok(at > -1, label + ': query not found - did it move?');
    const block = doctor.slice(Math.max(0, at - 400), at + 80);
    assert.ok(/NOT is_practice/.test(block), label + ': missing the NOT is_practice guard');
    t.pass('excluded from ' + label);
  } catch (e) { t.fail('excluded from ' + label, e); }
});

// 5. The month KPI, SLA compliance and turnaround aggregations.
[
  ['month KPI (completed this month)', "COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'completed') AS completed_this_month"],
  ['SLA compliance + avg turnaround', 'COUNT(*) FILTER (WHERE breached_at IS NULL) AS met_sla'],
  ['30-day average turnaround', 'AVG(EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 3600.0)'],
].forEach(function (row) {
  const label = row[0], anchor = row[1];
  try {
    const at = doctor.indexOf(anchor);
    assert.ok(at > -1, label + ': anchor not found - did the query change?');
    const block = doctor.slice(at, at + 700);
    assert.ok(/NOT is_practice/.test(block), label + ': missing the NOT is_practice guard');
    t.pass('excluded from ' + label);
  } catch (e) { t.fail('excluded from ' + label, e); }
});

// 6. The account-complete panel must survive seeding.
//    It hides as soon as a doctor holds any order, so without this guard,
//    seeding practice cases would switch off the panel shipped the same week.
try {
  const at = doctor.indexOf('COUNT(*)::int AS c FROM orders WHERE doctor_id');
  assert.ok(at > -1, 'the ready-banner order count is gone');
  const line = doctor.slice(at, at + 200);
  assert.ok(/NOT is_practice/.test(line),
    'the account-complete panel counts practice cases, so seeding would hide it');
  t.pass('practice cases do not suppress the account-complete panel');
} catch (e) { t.fail('practice cases do not suppress the account-complete panel', e); }

// 7. The doctor must still SEE them - the queue listings stay unguarded.
//    If someone "helpfully" adds NOT is_practice to the queue, the cases become
//    invisible and the whole exercise is pointless.
try {
  const qAt = doctor.indexOf('FROM orders_active o');
  assert.ok(qAt > -1, 'queue listing not found');
  const q = doctor.slice(qAt, qAt + 400);
  assert.ok(!/NOT is_practice/.test(q),
    'the doctor queue now filters out practice cases - doctors would never see them');
  t.pass('the doctor queue still shows practice cases');
} catch (e) { t.fail('the doctor queue still shows practice cases', e); }
