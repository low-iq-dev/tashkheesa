// tests/core/unpaid-sweep-rejection-and-ladder.test.js
//
// 2026-10-11 — two loose ends of the 6 Oct unpaid-sweep change (9478ea3), both
// of which only show up by running the sweep against a case with a history.
//
//   1. A transfer claim REJECTED late expired the case under the patient.
//      The expiry clock is last activity (orders.updated_at). Filing a claim
//      touches it; rejecting one does not (services/manual_payment.rejectClaim
//      writes payment_claims only, by design — see manual-payment-claims). A
//      claim pauses expiry while it is pending, so a claim that waited eight
//      days for an answer came back "rejected" onto a clock that had already
//      run out, and the very next tick stamped the case expired_unpaid. The
//      patient was told "we could not match your transfer" and, minutes
//      later, "payment window closed". The anchor is now the later of last
//      activity and the latest rejection, read from the claim row's own
//      resolved_at — in the row decision, the SELECT pre-filter and the
//      expiry UPDATE alike.
//
//   2. The ladder sent only the HIGHEST due reminder level per tick. The
//      dedupe key (notifications.dedupe_key =
//      payment_reminder:<level>:<channel>:<case>:<user>) has no time in it and
//      a lower level is never revisited, so a case the sweep first saw after
//      the 6h mark never got its 30m reminder at all. Each due level goes out
//      once again; dedupe is what stops a repeat.
//
// No database. The sweep is driven in a subprocess with src/pg stubbed before
// case_lifecycle is loaded (the module destructures its query helpers at
// require time) — the same shape as case-label §7.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'mismatch') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

console.log('\n⏳ Unpaid sweep — rejected claim window + reminder ladder\n');

const ROOT = path.join(__dirname, '..', '..');
const cl = require('../../src/case_lifecycle');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-11T12:00:00Z');

function row(status, ageMs, opts) {
  const stamp = new Date(NOW - ageMs).toISOString();
  return Object.assign({ id: 'order-' + status, status: status, created_at: stamp, updated_at: stamp }, opts || {});
}
function ago(ms) { return new Date(NOW - ms).toISOString(); }

// ── 1. A rejection gives a fresh window (pure predicate) ───────────────────
try {
  // Claim filed 8 days ago (that is the last touch of updated_at), rejected an
  // hour ago. Without the fix this row is 8 days old and expires on this tick.
  const lateReject = row('SUBMITTED', 8 * DAY, { payment_claim_pending: false, payment_claim_rejected_at: ago(HOUR) });
  expect(cl.isUnpaidExpiryDue(lateReject, NOW) === false,
    'a claim rejected an hour ago must NOT expire the case, however old its last activity is');
  eq(cl.unpaidTtlHoursRemaining(lateReject, NOW), 7 * 24 - 1,
    'the hold shown to the patient restarts at the rejection (7 days less the hour since)');

  // pg hands timestamptz back as a Date; the helper must take either.
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 8 * DAY, { payment_claim_rejected_at: new Date(NOW - HOUR) }), NOW) === false,
    'a Date-valued rejection time must be read the same as an ISO string');

  // The window is a full TTL from the rejection, not a grace period.
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 20 * DAY, { payment_claim_rejected_at: ago(6 * DAY) }), NOW) === false,
    'six days after the rejection the case is still inside its window');
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 20 * DAY, { payment_claim_rejected_at: ago(7 * DAY + HOUR) }), NOW) === true,
    'the window after a rejection is the same 7 days — it does run out');

  // Later of the two: a rejection OLDER than the last activity changes nothing.
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 8 * DAY, { payment_claim_rejected_at: ago(30 * DAY) }), NOW) === true,
    'an old rejection must not shorten or lengthen a window measured from later activity');
  eq(cl.unpaidTtlHoursRemaining(row('SUBMITTED', 1 * DAY, { payment_claim_rejected_at: ago(3 * DAY) }), NOW), 6 * 24,
    'activity after the rejection is the anchor');

  // No rejection on record: exactly the old behaviour.
  [undefined, null, '', 'not-a-date'].forEach(function (v) {
    expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 8 * DAY, { payment_claim_rejected_at: v }), NOW) === true,
      'payment_claim_rejected_at=' + JSON.stringify(v) + ' must leave expiry on last activity');
    expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 6 * DAY, { payment_claim_rejected_at: v }), NOW) === false,
      'payment_claim_rejected_at=' + JSON.stringify(v) + ' must not expire a 6-day-old case');
  });

  // A pending claim still wins outright (9478ea3), and a rejection never revives
  // a status that has no TTL.
  expect(cl.isUnpaidExpiryDue(row('SUBMITTED', 30 * DAY, { payment_claim_pending: true, payment_claim_rejected_at: ago(20 * DAY) }), NOW) === false,
    'a pending claim holds the case whatever the rejection history says');
  expect(cl.isUnpaidExpiryDue(row('PAID', 30 * DAY, { payment_claim_rejected_at: ago(20 * DAY) }), NOW) === false,
    'statuses without a TTL stay unexpirable');
  t.pass('rejection re-anchors the hold: later of last activity and the claim\'s rejected time, full 7 days');
} catch (e) { t.fail('rejected claim gives a fresh window (predicate)', e); }

// ── 2. The SQL says the same thing as the predicate ────────────────────────
try {
  const sql = cl.buildUnpaidSweepWorkPredicateSql();
  const arms = sql.split(/\n\s*OR /);
  eq(arms.length, 3, 'ladder arm + one expiry arm per TTL status');
  const guard = function (hours) {
    return new RegExp(
      "NOT EXISTS \\(SELECT 1 FROM payment_claims pc WHERE pc\\.order_id::text = orders\\.id::text" +
      " AND pc\\.status = 'rejected'" +
      " AND COALESCE\\(pc\\.resolved_at, pc\\.updated_at\\) > NOW\\(\\) - INTERVAL '" + hours + " hours'\\)");
  };
  expect(/'DRAFT'/.test(arms[1]) && guard(720).test(arms[1]),
    'the DRAFT expiry arm must exclude a case whose claim was rejected inside its 720h window. Got: ' + arms[1]);
  expect(/'SUBMITTED'/.test(arms[2]) && guard(168).test(arms[2]),
    'the SUBMITTED expiry arm must exclude a case whose claim was rejected inside its 168h window. Got: ' + arms[2]);
  expect(!/payment_claims/.test(arms[0]), 'the reminder-ladder arm is not about expiry and must not carry the guard');
  // A database without migration 117 must still get SQL that names no claims table.
  const noClaims = cl.buildUnpaidSweepWorkPredicateSql({ hasPaymentClaims: false });
  expect(!/payment_claims/.test(noClaims) && /INTERVAL '168 hours'/.test(noClaims),
    'hasPaymentClaims:false must drop the guard and keep the arms');

  const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8'));
  const start = CODE.indexOf('async function dispatchUnpaidCaseReminders');
  const sweep = CODE.slice(start, CODE.indexOf('const CASE_STATUS = Object.freeze', start));
  expect(/AS payment_claim_rejected_at/.test(sweep),
    'the sweep SELECT must carry the latest rejection on each row');
  const upd = sweep.slice(sweep.indexOf("SET status = 'expired_unpaid'"));
  expect(/recentRejectedClaimExistsSql\(ttl\.expireAfterHours\)/.test(upd.slice(0, 900)),
    'the expiry UPDATE itself must re-assert "no claim rejected inside the window" (last line of defence)');
  // The rejection time comes from the claim row, never from a write to orders.
  const MP = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'services', 'manual_payment.js'), 'utf8'));
  const reject = MP.slice(MP.indexOf('async function rejectClaim'), MP.indexOf('async function confirmPendingClaimForOrder'));
  expect(/resolved_at = NOW\(\)/.test(reject), 'rejectClaim must stamp payment_claims.resolved_at — it is the anchor');
  expect(!/UPDATE\s+orders/i.test(reject), 'rejectClaim must not write to orders: the window is anchored on the claim row');
  t.pass('pre-filter arms, sweep SELECT and expiry UPDATE all carry the rejected-claim window');
} catch (e) { t.fail('SQL carries the rejected-claim window', e); }

// ── 3 + 4. The sweep itself, against a stubbed database ────────────────────
let res = null;
try {
  const script = `
    const path = require('path');
    const root = ${JSON.stringify(ROOT)};
    const pg = require(path.join(root, 'src', 'pg'));
    const HOUR = 3600 * 1000, DAY = 24 * HOUR;
    const st = { updates: [], inserts: [], keys: new Set(), sweepSql: [], rejectedLookup: null, rejectedLookups: 0 };
    pg.queryOne = async function (sql, params) {
      if (/information_schema\\.columns/i.test(sql)) return { ok: 1 };
      if (/FROM notifications/i.test(sql) && /dedupe_key = \\$1/.test(sql)) {
        return st.keys.has(params[0]) ? { id: 'n', status: 'queued' } : null;
      }
      if (/FROM payment_claims/i.test(sql) && /'rejected'/.test(sql)) {
        st.rejectedLookups++;
        if (st.rejectedLookup === 'throw') throw new Error('db down');
        return { rejected_at: st.rejectedLookup };
      }
      if (/FROM payment_claims/i.test(sql)) return null;
      if (/FROM users/i.test(sql)) return { id: params[0], lang: 'en', role: 'patient' };
      if (/SELECT reference_id FROM orders/i.test(sql)) return { reference_id: 'TSH-2026-000017' };
      return null;
    };
    pg.queryAll = async function (sql) { st.sweepSql.push(sql); return []; };
    pg.execute = async function (sql, params) {
      if (/SET status = 'expired_unpaid'/.test(sql)) { st.updates.push(sql); return { rowCount: 1 }; }
      if (/INSERT INTO notifications/i.test(sql)) {
        st.inserts.push({ channel: params[3], template: params[4], key: params[7], response: params[6] });
        if (params[7]) st.keys.add(params[7]);
      }
      return { rowCount: 1 };
    };
    const cl = require(path.join(root, 'src', 'case_lifecycle'));
    const ago = function (ms) { return new Date(Date.now() - ms).toISOString(); };
    const mk = function (id, submittedAgo, over) {
      return Object.assign({
        id: id, status: 'SUBMITTED', patient_id: 'pat-1', reference_id: 'TSH-2026-000017',
        payment_status: 'unpaid', paid_at: null,
        created_at: ago(submittedAgo + HOUR), submitted_at: ago(submittedAgo), updated_at: ago(submittedAgo),
        payment_claim_pending: false, payment_claim_rejected_at: null
      }, over || {});
    };
    const reminders = function (from) {
      return st.inserts.slice(from).filter(function (i) { return /^payment_reminder_/.test(i.template); })
        .map(function (i) { return i.template.replace('payment_reminder_', '') + ':' + i.channel; }).sort();
    };
    (async function () {
      const out = {};
      let r, mark;

      // -- expiry ----------------------------------------------------------
      // A: claim filed 9 days ago (last touch), rejected an hour ago.
      mark = st.updates.length;
      r = await cl.dispatchUnpaidCaseReminders(mk('A', 9 * DAY, { payment_claim_rejected_at: ago(HOUR) }));
      out.A = { skipped: r.skipped, expired: st.updates.length - mark };
      // B: rejected 8 days ago — the fresh window has itself run out.
      mark = st.updates.length;
      r = await cl.dispatchUnpaidCaseReminders(mk('B', 20 * DAY, { payment_claim_rejected_at: ago(8 * DAY) }));
      out.B = { skipped: r.skipped, expired: st.updates.length - mark, sql: st.updates[st.updates.length - 1] || '' };
      // C: never claimed, 8 days idle — unchanged behaviour.
      mark = st.updates.length;
      r = await cl.dispatchUnpaidCaseReminders(mk('C', 8 * DAY));
      out.C = { skipped: r.skipped, expired: st.updates.length - mark };
      // D: a row that did NOT come from the sweep SELECT (no rejection column).
      const bare = function (id) { const o = mk(id, 9 * DAY); delete o.payment_claim_rejected_at; return o; };
      st.rejectedLookup = ago(HOUR); mark = st.updates.length; let looks = st.rejectedLookups;
      r = await cl.dispatchUnpaidCaseReminders(bare('D1'));
      out.D1 = { skipped: r.skipped, expired: st.updates.length - mark, looked: st.rejectedLookups - looks };
      st.rejectedLookup = null; mark = st.updates.length;
      r = await cl.dispatchUnpaidCaseReminders(bare('D2'));
      out.D2 = { skipped: r.skipped, expired: st.updates.length - mark };
      st.rejectedLookup = 'throw'; mark = st.updates.length; let ins = st.inserts.length;
      r = await cl.dispatchUnpaidCaseReminders(bare('D3'));
      out.D3 = { skipped: r.skipped, expired: st.updates.length - mark, queued: st.inserts.length - ins };
      st.rejectedLookup = null;
      // E: the no-argument sweep — what SQL does it send?
      await cl.dispatchUnpaidCaseReminders();
      out.E = { sql: st.sweepSql[st.sweepSql.length - 1] || '' };
      // F: rejected inside the ladder window — the 24h reminder states the NEW hold.
      ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('F', 24 * HOUR + 20 * 60 * 1000, { payment_claim_rejected_at: ago(10 * 60 * 1000) }));
      const f24 = st.inserts.slice(ins).filter(function (i) { return i.template === 'payment_reminder_24h' && i.channel === 'internal'; })[0];
      out.F = { hours: f24 ? JSON.parse(f24.response).hours_remaining : null };

      // -- ladder ----------------------------------------------------------
      // G: first seen 7h after submission, nothing sent before.
      ins = st.inserts.length;
      r = await cl.dispatchUnpaidCaseReminders(mk('G', 7 * HOUR));
      out.G = { sent: reminders(ins), sentCount: r.sentCount };
      // H: the next tick, same case — dedupe, nothing new.
      ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('G', 7 * HOUR + 15 * 60 * 1000));
      out.H = { sent: reminders(ins) };
      // I: a case that walks the ladder tick by tick gets each level once.
      ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('I', 10 * 60 * 1000));
      out.I0 = { sent: reminders(ins) }; ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('I', 31 * 60 * 1000));
      out.I1 = { sent: reminders(ins) }; ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('I', 6 * HOUR + 60 * 1000));
      out.I2 = { sent: reminders(ins) }; ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('I', 24 * HOUR + 60 * 1000));
      out.I3 = { sent: reminders(ins) };
      // J: first seen after the 24h mark — every level at once (the burst).
      ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('J', 24 * HOUR + 30 * 60 * 1000));
      out.J = { sent: reminders(ins) };
      // K: claim pending across the 30m and 6h marks, then rejected.
      ins = st.inserts.length;
      r = await cl.dispatchUnpaidCaseReminders(mk('K', 7 * HOUR, { payment_claim_pending: true }));
      out.K0 = { sent: reminders(ins), skipped: r.skipped }; ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('K', 7 * HOUR, { payment_claim_rejected_at: ago(60 * 1000) }));
      out.K1 = { sent: reminders(ins) };
      // L: a draft is still never chased, at any age.
      ins = st.inserts.length;
      await cl.dispatchUnpaidCaseReminders(mk('L', 7 * HOUR, { status: 'DRAFT', submitted_at: null }));
      out.L = { sent: reminders(ins) };

      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    })().catch(function (e) { console.log('RESULT ' + JSON.stringify({ error: String(e && e.stack || e) })); process.exit(0); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 120000,
    // stderr captured, not inherited: the push module's own pool has nothing
    // to connect to here and says so on every call.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:1/stub' })
  });
  const line = out.split('\n').filter(function (l) { return l.indexOf('RESULT ') === 0; })[0];
  expect(line, 'subprocess produced no result:\n' + out.slice(-800));
  res = JSON.parse(line.slice(7));
  expect(!res.error, 'subprocess threw: ' + res.error);
} catch (e) { t.fail('sweep subprocess', e); }

// ── 3. Expiry, as the sweep does it ────────────────────────────────────────
try {
  expect(res, 'no subprocess result');
  eq(res.A.expired, 0, 'A: a case whose claim was rejected an hour ago must not be written expired_unpaid');
  expect(res.A.skipped !== 'expired_unpaid', 'A: the sweep must not report the case expired; got ' + res.A.skipped);
  eq(res.B.expired, 1, 'B: once the 7 days after the rejection have passed, the case does expire');
  expect(/pc\.status = 'rejected'/.test(res.B.sql) && /INTERVAL '168 hours'/.test(res.B.sql),
    'B: the expiry UPDATE must carry the rejected-claim window guard. Got: ' + res.B.sql);
  expect(/pc\.status = 'pending'/.test(res.B.sql), 'B: and still the pending-claim guard');
  eq(res.C.expired, 1, 'C: a case that was never claimed still expires on last activity');

  eq(res.D1.looked, 1, 'D: a row without the column must ask the claims table for the latest rejection');
  eq(res.D1.expired, 0, 'D: and honour what it says');
  eq(res.D2.expired, 1, 'D: no rejection on record → expires as before');
  eq(res.D3.expired, 0, 'D: a failed lookup must not expire the case on this tick');
  eq(res.D3.skipped, 'payment_claim_lookup_failed', 'D: and says why it stood down');
  eq(res.D3.queued, 0, 'D: nothing is queued on a tick that could not read the claim history');

  expect(/AS payment_claim_rejected_at/.test(res.E.sql), 'E: the sweep SELECT must project the latest rejection');
  expect(/MAX\(COALESCE\(pc\.resolved_at, pc\.updated_at\)\)/.test(res.E.sql) && /pc\.status = 'rejected'/.test(res.E.sql),
    'E: read from the claim row\'s own resolved time');
  expect((res.E.sql.match(/AND COALESCE\(pc\.resolved_at, pc\.updated_at\) > NOW\(\) - INTERVAL/g) || []).length === 2,
    'E: both expiry arms of the pre-filter carry the window guard');

  expect(res.F.hours >= 167 && res.F.hours <= 168,
    'F: a reminder sent after a rejection must state the hold from the rejection (about 168h), not from the ' +
    'claim\'s filing; got ' + res.F.hours);
  t.pass('sweep: late rejection does not expire; window runs 7 days from the rejection; lookup failure stands down');
} catch (e) { t.fail('late rejection does not expire the case (sweep)', e); }

// ── 4. The ladder: every due level once, never twice ───────────────────────
try {
  expect(res, 'no subprocess result');
  const all = function (levels) {
    const o = [];
    levels.forEach(function (l) { ['email', 'internal', 'whatsapp'].forEach(function (c) { o.push(l + ':' + c); }); });
    return o.sort().join(',');
  };
  eq(res.G.sent.join(','), all(['30m', '6h']),
    'a case first seen 7h after submission must get BOTH due levels — the 30m reminder is otherwise lost for good');
  eq(res.G.sentCount, 6, 'two levels on three channels');
  eq(res.H.sent.length, 0, 'the next tick must send nothing: each (level, channel) is deduped');

  eq(res.I0.sent.length, 0, 'nothing before 30 minutes');
  eq(res.I1.sent.join(','), all(['30m']), 'tick by tick: 30m');
  eq(res.I2.sent.join(','), all(['6h']), 'tick by tick: 6h only — 30m is already sent');
  eq(res.I3.sent.join(','), all(['24h']), 'tick by tick: 24h only');

  // Stated, not hidden: this is the cost of not losing a level.
  eq(res.J.sent.join(','), all(['24h', '30m', '6h']),
    'a case first seen after 24h gets all three levels in one tick (9 rows)');

  eq(res.K0.sent.length, 0, 'no reminder while a claim is pending');
  eq(res.K0.skipped, 'payment_claim_pending', 'and the sweep says so');
  eq(res.K1.sent.join(','), all(['30m', '6h']), 'after the rejection every level that fell due while paused goes out');
  eq(res.L.sent.length, 0, 'a DRAFT is never chased');

  const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8'));
  expect(/`payment_reminder:\$\{level\}:\$\{channel\}:\$\{caseId\}:\$\{userId\}`/.test(CODE),
    'the dedupe key must stay payment_reminder:<level>:<channel>:<case>:<user> — it is what makes "once" true');
  t.pass('ladder: each due level once per channel; repeat ticks send nothing; pause then rejection catches up');
} catch (e) { t.fail('reminder ladder sends each due level once', e); }
