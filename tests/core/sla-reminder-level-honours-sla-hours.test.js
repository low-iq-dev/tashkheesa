// tests/core/sla-reminder-level-honours-sla-hours.test.js
//
// Part B item 10 (2026-09-13) — SLA reminders overstated the time left.
//
// dispatchSlaReminders picked the tightest of three fixed windows (24h / 6h /
// 1h) the remaining time was under, with no regard for the order's own SLA.
// An urgent 4-hour case is under the 6h window from the moment it is
// accepted, so its first reminder said "due in about 6 hours"; a VIP 18-hour
// case was told "about 24". The level is now capped by sla_hours: only a
// window strictly shorter than the whole SLA can be sent.
//
// Pure-unit on pickSlaReminderLevel + a structural pin that the dispatcher
// uses it with orderRow.sla_hours. Verified NEGATIVELY: dropping the
// `t.seconds < slaSeconds` filter fails the urgent and VIP cases.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');
const { pickSlaReminderLevel } = require('../../src/case_lifecycle');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n⏳ Part B-10 — SLA reminder level honours the order\'s own SLA\n');

const ROOT = path.join(__dirname, '..', '..');
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
const H = 3600;
const lvl = (s, h) => { const r = pickSlaReminderLevel(s, h); return r ? r.level : null; };

check('urgent 4h case with 3h50m left: NO reminder (the 6h window is longer than the whole SLA)', () => {
  if (lvl(3.83 * H, 4) !== null) return 'got ' + lvl(3.83 * H, 4);
});
check('urgent 4h case with 55m left: the 1h reminder', () => {
  if (lvl(0.9 * H, 4) !== '1h') return 'got ' + lvl(0.9 * H, 4);
});
check('VIP 18h case with 17h left: NO reminder (not "within 24 hours")', () => {
  if (lvl(17 * H, 18) !== null) return 'got ' + lvl(17 * H, 18);
});
check('VIP 18h case with 5h left: the 6h reminder', () => {
  if (lvl(5 * H, 18) !== '6h') return 'got ' + lvl(5 * H, 18);
});
check('standard 72h case: 30h left → nothing yet; 20h → 24h; 5h → 6h; 30m → 1h (tightest only)', () => {
  const got = [lvl(30 * H, 72), lvl(20 * H, 72), lvl(5 * H, 72), lvl(0.5 * H, 72)];
  const want = [null, '24h', '6h', '1h'];
  if (JSON.stringify(got) !== JSON.stringify(want)) return 'got ' + JSON.stringify(got);
});
check('a legacy row with no sla_hours keeps the old behaviour (no cap)', () => {
  if (lvl(20 * H, null) !== '24h' || lvl(20 * H, 0) !== '24h') return 'cap applied without an SLA';
});
check('a non-numeric remaining time yields null, never a level', () => {
  if (lvl(NaN, 4) !== null || lvl(undefined, 4) !== null) return 'garbage produced a level';
});
check('dispatchSlaReminders picks its level through the helper, with the order\'s sla_hours', () => {
  const LC = stripComments(fs.readFileSync(path.join(ROOT, 'src/case_lifecycle.js'), 'utf8'));
  const fn = LC.slice(LC.indexOf('async function dispatchSlaReminders('), LC.indexOf('let _slaReminderSweepRunning'));
  if (!/pickSlaReminderLevel\(secondsRemaining, orderRow\.sla_hours\)/.test(fn)) return 'dispatcher does not use the helper with sla_hours';
  if (/dueThresholds/.test(fn)) return 'the old uncapped bucket selection is still present';
});
