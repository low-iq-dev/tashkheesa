'use strict';
// tests/watchtower/attention.test.js
//
// 6 Oct 2026 — PART 2: the attention API.
//
// Each new kind's predicate (pinned against migration 126, the only place it
// is defined), the practice-case exclusion, every state transition, and the
// escalation clock. Pure functions are called directly; SQL-backed functions
// run against a fake src/pg. The same behaviours were also exercised end to
// end against a migrated Postgres — see docs/audits/WATCHTOWER_2026-10-06.md.

console.log('\n👀 the attention list: kinds, state, escalation\n');
if (require('./_harness').runIsolated(__filename)) return;

const fs = require('fs');
const path = require('path');
const { t, check, withStubs, fakePg, ROOT, finish } = require('./_harness');



const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripSql = (s) => s.replace(/--.*$/gm, '');
const H = 3600e3;

(async function run() {
  const na = require('../../src/services/needs_attention');
  const view = stripSql(read('src/migrations/126_needs_attention_ops_kinds.sql'));
  // One arm of the UNION, by the kind literal that opens it.
  const arm = (kind, nth) => {
    const parts = view.split(/UNION ALL/);
    const hits = parts.filter((p) => new RegExp("^\\s*SELECT\\s+'" + kind + "'", 'm').test(p));
    return hits[nth || 0] || '';
  };
  const PRACTICE = /COALESCE\(o\.is_practice, false\) = false/;

  // ── predicates ────────────────────────────────────────────────────────────
  await check('paid_unassigned: paid, no doctor, open, older than 15 minutes', () => {
    const a = arm('paid_unassigned');
    if (!a) return 'no paid_unassigned arm in migration 126';
    if (!/o\.doctor_id IS NULL/.test(a)) return 'does not require doctor_id IS NULL';
    if (!/payment_status, ''\) IN \('paid', 'captured'\)/.test(a)) return 'does not require a paid case';
    if (!/COALESCE\(o\.paid_at, o\.created_at\) < NOW\(\) - INTERVAL '15 minutes'/.test(a)) return 'the 15-minute threshold is missing';
    if (!/o\.completed_at IS NULL/.test(a) || !/o\.deleted_at IS NULL/.test(a)) return 'completed or deleted cases are not excluded';
    return null;
  });

  await check('paid_unassigned uses the SAME open-status set as the Command queue', () => {
    const { ACTIVE_STATUS_LIST } = require('../../src/routes/api/_assign_helpers');
    const a = arm('paid_unassigned');
    const missing = (ACTIVE_STATUS_LIST || []).filter((s) => a.indexOf("'" + s + "'") === -1);
    if (!ACTIVE_STATUS_LIST || !ACTIVE_STATUS_LIST.length) return '_assign_helpers no longer exports ACTIVE_STATUS_LIST';
    return missing.length ? 'statuses missing from the view: ' + missing.join(', ') : null;
  });

  await check('refund_stale: an unsettled refund open longer than 48 hours', () => {
    const a = arm('refund_stale');
    if (!a) return 'no refund_stale arm';
    if (!/r\.status IN \('pending', 'approved', 'auto_approved'\)/.test(a)) return 'not the unsettled status set';
    if (!/\(r\.refunded_at AT TIME ZONE 'UTC'\) < NOW\(\) - INTERVAL '48 hours'/.test(a)) return 'the 48-hour threshold (UTC-labelled) is missing';
    return null;
  });

  await check('specialty_uncovered: visible specialty with no ready doctor', () => {
    const a = arm('specialty_uncovered', 0);
    if (!a) return 'no specialty_uncovered arm';
    if (!/COALESCE\(sp\.is_visible, true\) = true/.test(a)) return 'hidden specialties are not excluded';
    if (!/AND NOT EXISTS/.test(a)) return 'no NOT EXISTS over ready doctors';
    for (const f of ["du.role = 'doctor'", 'COALESCE(du.is_active, true) = true', 'COALESCE(du.is_paused, false) = false',
      'COALESCE(du.pending_approval, false) = false', 'COALESCE(du.onboarding_complete, false) = true']) {
      if (a.indexOf(f) === -1) return 'ready-doctor rule is missing: ' + f;
    }
    return null;
  });

  await check('…and no Urgent cover is a separate row, ref "<id>:urgent"', () => {
    const a = arm('specialty_uncovered', 1);
    if (!a) return 'no second specialty_uncovered arm';
    if (!/sp\.id::text \|\| ':urgent'/.test(a)) return 'the urgent row does not carry its own ref';
    if (!/\? 'urgent'/.test(a)) return 'does not test sla_tiers_supported for urgent';
    if ((a.match(/AND EXISTS/g) || []).length < 2) return 'not limited to specialties that HAVE a ready doctor';
    return null;
  });

  await check('send_failed: failed or skipped in 24h, one row per recipient', () => {
    const a = arm('send_failed');
    if (!a) return 'no send_failed arm';
    if (!/n\.status IN \('failed', 'skipped'\)/.test(a)) return 'not failed-or-skipped';
    if (!/INTERVAL '24 hours'/.test(a)) return 'the 24-hour window is missing';
    if (!/u\.role IN \('patient', 'doctor'\)/.test(a)) return 'not limited to patient- and doctor-facing sends';
    if (!/GROUP BY n\.to_user_id/.test(a)) return 'not grouped per recipient';
    return null;
  });

  await check('practice cases are excluded from every order-touching kind', () => {
    for (const k of ['paid_unassigned', 'refund_stale', 'send_failed']) {
      const a = arm(k);
      if (!PRACTICE.test(a)) return k + ' does not exclude is_practice';
      if (!/NOT IN \('demo_appreview', 'practice_seed'\)/.test(a)) return k + ' does not exclude practice_seed / demo sources';
    }
    return null;
  });

  await check('transfer claims are still a kind, and 117\'s arms are intact', () => {
    for (const k of ['contact_submission', 'pre_launch_lead', 'abandoned_case', 'doctor_application', 'payment_claim']) {
      if (!arm(k)) return 'the ' + k + ' arm was dropped';
    }
    if (!/l\.handled_at IS NULL/.test(arm('pre_launch_lead'))) return 'pre_launch_lead regressed to the pre-115 predicate';
    if (na.ALERT_AFTER_MINUTES !== 60) return 'the sweep no longer waits 60 minutes before alerting on a claim';
    return null;
  });

  await check('migration 114 was not edited', () => {
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('git', ['diff', '--stat', 'origin/main', '--', 'src/migrations/114_needs_attention.sql'], { cwd: ROOT }).toString();
      return out.trim() ? '114 differs from origin/main' : null;
    } catch (_) { return null; } // no git / no remote: nothing to compare against
  });

  await check('catalogue: paid_unassigned loud + locked on; the other three quiet; Arabic labels', () => {
    const prefs = require('../../src/services/ops_push_prefs');
    const by = {}; prefs.KIND_CATALOGUE.forEach((k) => { by[k.kind] = k; });
    for (const k of na.ESCALATING_KINDS) {
      if (!by[k]) return k + ' is not in the catalogue';
      if (!/[؀-ۿ]/.test(by[k].ar || '')) return k + ' has no Arabic label';
    }
    if (by.paid_unassigned.def !== 'loud' || by.paid_unassigned.lockOn !== true) return 'paid_unassigned is not loud + lockOn';
    for (const k of ['refund_stale', 'specialty_uncovered', 'send_failed']) if (by[k].def !== 'quiet') return k + ' is not quiet';
    return null;
  });

  // ── state: open / hidden ──────────────────────────────────────────────────
  const now = Date.parse('2026-10-06T12:00:00Z');
  const at = (ms) => new Date(now + ms);

  await check('snoozed items leave the list until the snooze ends', () => {
    if (na.hiddenReason({ snoozed_until: at(1 * H) }, now) !== 'snoozed') return 'a live snooze is not hidden';
    if (na.hiddenReason({ snoozed_until: at(-1) }, now) !== null) return 'an expired snooze is still hidden';
    return null;
  });

  await check('resolved items leave the list, and reappear after 24 hours', () => {
    if (na.hiddenReason({ resolved_at: at(-23 * H) }, now) !== 'resolved') return 'resolved 23h ago should be hidden';
    if (na.hiddenReason({ resolved_at: at(-24 * H - 1000) }, now) !== null) return 'resolved 24h+ ago should be back';
    if (na.RESOLVED_REAPPEARS_AFTER_HOURS !== 24) return 'the reappear window is not 24 hours';
    return null;
  });

  await check('an acked item stays on the list', () => (
    na.hiddenReason({ acked_at: at(-H) }, now) === null ? null : 'ack hid the item'
  ));

  // ── the escalation clock ──────────────────────────────────────────────────
  await check('loud: pushed first, again after 2h, then every 6h', () => {
    const due = (count, lastAgoMin, extra) => na.pushDue('loud',
      Object.assign({ push_count: count, last_pushed_at: lastAgoMin == null ? null : at(-lastAgoMin * 60e3) }, extra || {}), now);
    if (!due(0, null)) return 'a never-pushed item is not due';
    if (due(1, 119)) return 'pushed again before 2 hours';
    if (!due(1, 120)) return 'not pushed again at 2 hours';
    if (due(2, 359)) return 'third push before 6 hours';
    if (!due(2, 360)) return 'third push not due at 6 hours';
    if (due(3, 359) || !due(3, 360)) return 'later pushes are not every 6 hours';
    return null;
  });

  await check('loud: an ack or a snooze stops the repeat pushes', () => {
    const base = { push_count: 1, last_pushed_at: at(-10 * H) };
    if (na.pushDue('loud', Object.assign({ acked_at: at(-H) }, base), now)) return 'an acked item was pushed again';
    if (na.pushDue('loud', Object.assign({ snoozed_until: at(H) }, base), now)) return 'a snoozed item was pushed';
    if (!na.pushDue('loud', base, now)) return 'control: unacked item 10h on should be due';
    return null;
  });

  await check('quiet: pushed once and never again', () => {
    if (!na.pushDue('quiet', { push_count: 0 }, now)) return 'a quiet item was never pushed';
    if (na.pushDue('quiet', { push_count: 1, last_pushed_at: at(-100 * H) }, now)) return 'a quiet item was pushed twice';
    return null;
  });

  await check('a resolved item is not pushed while hidden', () => (
    na.pushDue('loud', { push_count: 0, resolved_at: at(-H) }, now) ? 'pushed a resolved item' : null
  ));

  // ── the sweep ─────────────────────────────────────────────────────────────
  const item = (over) => Object.assign({
    kind: 'paid_unassigned', ref: 'o1', who: 'Mona', summary: 'Paid, no doctor', severity: 1,
    waiting_since: at(-40 * 60e3), waiting_minutes: 40, push_count: 0,
  }, over || {});
  const sweep = async (items, over) => {
    const log = { pushed: [], claimed: [], reverted: [], sent: [] };
    const r = await na.runAttentionSweep(Object.assign({
      now,
      listWaiting: async () => items,
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async (body, fresh) => { log.sent.push(fresh.map((i) => i.kind)); },
      claimPush: async (kind, ref, n) => { log.claimed.push(kind + ':' + ref + ':' + n); return true; },
      revertPush: async (kind, ref) => { log.reverted.push(kind + ':' + ref); },
      pushEvent: async (i, step) => { log.pushed.push(i.kind + ':' + i.ref + ':' + step); return { sent: true }; },
    }, over || {}));
    return { r, log };
  };

  await check('sweep: each escalating item is its own push, of its own kind', async () => {
    const { r, log } = await sweep([item(), item({ kind: 'refund_stale', ref: 'r1' })]);
    if (log.pushed.join() !== 'paid_unassigned:o1:0,refund_stale:r1:0') return 'pushed: ' + log.pushed.join();
    if (log.sent.length) return 'escalating kinds also went through the critical-alert digest';
    if (r.pushed !== 2) return 'result.pushed = ' + r.pushed;
    return null;
  });

  await check('sweep: the claim comes before the send, and a lost claim sends nothing', async () => {
    const { log } = await sweep([item()], { claimPush: async () => false });
    return log.pushed.length ? 'pushed without owning the claim' : null;
  });

  await check('sweep: a push that did not go out gives the claim back (retry next pass)', async () => {
    const { r, log } = await sweep([item()], { pushEvent: async () => ({ sent: false, skipped: 'error' }) });
    if (log.reverted.join() !== 'paid_unassigned:o1') return 'claim not reverted: ' + log.reverted.join();
    return r.pushed === 0 ? null : 'counted a push that did not happen';
  });

  await check('sweep: snoozed and resolved items are skipped — for the old kinds too', async () => {
    const { r, log } = await sweep([
      item({ snoozed_until: at(H) }),
      item({ kind: 'abandoned_case', ref: 'a1', waiting_minutes: 500, resolved_at: at(-H) }),
    ]);
    if (log.pushed.length || log.sent.length) return 'a hidden item was alerted on';
    return r.total === 0 ? null : 'hidden items counted as waiting';
  });

  await check('sweep: the original kinds keep the 60-minute / 24-hour digest rule', async () => {
    const { log } = await sweep([
      item({ kind: 'payment_claim', ref: 'p1', waiting_minutes: 61 }),
      item({ kind: 'abandoned_case', ref: 'a1', waiting_minutes: 30 }),
    ]);
    if (log.sent.length !== 1 || log.sent[0].join() !== 'payment_claim') return 'digest was: ' + JSON.stringify(log.sent);
    if (log.pushed.length) return 'a non-escalating kind went through the escalation clock';
    if (na.REALERT_AFTER_HOURS !== 24) return 're-alert window changed';
    return null;
  });

  // ── state transitions (SQL-backed) ────────────────────────────────────────
  const withDb = async (inView, fn) => {
    const pg = fakePg((sql) => {
      if (/FROM v_needs_attention WHERE kind = \$1 AND ref = \$2/.test(sql)) return inView ? [{ '?column?': 1 }] : [];
      if (/FROM attention_state WHERE kind = \$1 AND ref = \$2/.test(sql)) return [{ kind: 'k', ref: 'r', push_count: 0 }];
      return [];
    });
    const restore = withStubs({ 'src/pg.js': pg, 'src/db.js': pg }, ['src/services/needs_attention.js']);
    try { return await fn(require('../../src/services/needs_attention'), pg); } finally { restore(); }
  };
  const write = (pg) => pg.calls.find((c) => /INSERT INTO attention_state/.test(c.sql));

  await check('ack: records who and when, and nothing else', () => withDb(true, async (svc, pg) => {
    const r = await svc.ackItem('paid_unassigned', 'o1', 'sa-1');
    if (!r.ok) return 'ack refused: ' + r.code;
    const w = write(pg);
    if (!w || !/acked_at = NOW\(\)/.test(w.sql) || w.params[2] !== 'sa-1') return 'ack did not record acked_at / acked_by';
    if (/resolved_at =|snoozed_until =/.test(w.sql.split('DO UPDATE SET')[1])) return 'ack touched other state';
    return null;
  }));

  await check('snooze: 1 to 72 whole hours, nothing else', () => withDb(true, async (svc, pg) => {
    for (const bad of [0, 73, 1.5, -1, 'abc', undefined, null]) {
      const r = await svc.snoozeItem('refund_stale', 'r1', bad, 'sa-1');
      if (r.ok || r.code !== 'BAD_HOURS') return 'accepted hours=' + String(bad);
    }
    if (write(pg)) return 'a rejected snooze wrote state';
    for (const good of [1, 72]) {
      const r = await svc.snoozeItem('refund_stale', 'r1', good, 'sa-1');
      if (!r.ok) return 'rejected hours=' + good;
    }
    const w = write(pg);
    return /snoozed_until/.test(w.sql) && w.params[2] === '1' ? null : 'snoozed_until not written from hours';
  }));

  await check('resolve: stores the note and who resolved it', () => withDb(true, async (svc, pg) => {
    const r = await svc.resolveItem('send_failed', 'u1', '  called her  ', 'sa-1');
    if (!r.ok) return 'resolve refused: ' + r.code;
    const w = write(pg);
    if (!/resolved_at = NOW\(\)/.test(w.sql)) return 'resolved_at not set';
    return (w.params[2] === 'sa-1' && w.params[3] === 'called her') ? null : 'note / resolved_by not stored: ' + JSON.stringify(w.params);
  }));

  await check('state cannot be set on an unknown kind or on something not waiting', () => withDb(false, async (svc, pg) => {
    if ((await svc.ackItem('not_a_kind', 'x', 'sa-1')).code !== 'UNKNOWN_KIND') return 'unknown kind accepted';
    if ((await svc.ackItem('paid_unassigned', '', 'sa-1')).code !== 'BAD_REF') return 'empty ref accepted';
    if ((await svc.resolveItem('paid_unassigned', 'gone', 'n', 'sa-1')).code !== 'NOT_FOUND') return 'item not in the view was accepted';
    return write(pg) ? 'a refused transition wrote state' : null;
  }));

  await check('the push claim is atomic on the count it read', () => withDb(true, async (svc, pg) => {
    await svc.claimPush('paid_unassigned', 'o1', 2);
    const c = pg.calls.find((x) => /UPDATE attention_state SET push_count = push_count \+ 1/.test(x.sql));
    if (!c) return 'no claim statement';
    return (/AND push_count = \$3/.test(c.sql) && c.params[2] === 2) ? null : 'the claim is not conditional on the expected count';
  }));

  await check('sync: a new episode or an expired resolve clears the ack and the count; a live snooze survives', () => {
    const src = read('src/services/needs_attention.js');
    const m = /async function syncState\(\) \{[\s\S]*?\n\}/.exec(src);
    if (!m) return 'syncState not found';
    const f = m[0];
    if (!/SELECT DISTINCT v\.kind, v\.ref/.test(f)) return 'does not stamp every row in the view';
    if (!/push_count\s+= CASE WHEN ' \+ fresh/.test(f) || !/acked_at\s+= CASE WHEN ' \+ fresh/.test(f)) return 'a fresh episode does not reset ack / push_count';
    if (!/snoozed_until\s+= CASE WHEN s\.snoozed_until <= NOW\(\) THEN NULL ELSE s\.snoozed_until END/.test(f)) return 'a live snooze could be cleared';
    return null;
  });

  // ── the routes ────────────────────────────────────────────────────────────
  await check('routes are mounted below the superadmin gate, and nowhere else', () => {
    const admin = read('src/routes/api/admin.js');
    const gate = admin.indexOf("router.use(requireRole('superadmin'));");
    const mount = admin.indexOf("require('./admin_watchtower')(router)");
    if (gate === -1 || mount === -1) return 'gate or mount not found';
    if (mount < gate) return 'watchtower routes are mounted ABOVE the superadmin gate';
    const elsewhere = ['src/routes/api_v1.js', 'src/server.js'].filter((f) => /admin_watchtower/.test(read(f)));
    return elsewhere.length ? 'also mounted from ' + elsewhere.join(', ') : null;
  });

  await check('GET /attention shapes waiting time, severity, contact fields and state', async () => {
    const routes = {};
    const router = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; }, put: () => {} };
    require('../../src/routes/api/admin_watchtower')(router, {
      attention: Object.assign({}, na, {
        listAttention: async () => [
          { kind: 'paid_unassigned', ref: 'o1', who: 'Mona', email: 'm@x.test', phone: '+20', summary: 's', severity: 1,
            waiting_since: new Date(Date.now() - 90 * 60e3), waiting_minutes: 90.4, acked_at: new Date(), acked_by: 'sa-1', push_count: 2 },
        ],
        snoozeItem: async (k, r, hours) => (hours === 4 ? { ok: true, state: { snoozed_until: new Date() } } : { ok: false, code: 'BAD_HOURS' }),
      }),
    });
    let out = null;
    const res = { ok: (d) => { out = { status: 200, data: d }; }, fail: (m, s, c) => { out = { status: s, code: c }; } };
    await routes['GET /attention']({ query: {} }, res);
    const i = out.data.items[0];
    if (i.waiting_minutes !== 90 || i.waiting_label !== '1h') return 'waiting time wrong: ' + i.waiting_minutes + ' / ' + i.waiting_label;
    if (i.severity !== 1 || i.level !== 'loud' || i.escalates !== true) return 'severity / level wrong';
    if (i.email !== 'm@x.test' || i.phone !== '+20' || i.who !== 'Mona') return 'contact fields missing';
    if (!i.state.acked_at || i.state.acked_by !== 'sa-1' || i.state.push_count !== 2) return 'state missing';
    if (out.data.counts.open !== 1 || out.data.counts.unacked !== 0) return 'counts wrong';
    await routes['POST /attention/:kind/:ref/snooze']({ params: { kind: 'refund_stale', ref: 'r1' }, body: { hours: 99 }, user: { id: 'sa-1' } }, res);
    if (out.status !== 400 || out.code !== 'BAD_HOURS') return 'a bad snooze was not a 400';
    await routes['POST /attention/:kind/:ref/snooze']({ params: { kind: 'refund_stale', ref: 'r1' }, body: { hours: 4 }, user: { id: 'sa-1' } }, res);
    return out.status === 200 && out.data.action === 'snooze' ? null : 'a good snooze failed';
  });

  finish();
})();
