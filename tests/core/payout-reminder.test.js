// tests/core/payout-reminder.test.js
//
// 11 Oct 2026: one reminder near month-end, only when doctors are owed money
// for delivered work, once per month, by WhatsApp and a quiet Command push.
'use strict';
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n💸  month-end doctor payout reminder\n');

const pr = require('../../src/services/payout_reminder');
const ROOT = path.join(__dirname, '..', '..');

// 29 Oct 2026 is a Thursday and the 31st a Saturday; Cairo is UTC+3 that day.
const DUE = new Date('2026-10-29T08:30:00Z');
const OWED = [
  { doctorId: 'a', owedSettleableEgp: 3000, owedInFlightEgp: 600 },
  { doctorId: 'b', owedSettleableEgp: 1200, owedInFlightEgp: 0 },
  { doctorId: 'c', owedSettleableEgp: 0, owedInFlightEgp: 0 },
];

function rig(rows, over) {
  const log = { claims: [], releases: [], wa: [], push: [] };
  const deps = Object.assign({
    now: DUE,
    reader: { getOwedByDoctor: async () => rows },
    claim: async (k) => { log.claims.push(k); return true; },
    release: async (k) => { log.releases.push(k); },
    sendFounder: async (text, o) => { log.wa.push({ text, o }); return { sent: 2, failed: 0 }; },
    pushOpsEvent: async (e) => { log.push.push(e); return { sent: true }; },
  }, over || {});
  return { log, deps };
}

(async function () {
  try {
    const got = [[2026, 10], [2026, 11], [2027, 1], [2027, 2]].map((x) => pr.reminderDay(x[0], x[1])).join(',');
    if (got !== '29,29,31,28') throw new Error('reminder days wrong: ' + got);
    const due = (iso) => pr.isDue(pr.cairoParts(new Date(iso)));
    if (due('2026-10-28T12:00:00Z')) throw new Error('the 28th is before the window');
    if (due('2026-10-29T05:00:00Z')) throw new Error('08:00 Cairo is before the send hour');
    if (!due('2026-10-29T08:30:00Z')) throw new Error('11:30 Cairo on the reminder day should be due');
    if (!due('2026-10-31T12:00:00Z')) throw new Error('a later day in the same month should still be due');
    if (due('2026-11-01T12:00:00Z')) throw new Error('the 1st of next month must not be due');
    t.pass('timing: first working day in the last 3 days of the Cairo month, from 10:00');
  } catch (e) { t.fail('payout reminder: timing', e); }

  try {
    for (const rows of [[], [{ doctorId: 'a', owedSettleableEgp: 0, owedInFlightEgp: 900 }]]) {
      const r = rig(rows);
      const out = await pr.runPayoutReminder(r.deps);
      if (out.skipped !== 'nothing_owed') throw new Error('expected nothing_owed, got ' + JSON.stringify(out));
      if (r.log.claims.length || r.log.wa.length || r.log.push.length) throw new Error('nothing may be claimed or sent when nothing is payable');
    }
    const early = rig(OWED, { now: new Date('2026-10-20T09:00:00Z') });
    if ((await pr.runPayoutReminder(early.deps)).skipped !== 'not_due' || early.log.wa.length) throw new Error('mid-month must not send');
    t.pass('silence: no message mid-month, with nothing owed, or with only undelivered work');
  } catch (e) { t.fail('payout reminder: silence', e); }

  try {
    const r = rig(OWED);
    const out = await pr.runPayoutReminder(r.deps);
    if (!out.delivered || out.month !== '2026-10-01') throw new Error('not delivered: ' + JSON.stringify(out));
    if (r.log.claims.join() !== '2026-10-01' || r.log.releases.length) throw new Error('claim/release wrong');
    const text = r.log.wa[0].text;
    for (const want of ['Month-end is in 2 days (Sat 31 Oct)', 'EGP 4,200 is ready to pay to 2 doctors.', 'EGP 600 more is for cases not delivered yet']) {
      if (text.indexOf(want) === -1) throw new Error('message lacks "' + want + '": ' + text);
    }
    const p = r.log.push[0];
    if (p.kind !== 'payout_reminder' || p.dedupeKey !== '2026-10-01' || p.defaultMode !== 'quiet') throw new Error('push wrong: ' + JSON.stringify(p));
    if (p.body !== 'EGP 4,200 to 2 doctors · month ends Sat 31 Oct') throw new Error('push body wrong: ' + p.body);
    const one = pr.formatReminder(pr.summarise([OWED[1]]), pr.cairoParts(new Date('2026-10-31T12:00:00Z')));
    if (one.indexOf('Month-end is today') === -1 || one.indexOf('to 1 doctor.') === -1 || /not delivered/.test(one)) throw new Error('single-doctor wording wrong: ' + one);
    t.pass('message: total, doctor count, days left, undelivered work shown separately');
  } catch (e) { t.fail('payout reminder: message', e); }

  try {
    const again = rig(OWED, { claim: async () => false });
    if ((await pr.runPayoutReminder(again.deps)).skipped !== 'already_sent' || again.log.wa.length || again.log.push.length) throw new Error('a second run in the month sent again');
    const dead = rig(OWED, { sendFounder: async () => ({ sent: 0, failed: 2 }), pushOpsEvent: async () => ({ sent: false, skipped: 'error' }) });
    const d = await pr.runPayoutReminder(dead.deps);
    if (d.delivered || dead.log.releases.join() !== '2026-10-01') throw new Error('both channels failing must release the claim for a retry');
    const half = rig(OWED, { sendFounder: async () => { throw new Error('gateway down'); } });
    const h = await pr.runPayoutReminder(half.deps);
    if (!h.delivered || half.log.releases.length) throw new Error('one working channel is a delivery; the claim must stay');
    t.pass('once a month: no repeat, retry only when neither channel delivered');
  } catch (e) { t.fail('payout reminder: once-only', e); }

  try {
    const prefs = require('../../src/services/ops_push_prefs');
    if (prefs.effectiveMode('payout_reminder', null) !== 'quiet') throw new Error('payout_reminder should default to quiet');
    const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    if (!/require\('\.\/services\/payout_reminder'\)\.runPayoutReminder\(\)/.test(server)) throw new Error('server.js does not schedule the reminder');
    t.pass('wiring: catalogued as a quiet Command alert and scheduled by the server');
  } catch (e) { t.fail('payout reminder: wiring', e); }
})();
