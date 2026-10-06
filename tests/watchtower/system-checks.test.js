'use strict';
// tests/watchtower/system-checks.test.js
//
// 6 Oct 2026 — PARTS 3, 4 and 5: the check registry, the expiry register and
// the daily digest push.
//
// The intake route runs for real on an ephemeral port with a fake registry
// behind it; everything else is pure or dependency-injected. No database.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { t, check, withEnv, ROOT } = require('./_harness');

console.log('\n🗼 check registry, expiry register, daily digest\n');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sc = require('../../src/services/system_checks');
const ex = require('../../src/services/ops_expiries');
const fd = require('../../src/services/funnel_digest');

const good = (over) => Object.assign({ check_key: 'mini.disk', area: 'mini', status: 'ok', summary: 'fine' }, over || {});

function startApp(registry) {
  const express = require('express');
  const app = express();
  app.use(require('../../src/middleware/apiResponse'));
  app.use(express.json());
  app.use('/ops/checks', require('../../src/routes/api/ops_checks')({ systemChecks: registry }));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
function post(server, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/ops/checks', method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, body: j, raw }); });
    });
    req.on('error', reject); req.end(data);
  });
}

(async function run() {

  // ── POST /api/v1/ops/checks ───────────────────────────────────────────────
  const KEY = 'test-key-' + 'z'.repeat(32);
  const stored = [];
  const registry = Object.assign({}, sc, { upsertChecks: async (list) => { stored.push(...list); return list.length; } });
  const server = await startApp(registry);
  const auth = { authorization: 'Bearer ' + KEY };

  await check('FAIL CLOSED: with OPS_CHECKS_KEY unset the route answers 503 and stores nothing', async () => {
    const restore = withEnv({ OPS_CHECKS_KEY: undefined });
    try {
      for (const h of [auth, {}, { authorization: 'Bearer ' }, { authorization: 'Bearer undefined' }]) {
        const r = await post(server, good(), h);
        if (r.status !== 503 || r.body.code !== 'OPS_CHECKS_DISABLED') return 'got ' + r.status + ' with headers ' + JSON.stringify(h);
      }
      const blank = withEnv({ OPS_CHECKS_KEY: '   ' });
      try { if ((await post(server, good(), { authorization: 'Bearer    ' })).status !== 503) return 'a whitespace-only key opened the route'; }
      finally { blank(); }
      return stored.length ? 'a check was stored with no key configured' : null;
    } finally { restore(); }
  });

  await check('a wrong, missing or malformed key is 401, and the key is never echoed', async () => {
    const restore = withEnv({ OPS_CHECKS_KEY: KEY });
    try {
      for (const h of [{}, { authorization: 'Bearer nope' }, { authorization: KEY }, { authorization: 'Basic ' + KEY },
        { authorization: 'Bearer ' + KEY + 'x' }, { authorization: 'Bearer ' + KEY.slice(0, -1) }]) {
        const r = await post(server, good(), h);
        if (r.status !== 401) return 'got ' + r.status + ' for ' + JSON.stringify(h).slice(0, 40);
        if (r.raw.indexOf(KEY) !== -1) return 'the key was echoed in a response';
      }
      return stored.length ? 'a check was stored without the key' : null;
    } finally { restore(); }
  });

  await check('the right key stores the batch and answers with what it accepted', async () => {
    const restore = withEnv({ OPS_CHECKS_KEY: KEY });
    try {
      const r = await post(server, [good(), good({ check_key: 'tash.queue', area: 'tash', status: 'warn', detail: { depth: 12 } })], auth);
      if (r.status !== 200 || !r.body.success) return 'got ' + r.status;
      if (r.body.data.accepted !== 2 || r.body.data.checks[1].check_key !== 'tash.queue') return 'unexpected body: ' + r.raw;
      if (r.raw.indexOf('depth') !== -1) return 'detail was echoed back';
      if (stored.length !== 2 || stored[0].source !== 'api') return 'not stored as source api';
      return null;
    } finally { restore(); }
  });

  await check('one bad check rejects the whole request and stores nothing', async () => {
    const restore = withEnv({ OPS_CHECKS_KEY: KEY });
    try {
      const before = stored.length;
      const r = await post(server, [good({ check_key: 'ok.one' }), good({ status: 'broken' })], auth);
      if (r.status !== 400 || r.body.code !== 'VALIDATION_FAILED') return 'got ' + r.status;
      if (!r.body.errors || r.body.errors[0].index !== 1) return 'the failing index is not reported';
      return stored.length === before ? null : 'a partial batch was stored';
    } finally { restore(); }
  });
  server.close();

  await check('the key comparison is constant-time and the route is rate limited', () => {
    const src = read('src/routes/api/ops_checks.js');
    if (!/timingSafeEqual/.test(src) || !/createHash\('sha256'\)/.test(src)) return 'no hashed timingSafeEqual comparison';
    if (/===\s*(expected|req\._opsChecksKey)|==\s*(expected|req\._opsChecksKey)/.test(src)) return 'a plain equality on the key';
    if (!/rateLimit\(/.test(src)) return 'no rate limiter';
    if (/console\.(log|error|warn)\([^)]*req\.body/.test(src) || /detail/.test((src.match(/console\.[a-z]+\([^;]*;/g) || []).join(''))) return 'the body or detail is logged';
    const { keysMatch } = require('../../src/routes/api/ops_checks');
    return (keysMatch('abc', 'abc') && !keysMatch('abc', 'abd') && !keysMatch('a', 'abc')) ? null : 'keysMatch is wrong';
  });

  await check('the route is mounted ahead of the JWT gates and is CSRF exempt', () => {
    const v1 = read('src/routes/api_v1.js');
    const mount = v1.indexOf("router.use('/ops/checks'");
    const gate = v1.indexOf('router.use(requireJWT);');
    if (mount === -1) return 'not mounted';
    if (gate === -1 || mount > gate) return 'mounted behind the patient JWT gate';
    return /originalUrl\.startsWith\('\/api\/v1'\)/.test(read('src/middleware/csrf.js')) ? null : '/api/v1 is no longer CSRF exempt';
  });

  // ── validation ────────────────────────────────────────────────────────────
  await check('validation: key pattern, status, area list, summary 300, detail 4 KB, 50 per request', () => {
    const bad = (over, why) => (sc.validateCheck(good(over)).ok ? why : null);
    const fails = [
      bad({ check_key: 'ab' }, 'a 2-character key'), bad({ check_key: 'Mini.Disk' }, 'uppercase key'),
      bad({ check_key: 'mini disk' }, 'a space in the key'), bad({ check_key: 'x'.repeat(81) }, 'an 81-character key'),
      bad({ check_key: 'mini-disk' }, 'a hyphen in the key'),
      bad({ status: 'error' }, "status 'error'"), bad({ status: undefined }, 'no status'),
      bad({ area: 'marketing' }, "area 'marketing'"), bad({ area: undefined }, 'no area'),
      bad({ summary: 'x'.repeat(301) }, 'a 301-character summary'), bad({ summary: 5 }, 'a numeric summary'),
      bad({ detail: { blob: 'x'.repeat(4096) } }, 'detail over 4 KB'), bad({ detail: 'text' }, 'a string detail'),
      bad({ expected_every_seconds: 5 }, 'a 5-second cadence'),
    ].filter(Boolean);
    if (fails.length) return 'accepted: ' + fails.join('; ');
    if (!sc.validateCheck(good({ check_key: 'a.b', summary: 'x'.repeat(300), detail: { blob: 'x'.repeat(4000) } })).ok) return 'rejected a check at the limits';
    if (sc.AREAS.join() !== 'site,cases,money,notifications,doctors,growth,mini,tash,credentials,backups,stores') return 'the area list changed';
    const many = (n) => Array.from({ length: n }, (_, i) => good({ check_key: 'mini.c' + i }));
    if (!sc.validateBody(many(50)).ok) return '50 checks rejected';
    if (sc.validateBody(many(51)).ok) return '51 checks accepted';
    if (sc.validateBody([]).ok || sc.validateBody(null).ok) return 'an empty body accepted';
    if (sc.validateBody([good(), good()]).ok) return 'a duplicate key in one request accepted';
    return null;
  });

  await check('briefs: only daily / weekly / monthly, at most 30 short lines', () => {
    const b = (over) => sc.validateCheck(Object.assign({ check_key: 'claude.brief.daily', area: 'tash', status: 'ok', summary: 'headline' }, over));
    if (!b({ detail: { lines: ['a', 'b'] } }).ok) return 'a valid brief was rejected';
    if (b({ check_key: 'claude.brief.hourly' }).ok) return 'an unknown brief period was accepted';
    if (b({ detail: { lines: Array.from({ length: 31 }, () => 'x') } }).ok) return '31 lines accepted';
    if (b({ detail: { lines: ['a', 5] } }).ok) return 'a non-string line accepted';
    return null;
  });

  // ── staleness and the GET /system payload ─────────────────────────────────
  const NOW = Date.parse('2026-10-06T12:00:00Z');
  const row = (key, area, status, agoSec, every, extra) => Object.assign({
    check_key: key, area, status, summary: key + ' summary', detail: null,
    checked_at: new Date(NOW - agoSec * 1000), expected_every_seconds: every, source: 'portal',
  }, extra || {});

  await check('staleness: stale only when now - checked_at EXCEEDS twice the expected interval', () => {
    const at = (ago) => new Date(NOW - ago * 1000);
    if (sc.isStale(at(600), 300, NOW)) return 'exactly 2x is not stale';
    if (!sc.isStale(at(601), 300, NOW)) return 'just past 2x should be stale';
    if (sc.isStale(at(599), 300, NOW)) return 'inside 2x should be fresh';
    if (!sc.isStale(at(2 * 86400 + 1), 86400, NOW)) return 'a daily check 2 days+ old should be stale';
    if (!sc.isStale(null, 300, NOW)) return 'a check with no checked_at should be stale';
    return null;
  });

  await check('GET /system: grouped by area, the area takes its worst check, stale counts as warn', () => {
    const p = sc.buildSystemPayload([
      row('site.workers', 'site', 'ok', 60, 300),
      row('site.dns', 'site', 'fail', 60, 300),
      row('money.claims_waiting', 'money', 'ok', 601, 300),      // ok but stale
      row('cases.sla_overdue', 'cases', 'warn', 60, 300),
      row('mini.disk', 'mini', 'ok', 60, 300),
    ], NOW);
    const a = {}; p.areas.forEach((x) => { a[x.area] = x; });
    if (p.areas.map((x) => x.area).join() !== sc.AREAS.join()) return 'areas missing or out of order';
    if (a.site.status !== 'fail') return 'site should be fail (worst check), got ' + a.site.status;
    if (a.money.status !== 'warn' || a.money.checks[0].stale !== true || a.money.checks[0].status !== 'ok') return 'a stale ok check should make its area warn, and keep its own status';
    if (a.cases.status !== 'warn' || a.mini.status !== 'ok') return 'cases/mini wrong';
    if (a.backups.status !== 'none' || a.backups.checks.length) return 'an empty area should be none';
    if (p.status !== 'fail') return 'overall should be the worst area';
    if (p.counts.total !== 5 || p.counts.failing !== 1 || p.counts.warning !== 1 || p.counts.stale !== 1) return 'counts wrong: ' + JSON.stringify(p.counts);
    const c = a.site.checks[0];
    for (const f of ['check_key', 'status', 'summary', 'detail', 'checked_at', 'expected_every_seconds', 'stale', 'source']) {
      if (!(f in c)) return 'check is missing field ' + f;
    }
    return null;
  });

  await check('GET /system: the latest of each brief is under `briefs`, not inside an area', () => {
    const p = sc.buildSystemPayload([
      row('claude.brief.daily', 'tash', 'ok', 60, 86400, { summary: 'Quiet day', detail: { lines: ['2 signups', '1 paid'] } }),
      row('claude.brief.weekly', 'tash', 'ok', 60, 604800, { summary: 'Week 40', detail: '{"lines":["a"]}' }),
    ], NOW);
    if (!p.briefs.daily || p.briefs.daily.headline !== 'Quiet day' || p.briefs.daily.lines.join() !== '2 signups,1 paid') return 'daily brief wrong';
    if (!p.briefs.weekly || p.briefs.weekly.lines[0] !== 'a') return 'a brief whose detail arrived as text was not parsed';
    if (p.briefs.monthly !== null) return 'a missing brief should be null';
    if (p.areas.some((a) => a.checks.length)) return 'a brief was listed as a check';
    return null;
  });

  // ── transitions ───────────────────────────────────────────────────────────
  await check('transition rules: to fail pushes failed; warn/fail to ok pushes recovered; nothing else', () => {
    const k = sc.transitionKind;
    const want = [
      [null, 'fail', 'system_check_failed'], ['ok', 'fail', 'system_check_failed'], ['warn', 'fail', 'system_check_failed'],
      ['fail', 'ok', 'system_check_recovered'], ['warn', 'ok', 'system_check_recovered'],
      [null, 'ok', null], [null, 'warn', null], ['ok', 'warn', null], ['fail', 'warn', null],
      ['fail', 'fail', null], ['ok', 'ok', null],
    ];
    const wrong = want.filter(([a, b, e]) => k(a, b) !== e).map(([a, b]) => a + '→' + b);
    return wrong.length ? 'wrong for ' + wrong.join(', ') : null;
  });

  await check('a check that stays failed is pushed once, not on every pass', async () => {
    // An in-memory ops_checks with the worker's own claim semantics:
    // a row is due only while pushed_status differs from status.
    const table = { 'site.dns': { check_key: 'site.dns', area: 'site', status: 'fail', summary: 'dns broken', pushed_status: null } };
    const claimTransitions = async () => Object.values(table).filter((r) => r.pushed_status !== r.status)
      .map((r) => { const prev = r.pushed_status; r.pushed_status = r.status; return Object.assign({}, r, { prev }); });
    const sent = [];
    const deps = { claimTransitions, claimStale: async () => [], claimBriefs: async () => [], pushOpsEvent: async (e) => { sent.push(e); return { sent: true }; } };
    await sc.processPushes(deps); await sc.processPushes(deps); await sc.processPushes(deps);
    if (sent.length !== 1 || sent[0].kind !== 'system_check_failed') return 'expected exactly one failed push across 3 passes, got ' + sent.length;
    table['site.dns'].status = 'fail'; table['site.dns'].summary = 'still broken';   // re-written, still failed
    await sc.processPushes(deps);
    if (sent.length !== 1) return 'a re-write that is still failed pushed again';
    table['site.dns'].status = 'ok';
    await sc.processPushes(deps); await sc.processPushes(deps);
    if (sent.length !== 2 || sent[1].kind !== 'system_check_recovered') return 'recovery was not pushed exactly once';
    table['site.dns'].status = 'fail';
    await sc.processPushes(deps);
    return sent.length === 3 ? null : 'a second failure after recovery was not pushed';
  });

  await check('loudness by area: failed is loud for site / cases / money only; stale is loud for site only', async () => {
    const sent = [];
    const rows = ['site', 'cases', 'money', 'notifications', 'backups', 'growth'].map((area) => ({ check_key: area + '.x', area, status: 'fail', prev: 'ok', summary: 's' }));
    await sc.processPushes({
      claimTransitions: async () => rows.concat([{ check_key: 'site.y', area: 'site', status: 'ok', prev: 'fail', summary: 's' }]),
      claimStale: async () => [{ check_key: 'site.z', area: 'site', checked_at: new Date(), expected_every_seconds: 300 },
                               { check_key: 'money.z', area: 'money', checked_at: new Date(), expected_every_seconds: 300 }],
      claimBriefs: async () => [{ check_key: 'claude.brief.daily', area: 'tash', summary: 'Headline', checked_at: new Date() }],
      pushOpsEvent: async (e) => { sent.push(e); return { sent: true }; },
    });
    const mode = (key) => (sent.find((e) => e.dedupeKey.indexOf(key) === 0) || {}).defaultMode;
    for (const a of ['site', 'cases', 'money']) if (mode(a + '.x') !== 'loud') return a + ' failure should be loud';
    for (const a of ['notifications', 'backups', 'growth']) if (mode(a + '.x') !== 'quiet') return a + ' failure should be quiet';
    if (mode('site.y') !== 'quiet') return 'a recovery should be quiet';
    const stale = sent.filter((e) => e.kind === 'system_check_stale');
    if (stale.length !== 2 || stale[0].defaultMode !== 'loud' || stale[1].defaultMode !== 'quiet') return 'stale loudness wrong';
    const brief = sent.find((e) => e.kind === 'ops_brief');
    if (!brief || brief.defaultMode !== 'quiet' || brief.body !== 'Headline' || brief.data.brief !== 'daily') return 'brief push wrong';
    return sent.every((e) => e.data.screen === 'system') ? null : 'a push does not open the System screen';
  });

  await check('the push decision is the worker\'s: pushed_status drives it, and no writer touches it', () => {
    const src = read('src/services/system_checks.js');
    if (!/pushed_status IS DISTINCT FROM status/.test(src)) return 'transitions are not detected from pushed_status';
    if (!/SET pushed_status = c\.status/.test(src)) return 'pushed_status is not recorded in the claim';
    if (/pushed_status|pushed_at|stale_pushed|brief_pushed_at/.test(sc.UPSERT_SQL)) return 'the writer statement touches a worker-owned column';
    if (/pushOpsEvent|notifySuperadmins/.test(read('src/routes/api/ops_checks.js'))) return 'the POST handler pushes — SQL-written rows would then behave differently';
    if (!/brief_pushed_at IS DISTINCT FROM checked_at/.test(src)) return 'briefs are not pushed per new write';
    return null;
  });

  await check('per-event loudness: a stored preference wins, the producer default fills the gap, lockOn holds', () => {
    const prefs = require('../../src/services/ops_push_prefs');
    if (prefs.effectiveMode('system_check_failed', null, 'quiet') !== 'quiet') return 'producer default not applied';
    if (prefs.effectiveMode('system_check_failed', null) !== 'loud') return 'catalogue default changed';
    if (prefs.effectiveMode('system_check_failed', 'off', 'loud') !== 'off') return 'a stored off was overridden';
    if (prefs.effectiveMode('system_check_stale', 'loud', 'quiet') !== 'loud') return 'a stored loud was overridden';
    if (prefs.effectiveMode('system_check_failed', null, 'off') !== 'loud') return 'a producer could switch a push off';
    if (prefs.effectiveMode('critical_alert', 'off', 'quiet') !== 'loud') return 'lockOn broken';
    const by = {}; prefs.KIND_CATALOGUE.forEach((k) => { by[k.kind] = k; });
    for (const k of ['system_check_failed', 'system_check_recovered', 'system_check_stale', 'ops_brief', 'daily_digest']) {
      if (!by[k] || !/[؀-ۿ]/.test(by[k].ar || '')) return k + ' is missing from the catalogue or has no Arabic label';
    }
    return (by.system_check_recovered.def === 'quiet' && by.system_check_stale.def === 'quiet' && by.ops_brief.def === 'quiet') ? null : 'defaults wrong';
  });

  // ── the worker ────────────────────────────────────────────────────────────
  await check('the worker is registered: WORKER_SPECS, a 5-minute singleton, a heartbeat, boot', () => {
    const { WORKER_SPECS } = require('../../src/services/admin_health');
    const spec = WORKER_SPECS.find((s) => s.key === sc.AGENT_NAME);
    if (!spec) return 'system_checks is not in admin_health.WORKER_SPECS';
    if (spec.staleSeconds < 2 * sc.INTERVAL_SECONDS) return 'staleness budget is under two intervals';
    const jq = read('src/job_queue.js');
    if (!/boss\.createQueue\('system-checks'\)/.test(jq)) return 'the queue is never created (pg-boss 10 would throw)';
    if (!/boss\.schedule\('system-checks', '\*\/5 \* \* \* \*'/.test(jq)) return 'not scheduled every 5 minutes';
    if (!/singletonKey: 'system-checks'/.test(jq)) return 'not a singleton';
    if (!/pingOps\('system_checks'/.test(jq)) return 'does not heartbeat as system_checks';
    const server = read('src/server.js');
    if (!/await scheduleSystemChecks\(\)/.test(server)) return 'server.js does not schedule it';
    return server.indexOf('await scheduleSystemChecks()') < server.indexOf('Worker dead-man') ? null : 'scheduled in an unexpected place';
  });

  await check('the worker writes all eleven internal checks, and one failing check does not stop the rest', async () => {
    const src = read('src/services/system_checks.js');
    const keys = ['site.workers', 'cases.paid_unassigned', 'cases.sla_overdue', 'money.claims_waiting', 'money.refunds_stale',
      'notifications.failed', 'notifications.critical', 'doctors.coverage', 'growth.signups', 'credentials.expiring', 'ai.spend'];
    const missing = keys.filter((k) => src.indexOf("check_key: '" + k + "'") === -1);
    if (missing.length) return 'no internal check for: ' + missing.join(', ');
    const logger = require('../../src/logger');
    const realLog = logger.logErrorToDb; const logged = [];
    logger.logErrorToDb = (e, ctx) => { logged.push(ctx); };
    let out;
    try {
    out = await sc.computeInternalChecks([
      async function a() { return { check_key: 'x.a', area: 'site', status: 'ok', summary: '' }; },
      async function b() { throw new Error('db down'); },
      async function c() { return { check_key: 'x.c', area: 'site', status: 'ok', summary: '' }; },
    ]).catch((e) => e);
    } finally { logger.logErrorToDb = realLog; }
    if (logged.length !== 1) return 'the failing check was not logged';
    if (!Array.isArray(out) || out.map((c) => c.check_key).join() !== 'x.a,x.c') return 'a throwing check stopped the pass';
    return (out[0].source === 'portal' && out[0].expected_every_seconds === 300) ? null : 'internal checks are not stamped portal / 300s';
  });

  await check('ai.spend: warn at 3x the 7-day daily average, fail at 6x', () => {
    const s = (a, b) => sc.classifyAiSpend(a, b).status;
    if (s(29, 10) !== 'ok' || s(30, 10) !== 'warn' || s(59, 10) !== 'warn' || s(60, 10) !== 'fail') return 'thresholds wrong';
    if (s(50, 0) !== 'ok') return 'no history should not alarm';
    return s(0.9, 0.1) === 'ok' ? null : 'a sub-dollar day should not alarm';
  });

  await check('growth.signups warns only on zero signups for 48 hours', () => (
    (sc.classifySignups(0) === 'warn' && sc.classifySignups(1) === 'ok') ? null : 'wrong'
  ));

  await check('history is pruned at 90 days in the existing daily maintenance pass', () => {
    if (sc.HISTORY_RETENTION_DAYS !== 90) return 'retention is not 90 days';
    const server = read('src/server.js');
    const m = /var runHeartbeatPrune = function \(phase\) \{[\s\S]*?\n      \};/.exec(server);
    return (m && /pruneCheckHistory\(\)/.test(m[0])) ? null : 'pruneCheckHistory is not in the heartbeat-prune maintenance pass';
  });

  await check('migrations: RLS on every new table, no policies, history written by trigger', () => {
    const all = ['125_attention_state.sql', '127_ops_checks.sql', '128_ops_expiries.sql'].map((f) => read('src/migrations/' + f)).join('\n');
    for (const tbl of ['attention_state', 'ops_checks', 'ops_check_history', 'ops_expiries']) {
      if (!new RegExp('ALTER TABLE ' + tbl + '\\s+ENABLE ROW LEVEL SECURITY').test(all)) return tbl + ' does not enable RLS';
    }
    if (/CREATE POLICY/i.test(all)) return 'a policy was added';
    if (!/CREATE TRIGGER ops_checks_history_trg/.test(all)) return 'no history trigger — SQL-written rows would leave no history';
    return /pushed_status\s+text/.test(all) ? null : 'no pushed_status column';
  });

  // ── PART 4: expiries ──────────────────────────────────────────────────────
  const TODAY = new Date('2026-10-06T10:00:00Z');
  const day = (n) => new Date(Date.parse('2026-10-06T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

  await check('expiry status: warn at 30 days, fail at 7, unset with no date', () => {
    const s = (n) => ex.expiryStatus(n === null ? null : day(n), TODAY);
    const got = [31, 30, 8, 7, 0, -3, null].map(s).join();
    return got === 'ok,warn,warn,fail,fail,fail,unset' ? null : 'got ' + got;
  });

  await check('credentials.expiring: fail beats warn; a row with no date is a warning', () => {
    const rows = (list) => list.map((d, i) => ({ key: 'k' + i, label: 'L' + i, expires_on: d === null ? null : day(d) }));
    if (ex.summariseExpiries(rows([100, 200]), TODAY).status !== 'ok') return 'all far out should be ok';
    if (ex.summariseExpiries(rows([100, null]), TODAY).status !== 'warn') return 'a missing date should warn';
    if (ex.summariseExpiries(rows([100, 20]), TODAY).status !== 'warn') return '20 days should warn';
    const f = ex.summariseExpiries(rows([100, 20, 5, null]), TODAY);
    if (f.status !== 'fail') return '5 days should fail';
    if (f.detail.failing.length !== 1 || f.detail.warning.length !== 1 || f.detail.unset.length !== 1) return 'detail wrong: ' + JSON.stringify(f.detail);
    return f.summary.length <= 300 ? null : 'summary too long';
  });

  await check('expiry dates must be real dates', () => (
    (ex.isValidDate('2027-02-28') && !ex.isValidDate('2027-02-30') && !ex.isValidDate('28/02/2027') && !ex.isValidDate(''))
      ? null : 'date validation wrong'
  ));

  await check('the register is seeded with all eighteen keys, undated', () => {
    const sql = read('src/migrations/128_ops_expiries.sql');
    const labels = ['Domain tashkheesa.com', 'Apple developer membership', 'Apple push key', 'Google Play account',
      'Instagram Graph token', 'Meta system token', 'Gmail app password for info@', 'GitHub token on the mini',
      'Tailscale node key', 'Twilio', 'Kashier keys', 'Cloudflare', 'Render plan', 'Supabase plan', 'Google Workspace',
      'Cloudinary', 'Expo / EAS', 'Anthropic key'];
    const missing = labels.filter((l) => sql.indexOf("'" + l + "'") === -1);
    if (missing.length) return 'not seeded: ' + missing.join(', ');
    const seeded = (sql.match(/^\s*\('[a-z0-9_]+',\s*'/gm) || []).length;
    if (seeded !== 18) return 'expected 18 seed rows, found ' + seeded;
    return /INSERT INTO ops_expiries \(key, label\) VALUES/.test(sql) ? null : 'seeds set a date';
  });

  // ── PART 5: the daily digest ──────────────────────────────────────────────
  await check('digest body: waiting, failing and stale checks, yesterday paid and delivered', () => {
    const b = fd.formatOpsDigest({ attentionOpen: 5, attentionLoud: 1, checksFailing: 2, checksStale: 1, paid: 3, delivered: 4 });
    if (b !== '5 waiting (1 urgent) · 2 failing, 1 stale · yesterday 3 paid, 4 delivered') return 'got: ' + b;
    const calm = fd.formatOpsDigest({ attentionOpen: 0, attentionLoud: 0, checksFailing: 0, checksStale: 0, paid: 0, delivered: 0 });
    if (calm !== '0 waiting · all checks ok · yesterday 0 paid, 0 delivered') return 'got: ' + calm;
    const blind = fd.formatOpsDigest({ attentionOpen: null, checksFailing: null, paid: null, delivered: null });
    return /^\? waiting · checks \? · yesterday \? paid, \? delivered$/.test(blind) ? null : 'a count that could not be read must show ?, got: ' + blind;
  });

  await check('digest push: one quiet daily_digest per day, opening the System screen', async () => {
    const sent = [];
    const r = await fd.pushOpsDigest('2026-10-05', { paid: 3, delivered: 4 }, {
      attention: { listAttention: async () => [{ kind: 'paid_unassigned' }, { kind: 'send_failed' }], levelFor: (k) => (k === 'paid_unassigned' ? 'loud' : 'quiet') },
      digestCounts: async () => ({ failing: 1, stale: 0 }),
      pushOpsEvent: async (e) => { sent.push(e); return { sent: true }; },
    });
    if (sent.length !== 1) return 'expected one push, got ' + sent.length;
    const e = sent[0];
    if (e.kind !== 'daily_digest' || e.dedupeKey !== '2026-10-05' || e.defaultMode !== 'quiet') return 'wrong kind / key / mode';
    if (e.data.screen !== 'system') return 'does not deep-link to the System screen';
    if (e.body !== '2 waiting (1 urgent) · 1 failing · yesterday 3 paid, 4 delivered') return 'body: ' + e.body;
    return r.pushed === true ? null : 'result does not report the push';
  });

  await check('digest push: a source that cannot be read costs a "?", not the digest', async () => {
    const sent = [];
    await fd.pushOpsDigest('2026-10-05', { paid: 1, delivered: null }, {
      attention: { listAttention: async () => { throw new Error('view gone'); }, levelFor: () => 'quiet' },
      digestCounts: async () => { throw new Error('table gone'); },
      pushOpsEvent: async (e) => { sent.push(e); return { sent: true }; },
    });
    return (sent.length === 1 && sent[0].body === '? waiting · checks ? · yesterday 1 paid, ? delivered') ? null : 'body: ' + (sent[0] && sent[0].body);
  });

  await check('it is the existing 09:00 Cairo digest that was extended — no second scheduler', () => {
    const src = read('src/services/funnel_digest.js');
    const m = /async function runFunnelDigest\(opts\) \{[\s\S]*?\n\}/.exec(src);
    if (!m) return 'runFunnelDigest not found';
    if (!/cairoHour\(now\) < 9/.test(m[0]) || !/__digest_sent/.test(m[0])) return 'the 09:00 once-a-day claim is gone';
    if (!/pushOpsDigest\(day, f/.test(m[0])) return 'the Command push is not sent from the existing digest';
    const server = read('src/server.js');
    return (server.match(/runFunnelDigest\(\)/g) || []).length === 1 ? null : 'the digest is scheduled more than once';
  });

})();
