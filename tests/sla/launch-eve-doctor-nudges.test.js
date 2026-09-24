'use strict';
// tests/sla/launch-eve-doctor-nudges.test.js
//
// 2026-09-24 (launch eve, T7). Doctor nudges in case_sla_worker, each
// threshold driven with a FAKE CLOCK (runDoctorNudges(runAt, deps)) against
// scripted candidates and in-memory dedupe stores. No DB.
//
//   (a) offered, unaccepted: 50% of the acceptance window (Urgent 15m → 7.5m,
//       VIP 45m → 22.5m, Standard 2h → 60m) → doctor bell + WhatsApp + push;
//       two windows after the case became offerable → superadmins.
//   (b) accepted, in review: 50% and 80% of accepted_at → deadline_at →
//       doctor; at 80% also superadmins "at risk".
//   (c) accepted, no draft by 25% → one "start the report" nudge.

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n⏱️  doctor nudges — every threshold on a fake clock\n');

const worker = require('../../src/case_sla_worker');
const T0 = Date.parse('2026-09-24T08:00:00Z'); // 11:00 Cairo — inside the Urgent window
const min = (m) => T0 + m * 60000;
const at = (m) => new Date(min(m));

function harness({ assigned = [], unaccepted = [], review = [] } = {}) {
  const sent = { notifications: [], admins: [], ops: [], push: [], events: [] };
  const bellKeys = new Set();
  const eventKeys = new Set();
  const sqls = [];
  const deps = {
    queryAll: async (sql) => {
      sqls.push(sql);
      if (/JOIN LATERAL/.test(sql)) return assigned;
      if (/o\.paid_at IS NOT NULL/.test(sql)) return unaccepted;
      if (/o\.accepted_at IS NOT NULL/.test(sql)) return review;
      return [];
    },
    queryOne: async (sql, params) => (eventKeys.has(params[0] + '|' + params[1]) ? { '?column?': 1 } : null),
    logCaseEvent: async (caseId, type) => { eventKeys.add(caseId + '|' + type); sent.events.push(type); },
    queueNotification: async (o) => {
      const k = o.dedupe_key + '|' + o.channel + '|' + o.toUserId;
      if (bellKeys.has(k)) return { ok: true, skipped: 'deduped' };
      bellKeys.add(k);
      sent.notifications.push(Object.assign({}, o, { payload: JSON.parse(o.response) }));
      return { ok: true, id: 'n' + sent.notifications.length };
    },
    notifyAdmins: async (o) => { sent.admins.push(o); return []; },
    pushOpsEvent: async (o) => { sent.ops.push(o); return { sent: true }; },
    sendPush: async (userId, msg) => { sent.push.push({ userId, msg }); }
  };
  return { deps, sent, sqls, reset: () => { for (const k of Object.keys(sent)) sent[k].length = 0; } };
}

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  // ── (a) 50% of the acceptance window ─────────────────────────────────
  const urgentOffer = { case_id: 'case-u', doctor_id: 'doc-1', reference_id: 'TSH-2026-000001', doctor_lang: 'ar',
    assigned_at: new Date(min(0)).toISOString(), accept_by_at: new Date(min(15)).toISOString() };

  await check('(a) Urgent: nothing at 7 min (47%)', async () => {
    const h = harness({ assigned: [urgentOffer] });
    const c = await worker.runDoctorNudges(at(7), h.deps);
    if (c.accept !== 0 || h.sent.notifications.length) throw new Error(JSON.stringify(c));
  });

  await check('(a) Urgent: at 7.5 min (50%) → bell + WhatsApp + push to the doctor, "N minutes to accept"', async () => {
    const h = harness({ assigned: [urgentOffer] });
    const c = await worker.runDoctorNudges(new Date(min(7.5)), h.deps);
    if (c.accept !== 1) throw new Error('accept=' + c.accept);
    const channels = h.sent.notifications.map((n) => n.channel).sort().join();
    if (channels !== 'internal,whatsapp') throw new Error('channels ' + channels);
    const n = h.sent.notifications[0];
    if (n.template !== 'doctor_accept_nudge' || n.toUserId !== 'doc-1') throw new Error(JSON.stringify(n));
    if (n.payload.minutes_left !== 8 || n.payload.seconds_remaining !== 450) throw new Error('countdown ' + JSON.stringify(n.payload));
    if (h.sent.push.length !== 1 || !/بانتظارك/.test(h.sent.push[0].msg.title)) throw new Error('push (AR doctor) ' + JSON.stringify(h.sent.push));
    // Same tick again: deduped — nothing new on any surface.
    const again = await worker.runDoctorNudges(new Date(min(9)), h.deps);
    if (again.accept !== 0 || h.sent.notifications.length !== 2 || h.sent.push.length !== 1) throw new Error('not deduped');
  });

  await check('(a) at 100% the nudge stops — the timeout / acceptance watcher owns it', async () => {
    const h = harness({ assigned: [urgentOffer] });
    const c = await worker.runDoctorNudges(at(15), h.deps);
    if (c.accept !== 0) throw new Error('nudged at expiry');
  });

  await check('(a) VIP 45m → 22.5m and Standard 2h → 60m', () => {
    const vip = { case_id: 'v', doctor_id: 'd', assigned_at: new Date(min(0)).toISOString(), accept_by_at: new Date(min(45)).toISOString() };
    if (worker.decideAcceptNudge(vip, min(22))) throw new Error('VIP nudged at 22m');
    if (!worker.decideAcceptNudge(vip, min(22.5))) throw new Error('VIP not nudged at 22.5m');
    const std = { case_id: 's', doctor_id: 'd', assigned_at: new Date(min(0)).toISOString(), accept_by_at: new Date(min(120)).toISOString() };
    if (worker.decideAcceptNudge(std, min(59))) throw new Error('Standard nudged at 59m');
    if (!worker.decideAcceptNudge(std, min(60))) throw new Error('Standard not nudged at 60m');
  });

  await check('(a) a reassignment is a new offer: its own dedupe key', () => {
    const first = worker.decideAcceptNudge(urgentOffer, min(8));
    const second = worker.decideAcceptNudge(Object.assign({}, urgentOffer, {
      assigned_at: new Date(min(20)).toISOString(), accept_by_at: new Date(min(35)).toISOString() }), min(28));
    if (!first || !second || first.dedupeKey === second.dedupeKey) throw new Error('same key across assignments');
  });

  // ── (a) superadmin: one full window after the rebroadcast ─────────────
  const unaccUrgent = { case_id: 'case-x', reference_id: 'TSH-2026-000002', paid_at: new Date(min(0)).toISOString(),
    deadline_at: null, sla_hours: 4, urgency_tier: 'urgent', tier: 'standard', status: 'paid' };

  await check('(a) superadmins: not at 29 min, once at 30 min (2 × 15m) — "no doctor has accepted TSH-…"', async () => {
    const h = harness({ unaccepted: [unaccUrgent] });
    if ((await worker.runDoctorNudges(at(29), h.deps)).unaccepted !== 0) throw new Error('early');
    const c = await worker.runDoctorNudges(at(30), h.deps);
    if (c.unaccepted !== 1) throw new Error('unaccepted=' + c.unaccepted);
    const a = h.sent.admins[0];
    if (a.template !== 'admin_case_unaccepted' || a.payload.caseReference !== 'TSH-2026-000002') throw new Error(JSON.stringify(a));
    if (!/No doctor has accepted TSH-2026-000002/.test(h.sent.ops[0].title)) throw new Error(h.sent.ops[0].title);
    if ((await worker.runDoctorNudges(at(45), h.deps)).unaccepted !== 0) throw new Error('alerted twice');
  });

  await check('(a) superadmins: VIP waits 90 min; urgent paid out of hours anchors to its 07:00 start', () => {
    const vip = Object.assign({}, unaccUrgent, { urgency_tier: 'vip', sla_hours: 18 });
    if (worker.decideUnacceptedAlert(vip, min(89))) throw new Error('VIP early');
    if (!worker.decideUnacceptedAlert(vip, min(90))) throw new Error('VIP not at 90');
    // Paid 22:00 Cairo (19:00Z); markCasePaid set deadline = next 07:00 Cairo (04:00Z) + 4h.
    const deferred = Object.assign({}, unaccUrgent, { paid_at: '2026-09-23T19:00:00Z', deadline_at: '2026-09-24T08:00:00Z' });
    if (worker.decideUnacceptedAlert(deferred, Date.parse('2026-09-23T19:40:00Z'))) throw new Error('alerted overnight');
    if (worker.decideUnacceptedAlert(deferred, Date.parse('2026-09-24T04:29:00Z'))) throw new Error('alerted before 07:30 Cairo');
    if (!worker.decideUnacceptedAlert(deferred, Date.parse('2026-09-24T04:30:00Z'))) throw new Error('not alerted at 07:30 Cairo');
  });

  await check('(a) superadmins: a case already unaccepted for days does not fire at deploy', () => {
    if (worker.decideUnacceptedAlert(unaccUrgent, min(30 + 25 * 60))) throw new Error('historical case alerted');
  });

  // ── (b) + (c) accepted, in review (Urgent: 4h window) ─────────────────
  const inReview = (over) => Object.assign({ id: 'case-r', doctor_id: 'doc-2', reference_id: 'TSH-2026-000003', doctor_lang: 'en',
    status: 'in_review', accepted_at: new Date(min(0)).toISOString(), deadline_at: new Date(min(240)).toISOString(),
    diagnosis_text: 'Draft findings', impression_text: null, recommendation_text: null }, over || {});

  await check('(b) nothing at 49%; the 50% reminder at 2h, once', async () => {
    const h = harness({ review: [inReview()] });
    if ((await worker.runDoctorNudges(at(117), h.deps)).review !== 0) throw new Error('early');
    const c = await worker.runDoctorNudges(at(120), h.deps);
    const tmpl = h.sent.notifications.map((n) => n.template);
    if (c.review !== 1 || tmpl[0] !== 'doctor_review_reminder_50') throw new Error(JSON.stringify({ c, tmpl }));
    if (h.sent.admins.length) throw new Error('admins alerted at 50%');
    if ((await worker.runDoctorNudges(at(150), h.deps)).review !== 0) throw new Error('50% re-sent');
  });

  await check('(b) 80% (3h12m): doctor reminder + superadmins "at risk", each once', async () => {
    const h = harness({ review: [inReview()] });
    await worker.runDoctorNudges(at(120), h.deps);
    const c = await worker.runDoctorNudges(at(192), h.deps);
    if (c.review !== 1 || c.atRisk !== 1) throw new Error(JSON.stringify(c));
    if (!h.sent.notifications.some((n) => n.template === 'doctor_review_reminder_80')) throw new Error('no 80% reminder');
    if (h.sent.admins[0].template !== 'admin_case_at_risk') throw new Error('no at-risk alert');
    const again = await worker.runDoctorNudges(at(200), h.deps);
    if (again.review || again.atRisk) throw new Error('80%/at-risk repeated');
  });

  await check('(b) first seen past 80% → only the 80% reminder (the tightest crossed level)', async () => {
    const h = harness({ review: [inReview()] });
    await worker.runDoctorNudges(at(205), h.deps);
    const tmpl = h.sent.notifications.filter((n) => n.channel === 'internal').map((n) => n.template);
    if (tmpl.join() !== 'doctor_review_reminder_80') throw new Error(tmpl.join());
  });

  await check('(b) past the deadline: nothing (breach is unchanged and owns it)', async () => {
    const h = harness({ review: [inReview()] });
    const c = await worker.runDoctorNudges(at(241), h.deps);
    if (c.review || c.atRisk || c.startReport) throw new Error(JSON.stringify(c));
  });

  await check('(b) the window is accepted_at → deadline_at (an extended deadline moves the thresholds)', () => {
    const extended = inReview({ deadline_at: new Date(min(480)).toISOString() });
    if (worker.decideReviewNudges(extended, min(200)).reminder) throw new Error('used sla_hours, not deadline_at');
  });

  await check('(c) no draft by 25% (1h) → one "start the report" nudge; a saved draft → none', async () => {
    const h = harness({ review: [inReview({ diagnosis_text: null })] });
    if ((await worker.runDoctorNudges(at(59), h.deps)).startReport !== 0) throw new Error('early');
    const c = await worker.runDoctorNudges(at(60), h.deps);
    if (c.startReport !== 1 || h.sent.notifications[0].template !== 'doctor_start_report_nudge') throw new Error(JSON.stringify(c));
    if ((await worker.runDoctorNudges(at(90), h.deps)).startReport !== 0) throw new Error('sent twice');
    const withDraft = harness({ review: [inReview()] });
    if ((await worker.runDoctorNudges(at(60), withDraft.deps)).startReport !== 0) throw new Error('nudged despite a draft');
  });

  await check('(c) past 50% with no draft, the 50% reminder carries it (no second nudge)', () => {
    const d = worker.decideReviewNudges(inReview({ diagnosis_text: null }), min(125));
    if (d.startReport || !d.reminder) throw new Error(JSON.stringify(d));
  });

  await check('every nudge query excludes practice cases (AND NOT o.is_practice)', async () => {
    const h = harness();
    await worker.runDoctorNudges(at(0), h.deps);
    if (h.sqls.length !== 3) throw new Error('expected 3 candidate queries, saw ' + h.sqls.length);
    for (const sql of h.sqls) {
      if (!/AND NOT o\.is_practice/.test(sql)) throw new Error('missing practice exclusion: ' + sql.slice(0, 120));
      if (/FROM orders\b(?!_active)/.test(sql)) throw new Error('reads orders, not orders_active');
    }
  });

  await check('the sweep runs the nudges on its own clock', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/case_sla_worker'), 'utf8');
    if (!/const nudges = await runDoctorNudges\(now\);/.test(src)) throw new Error('runCaseSlaSweep does not call runDoctorNudges(now)');
  });
})();
