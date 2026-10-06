'use strict';

// services/system_checks.js
//
// 6 Oct 2026 (watchtower) — the check registry (migration 127).
//
// One table, ops_checks, holds the latest result of every named check,
// whoever wrote it:
//
//   source 'portal'  this module's worker, every 5 minutes, from data the
//                    portal already has
//   source 'api'     POST /api/v1/ops/checks (routes/api/ops_checks.js)
//   source 'claude'  a scheduled Claude run writing the row by plain SQL
//
// THE PUSH DECISION IS NOT THE WRITER'S. A row written by SQL has no code path
// to push from, so pushing in the POST handler would make posted checks loud
// and SQL-written ones silent. Instead this worker compares each row's
// `status` with `pushed_status` and pushes on a difference, then records what
// it pushed. Every writer is therefore treated identically, and a check that
// stays failed is pushed once, not every five minutes.
//
// Three things are pushed, all through ops push:
//   system_check_failed     a check became 'fail'   (loud for site/cases/money)
//   system_check_recovered  a failed or warning check became 'ok'      (quiet)
//   system_check_stale      a check stopped reporting   (quiet; loud for site)
// plus ops_brief (quiet) for every new write of a claude.brief.* row.
//
// A move to 'warn' is not pushed: it shows on the System screen and in the
// daily digest. Nothing here throws into its caller.

const { queryAll, queryOne, execute } = require('../pg');
const logger = require('../logger');

// Through the module object, never destructured: a log write must not be able
// to throw into a check, and tests can observe it.
function logErrorToDb(err, ctx) {
  try { logger.logErrorToDb(err, ctx); } catch (_) { /* never throw from a log writer */ }
}

const AGENT_NAME = 'system_checks';
const INTERVAL_SECONDS = 5 * 60;

const AREAS = Object.freeze([
  'site', 'cases', 'money', 'notifications', 'doctors', 'growth',
  'mini', 'tash', 'credentials', 'backups', 'stores',
]);
const STATUSES = Object.freeze(['ok', 'warn', 'fail']);
const KEY_RE = /^[a-z0-9_.]{3,80}$/;
const SOURCE_RE = /^[a-z0-9_]{2,20}$/;
const MAX_SUMMARY = 300;
const MAX_DETAIL_BYTES = 4096;
const MAX_BATCH = 50;
const MIN_EXPECTED_SECONDS = 60;
const MAX_EXPECTED_SECONDS = 62 * 24 * 3600;
const DEFAULT_EXPECTED_SECONDS = 24 * 3600;
const HISTORY_RETENTION_DAYS = 90;

const BRIEF_PREFIX = 'claude.brief.';
const BRIEF_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);
const MAX_BRIEF_LINES = 30;

const LOUD_FAIL_AREAS = Object.freeze(['site', 'cases', 'money']);
const LOUD_STALE_AREAS = Object.freeze(['site']);

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate one posted check. Pure.
 * @returns {{ok:true, value:object}|{ok:false, error:string}}
 */
function validateCheck(input) {
  const c = input;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'check must be an object' };
  if (typeof c.check_key !== 'string' || !KEY_RE.test(c.check_key)) {
    return { ok: false, error: 'check_key must match ^[a-z0-9_.]{3,80}$' };
  }
  if (AREAS.indexOf(c.area) === -1) return { ok: false, error: 'area must be one of: ' + AREAS.join(', ') };
  if (STATUSES.indexOf(c.status) === -1) return { ok: false, error: 'status must be ok, warn or fail' };
  let summary = '';
  if (c.summary !== undefined && c.summary !== null) {
    if (typeof c.summary !== 'string') return { ok: false, error: 'summary must be a string' };
    if (c.summary.length > MAX_SUMMARY) return { ok: false, error: 'summary must be at most ' + MAX_SUMMARY + ' characters' };
    summary = c.summary;
  }
  let detail = null;
  if (c.detail !== undefined && c.detail !== null) {
    if (typeof c.detail !== 'object') return { ok: false, error: 'detail must be a JSON object or array' };
    let json;
    try { json = JSON.stringify(c.detail); } catch (_) { return { ok: false, error: 'detail is not serialisable' }; }
    if (Buffer.byteLength(json, 'utf8') > MAX_DETAIL_BYTES) {
      return { ok: false, error: 'detail must be at most ' + MAX_DETAIL_BYTES + ' bytes of JSON' };
    }
    detail = c.detail;
  }
  let expected = DEFAULT_EXPECTED_SECONDS;
  if (c.expected_every_seconds !== undefined && c.expected_every_seconds !== null) {
    const n = Number(c.expected_every_seconds);
    if (!Number.isInteger(n) || n < MIN_EXPECTED_SECONDS || n > MAX_EXPECTED_SECONDS) {
      return { ok: false, error: 'expected_every_seconds must be an integer from ' + MIN_EXPECTED_SECONDS + ' to ' + MAX_EXPECTED_SECONDS };
    }
    expected = n;
  }
  let source = 'api';
  if (c.source !== undefined && c.source !== null) {
    if (typeof c.source !== 'string' || !SOURCE_RE.test(c.source)) return { ok: false, error: 'source must match ^[a-z0-9_]{2,20}$' };
    source = c.source;
  }
  if (c.check_key.indexOf(BRIEF_PREFIX) === 0) {
    if (BRIEF_PERIODS.indexOf(c.check_key.slice(BRIEF_PREFIX.length)) === -1) {
      return { ok: false, error: 'brief key must be claude.brief.daily, .weekly or .monthly' };
    }
    const lines = detail && detail.lines;
    if (lines !== undefined && lines !== null) {
      if (!Array.isArray(lines) || lines.length > MAX_BRIEF_LINES || lines.some((l) => typeof l !== 'string')) {
        return { ok: false, error: 'detail.lines must be an array of at most ' + MAX_BRIEF_LINES + ' strings' };
      }
    }
  }
  return { ok: true, value: { check_key: c.check_key, area: c.area, status: c.status, summary, detail, expected_every_seconds: expected, source } };
}

/**
 * Validate a request body: one check or an array of 1..50. All-or-nothing.
 * @returns {{ok:true, checks:object[]}|{ok:false, error:string, errors?:object[]}}
 */
function validateBody(body) {
  const list = Array.isArray(body) ? body : [body];
  if (body === undefined || body === null || (Array.isArray(body) && !body.length)) {
    return { ok: false, error: 'body must be one check or an array of 1 to ' + MAX_BATCH };
  }
  if (list.length > MAX_BATCH) return { ok: false, error: 'at most ' + MAX_BATCH + ' checks per request' };
  const checks = [];
  const errors = [];
  const seen = new Set();
  list.forEach((c, index) => {
    const r = validateCheck(c);
    if (!r.ok) { errors.push({ index, error: r.error }); return; }
    if (seen.has(r.value.check_key)) { errors.push({ index, error: 'duplicate check_key in this request' }); return; }
    seen.add(r.value.check_key);
    checks.push(r.value);
  });
  if (errors.length) return { ok: false, error: 'validation failed', errors };
  return { ok: true, checks };
}

// ─── Writing ────────────────────────────────────────────────────────────────

// THE statement every writer uses — this module, the POST handler, and a
// Claude run writing by SQL (documented verbatim in the watchtower report).
// It never names pushed_status, pushed_at, stale_pushed or brief_pushed_at:
// those belong to the worker below, and a writer that set them would silence
// its own transition.
const UPSERT_SQL =
  'INSERT INTO ops_checks (check_key, area, status, summary, detail, checked_at, expected_every_seconds, source, updated_at) ' +
  'VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), $6, $7, NOW()) ' +
  'ON CONFLICT (check_key) DO UPDATE SET ' +
  '  area = EXCLUDED.area, status = EXCLUDED.status, summary = EXCLUDED.summary, detail = EXCLUDED.detail, ' +
  '  checked_at = EXCLUDED.checked_at, expected_every_seconds = EXCLUDED.expected_every_seconds, ' +
  '  source = EXCLUDED.source, updated_at = NOW()';

async function upsertCheck(c) {
  await execute(UPSERT_SQL, [
    c.check_key, c.area, c.status, String(c.summary || '').slice(0, MAX_SUMMARY),
    c.detail == null ? null : JSON.stringify(c.detail),
    c.expected_every_seconds || DEFAULT_EXPECTED_SECONDS, c.source || 'api',
  ]);
}

async function upsertChecks(checks) {
  for (const c of checks) await upsertCheck(c);
  return checks.length;
}

// ─── Reading: GET /api/v1/admin/system ──────────────────────────────────────

function _ms(v) { if (!v) return null; const n = (v instanceof Date ? v : new Date(v)).getTime(); return Number.isFinite(n) ? n : null; }
function _iso(v) { const n = _ms(v); return n === null ? null : new Date(n).toISOString(); }

/** Stale = now - checked_at exceeds TWICE expected_every_seconds. Pure. */
function isStale(checkedAt, expectedEverySeconds, now) {
  const at = _ms(checkedAt);
  if (at === null) return true;
  const expected = Number(expectedEverySeconds) > 0 ? Number(expectedEverySeconds) : DEFAULT_EXPECTED_SECONDS;
  return ((_ms(now) || Date.now()) - at) > 2 * expected * 1000;
}

const RANK = { ok: 0, warn: 1, fail: 2 };
function worst(a, b) { return (RANK[b] || 0) > (RANK[a] || 0) ? b : a; }

/** A check's status as it counts towards its area: stale counts as (at least) warn. */
function effectiveStatus(status, stale) {
  const s = STATUSES.indexOf(status) === -1 ? 'warn' : status;
  return stale ? worst(s, 'warn') : s;
}

function _detail(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

/**
 * Shape ops_checks rows into the GET /system payload. Pure.
 * Every area in AREAS is present, in that order; an area with no checks has
 * status 'none'. Brief rows are returned under `briefs`, not inside an area.
 */
function buildSystemPayload(rows, now) {
  const t = _ms(now) || Date.now();
  const byArea = {};
  AREAS.forEach((a) => { byArea[a] = []; });
  const briefs = { daily: null, weekly: null, monthly: null };

  (rows || []).forEach((r) => {
    const key = String(r.check_key || '');
    const detail = _detail(r.detail);
    const stale = isStale(r.checked_at, r.expected_every_seconds, t);
    if (key.indexOf(BRIEF_PREFIX) === 0) {
      const period = key.slice(BRIEF_PREFIX.length);
      if (BRIEF_PERIODS.indexOf(period) !== -1) {
        const lines = detail && Array.isArray(detail.lines) ? detail.lines : [];
        briefs[period] = {
          check_key: key,
          period,
          headline: r.summary || '',
          lines: lines.filter((l) => typeof l === 'string').slice(0, MAX_BRIEF_LINES),
          status: r.status,
          checked_at: _iso(r.checked_at),
          stale,
          source: r.source || null,
        };
      }
      return;
    }
    const area = AREAS.indexOf(r.area) === -1 ? null : r.area;
    if (!area) return;
    byArea[area].push({
      check_key: key,
      status: r.status,
      summary: r.summary || '',
      detail,
      checked_at: _iso(r.checked_at),
      expected_every_seconds: Number(r.expected_every_seconds) || DEFAULT_EXPECTED_SECONDS,
      stale,
      source: r.source || null,
    });
  });

  let overall = 'ok';
  let failing = 0, warning = 0, staleCount = 0, total = 0;
  const areas = AREAS.map((area) => {
    const checks = byArea[area].sort((a, b) => a.check_key.localeCompare(b.check_key));
    let status = checks.length ? 'ok' : 'none';
    checks.forEach((c) => {
      total++;
      if (c.stale) staleCount++;
      if (c.status === 'fail') failing++; else if (c.status === 'warn') warning++;
      status = worst(status, effectiveStatus(c.status, c.stale));
    });
    if (status !== 'none') overall = worst(overall, status);
    return { area, status, checks };
  });

  return {
    generated_at: new Date(t).toISOString(),
    status: overall,
    counts: { total, failing, warning, stale: staleCount },
    areas,
    briefs,
  };
}

async function readSystem(now) {
  const rows = (await queryAll(
    'SELECT check_key, area, status, summary, detail, checked_at, expected_every_seconds, source FROM ops_checks', []
  )) || [];
  return buildSystemPayload(rows, now || Date.now());
}

// ─── Transitions, staleness, briefs ─────────────────────────────────────────

/**
 * What a status change pushes. Pure.
 *   anything -> fail         system_check_failed
 *   warn|fail -> ok          system_check_recovered
 *   everything else          null  (first sighting as ok/warn, ok -> warn,
 *                                   fail -> warn, and "no change")
 */
function transitionKind(prev, status) {
  if (prev === status) return null;
  if (status === 'fail') return 'system_check_failed';
  if (status === 'ok' && (prev === 'warn' || prev === 'fail')) return 'system_check_recovered';
  return null;
}

function failedMode(area) { return LOUD_FAIL_AREAS.indexOf(area) !== -1 ? 'loud' : 'quiet'; }
function staleMode(area) { return LOUD_STALE_AREAS.indexOf(area) !== -1 ? 'loud' : 'quiet'; }

/**
 * Claim every row whose status differs from what was last pushed, atomically:
 * pushed_status moves in the same statement that reads the difference, and the
 * FOR UPDATE re-checks the predicate after any lock wait, so two instances
 * cannot both claim one transition. Returns the rows with their previous
 * pushed_status as `prev`.
 */
async function claimTransitions() {
  return (await queryAll(
    'WITH due AS (' +
    '  SELECT check_key, pushed_status AS prev FROM ops_checks ' +
    "   WHERE pushed_status IS DISTINCT FROM status AND check_key NOT LIKE '" + BRIEF_PREFIX + "%' " +
    '   FOR UPDATE' +
    ') ' +
    'UPDATE ops_checks c SET pushed_status = c.status, pushed_at = NOW() ' +
    '  FROM due WHERE c.check_key = due.check_key ' +
    'RETURNING c.check_key, c.area, c.status, c.summary, due.prev', []
  )) || [];
}

/** Claim checks that have just gone stale; re-arm the ones reporting again. */
async function claimStale() {
  const staleSql = "checked_at < NOW() - make_interval(secs => 2 * expected_every_seconds)";
  await execute('UPDATE ops_checks SET stale_pushed = false WHERE stale_pushed = true AND NOT (' + staleSql + ')', []);
  return (await queryAll(
    'UPDATE ops_checks SET stale_pushed = true WHERE stale_pushed = false AND ' + staleSql +
    ' RETURNING check_key, area, status, summary, checked_at, expected_every_seconds', []
  )) || [];
}

/** Claim every claude.brief.* row written since it was last pushed. */
async function claimBriefs() {
  return (await queryAll(
    'UPDATE ops_checks SET brief_pushed_at = checked_at, pushed_status = status ' +
    " WHERE check_key LIKE '" + BRIEF_PREFIX + "%' AND brief_pushed_at IS DISTINCT FROM checked_at " +
    'RETURNING check_key, area, status, summary, checked_at', []
  )) || [];
}

function _label(key) { return String(key || '').replace(/[._]/g, ' '); }

/**
 * Push whatever changed since the last pass. Each claim is its own try so one
 * failing does not stop the others.
 * @returns {Promise<{failed:number, recovered:number, stale:number, briefs:number}>}
 */
async function processPushes(deps) {
  const d = deps || {};
  const _transitions = d.claimTransitions || claimTransitions;
  const _stale = d.claimStale || claimStale;
  const _briefs = d.claimBriefs || claimBriefs;
  const _push = d.pushOpsEvent || require('./ops_push').pushOpsEvent;
  const out = { failed: 0, recovered: 0, stale: 0, briefs: 0 };

  try {
    for (const r of await _transitions()) {
      const kind = transitionKind(r.prev == null ? null : r.prev, r.status);
      if (!kind) continue;
      const failed = kind === 'system_check_failed';
      await _push({
        kind,
        dedupeKey: r.check_key,
        title: (failed ? 'Check failed: ' : 'Recovered: ') + _label(r.check_key),
        body: String(r.summary || (failed ? 'No summary given.' : 'Back to ok.')).slice(0, 300),
        data: { screen: 'system', checkKey: r.check_key, area: r.area, status: r.status },
        defaultMode: failed ? failedMode(r.area) : 'quiet',
      });
      if (failed) out.failed++; else out.recovered++;
    }
  } catch (err) { logErrorToDb(err, { context: 'system_checks.transitions', category: 'system_checks' }); }

  try {
    for (const r of await _stale()) {
      await _push({
        kind: 'system_check_stale',
        dedupeKey: r.check_key,
        title: 'Stopped reporting: ' + _label(r.check_key),
        body: 'Last heard ' + (_iso(r.checked_at) || 'never') + '; expected every ' +
              Math.round((Number(r.expected_every_seconds) || 0) / 60) + ' min.',
        data: { screen: 'system', checkKey: r.check_key, area: r.area, stale: true },
        defaultMode: staleMode(r.area),
      });
      out.stale++;
    }
  } catch (err) { logErrorToDb(err, { context: 'system_checks.stale', category: 'system_checks' }); }

  try {
    for (const r of await _briefs()) {
      const period = String(r.check_key).slice(BRIEF_PREFIX.length);
      await _push({
        kind: 'ops_brief',
        // The write's own timestamp: every NEW write is a new event.
        dedupeKey: r.check_key + ':' + (_iso(r.checked_at) || Date.now()),
        title: period.charAt(0).toUpperCase() + period.slice(1) + ' brief',
        body: String(r.summary || 'A new brief is ready.').slice(0, 300),
        data: { screen: 'system', brief: period, checkKey: r.check_key },
        defaultMode: 'quiet',
      });
      out.briefs++;
    }
  } catch (err) { logErrorToDb(err, { context: 'system_checks.briefs', category: 'system_checks' }); }

  return out;
}

// ─── Internal checks ────────────────────────────────────────────────────────

const STAFF_EMAIL_SQL = "COALESCE(u.email,'') !~* '@(tashkheesa\\.com|shifaegypt\\.com)$'";

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/** ai.spend: warn at 3x the 7-day daily average, fail at 6x. Pure. */
function classifyAiSpend(last24Usd, avgDailyUsd) {
  const last = Number(last24Usd) || 0;
  const avg = Number(avgDailyUsd) || 0;
  // Below a dollar a day a 6x swing is noise, not a runaway loop.
  if (avg <= 0 || last < 1) return { status: 'ok', ratio: avg > 0 ? last / avg : null };
  const ratio = last / avg;
  return { status: ratio >= 6 ? 'fail' : (ratio >= 3 ? 'warn' : 'ok'), ratio };
}

/** growth.signups: warn when nobody has signed up for 48 hours. Pure. */
function classifySignups(last48h) {
  return (Number(last48h) || 0) === 0 ? 'warn' : 'ok';
}

const INTERNAL = [
  // All registered workers alive. 'starting' (a freshly woken instance) is not
  // a failure, exactly as on /healthz.
  async function siteWorkers() {
    const { WORKER_SPECS, workerLiveness } = require('./admin_health');
    const rows = await queryAll(
      'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats ' +
      ' WHERE agent_name = ANY($1::text[]) GROUP BY agent_name', [WORKER_SPECS.map((s) => s.key)]);
    const by = {}; (rows || []).forEach((r) => { by[r.agent_name] = r.last_run; });
    const now = Date.now(); const up = Math.floor(process.uptime());
    const ws = WORKER_SPECS.map((s) => workerLiveness(s.key, by[s.key] || null, now, s.staleSeconds, up));
    const down = ws.filter((w) => w.status === 'down');
    return {
      check_key: 'site.workers', area: 'site', status: down.length ? 'fail' : 'ok',
      summary: down.length ? 'Down: ' + down.map((w) => w.name).join(', ')
        : (function () {
          const alive = ws.filter((w) => w.status === 'alive').length;
          const starting = ws.length - alive;
          // 'starting' = the instance has only just woken; not a failure.
          return alive + ' of ' + ws.length + ' workers alive' + (starting ? ', ' + starting + ' starting up' : '');
        })(),
      detail: { workers: ws.map((w) => ({ name: w.name, status: w.status, age_sec: w.ageSec })) },
    };
  },

  // The four below read v_needs_attention, so the number on the System screen
  // is the number on the Attention screen.
  async function casesPaidUnassigned() {
    const r = await queryOne(
      "SELECT COUNT(*)::int AS n, COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - waiting_since)) / 60), 0)::int AS oldest " +
      "  FROM v_needs_attention WHERE kind = 'paid_unassigned'", []);
    const n = (r && r.n) || 0; const oldest = (r && r.oldest) || 0;
    return {
      check_key: 'cases.paid_unassigned', area: 'cases',
      status: n === 0 ? 'ok' : (oldest >= 60 ? 'fail' : 'warn'),
      summary: n === 0 ? 'No paid case is waiting for a doctor'
        : plural(n, 'paid case') + ' with no doctor; oldest ' + oldest + ' min',
      detail: { count: n, oldest_minutes: oldest },
    };
  },

  async function casesSlaOverdue() {
    const { breachedCaseSql } = require('../routes/api/_assign_helpers');
    const r = await queryOne('SELECT COUNT(*)::int AS n FROM orders_active o WHERE ' + breachedCaseSql('o.'), []);
    const n = (r && r.n) || 0;
    return {
      check_key: 'cases.sla_overdue', area: 'cases', status: n === 0 ? 'ok' : (n >= 3 ? 'fail' : 'warn'),
      summary: n === 0 ? 'No open case is past its deadline' : plural(n, 'open case') + ' past deadline',
      detail: { count: n },
    };
  },

  async function moneyClaimsWaiting() {
    const r = await queryOne(
      "SELECT COUNT(*)::int AS n, COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - waiting_since)) / 60), 0)::int AS oldest " +
      "  FROM v_needs_attention WHERE kind = 'payment_claim' AND waiting_since < NOW() - INTERVAL '60 minutes'", []);
    const n = (r && r.n) || 0; const oldest = (r && r.oldest) || 0;
    return {
      check_key: 'money.claims_waiting', area: 'money',
      status: n === 0 ? 'ok' : (oldest >= 240 ? 'fail' : 'warn'),
      summary: n === 0 ? 'No transfer has waited over an hour'
        : plural(n, 'transfer') + ' waiting over 60 min; oldest ' + Math.round(oldest / 60) + 'h',
      detail: { count: n, oldest_minutes: oldest },
    };
  },

  async function moneyRefundsStale() {
    const r = await queryOne("SELECT COUNT(*)::int AS n FROM v_needs_attention WHERE kind = 'refund_stale'", []);
    const n = (r && r.n) || 0;
    return {
      check_key: 'money.refunds_stale', area: 'money', status: n === 0 ? 'ok' : 'warn',
      summary: n === 0 ? 'No refund has been open over 48 hours' : plural(n, 'refund') + ' open over 48 hours',
      detail: { count: n },
    };
  },

  async function notificationsFailed() {
    // notifications.at is timestamp WITHOUT time zone holding UTC digits.
    const rows = (await queryAll(
      "SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*)::int AS n FROM notifications " +
      " WHERE status = 'failed' AND at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC", [])) || [];
    const total = rows.reduce((a, r) => a + r.n, 0);
    const by = {}; rows.forEach((r) => { by[r.channel] = r.n; });
    return {
      check_key: 'notifications.failed', area: 'notifications',
      status: total === 0 ? 'ok' : (total >= 10 ? 'fail' : 'warn'),
      summary: total === 0 ? 'No failed sends in 24 hours'
        : plural(total, 'failed send') + ' in 24h (' + rows.map((r) => r.channel + ' ' + r.n).join(', ') + ')',
      detail: { total, by_channel: by },
    };
  },

  async function notificationsCritical() {
    const r = await queryOne(
      'SELECT COUNT(*)::int AS total, ' +
      '       COUNT(*) FILTER (WHERE delivered IS TRUE)::int AS delivered, ' +
      '       COUNT(*) FILTER (WHERE delivered IS FALSE)::int AS undelivered ' +
      "  FROM critical_alert_log WHERE sent_at > NOW() - INTERVAL '24 hours'", []);
    const total = (r && r.total) || 0, delivered = (r && r.delivered) || 0, undelivered = (r && r.undelivered) || 0;
    return {
      check_key: 'notifications.critical', area: 'notifications', status: undelivered > 0 ? 'fail' : 'ok',
      summary: total === 0 ? 'No critical alerts in 24 hours'
        : plural(total, 'critical alert') + ' in 24h: ' + delivered + ' delivered, ' + undelivered + ' not',
      detail: { total, delivered, undelivered },
    };
  },

  async function doctorsCoverage() {
    const rows = (await queryAll(
      "SELECT ref, who, summary FROM v_needs_attention WHERE kind = 'specialty_uncovered' ORDER BY ref", [])) || [];
    const none = rows.filter((r) => String(r.ref).indexOf(':urgent') === -1);
    const urgent = rows.filter((r) => String(r.ref).indexOf(':urgent') !== -1);
    return {
      check_key: 'doctors.coverage', area: 'doctors', status: rows.length ? 'warn' : 'ok',
      summary: !rows.length ? 'Every visible specialty has a ready doctor, including Urgent'
        : [none.length ? plural(none.length, 'specialty', 'specialties') + ' with no ready doctor' : '',
           urgent.length ? urgent.length + ' with no Urgent cover' : ''].filter(Boolean).join('; '),
      detail: { no_ready_doctor: none.map((r) => r.who), no_urgent_cover: urgent.map((r) => r.who) },
    };
  },

  async function growthSignups() {
    // users.created_at is timestamp WITHOUT time zone holding UTC digits.
    const nowUtc = "(NOW() AT TIME ZONE 'UTC')";
    const cairoMidnightUtc = "((date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC')";
    const r = await queryOne(
      'SELECT COUNT(*) FILTER (WHERE u.created_at >= ' + cairoMidnightUtc + ')::int AS today, ' +
      '       COUNT(*) FILTER (WHERE u.created_at >= ' + nowUtc + " - INTERVAL '48 hours')::int AS last48, " +
      '       COUNT(*) FILTER (WHERE u.created_at >= ' + cairoMidnightUtc + " - INTERVAL '7 days' " +
      '                          AND u.created_at <  ' + cairoMidnightUtc + ')::int AS prev7 ' +
      "  FROM users u WHERE u.role = 'patient' AND " + STAFF_EMAIL_SQL +
      '   AND u.created_at >= ' + nowUtc + " - INTERVAL '9 days'", []);
    const today = (r && r.today) || 0, last48 = (r && r.last48) || 0, prev7 = (r && r.prev7) || 0;
    const avg = Math.round((prev7 / 7) * 10) / 10;
    return {
      check_key: 'growth.signups', area: 'growth', status: classifySignups(last48),
      summary: last48 === 0 ? 'No signups in 48 hours (7-day average ' + avg + '/day)'
        : plural(today, 'signup') + ' today vs ' + avg + '/day over the last 7 days',
      detail: { today, last_48h: last48, avg_7d: avg },
    };
  },

  async function credentialsExpiring() {
    const ex = require('./ops_expiries');
    const s = ex.summariseExpiries(await ex.readExpiryRows(), new Date());
    return { check_key: 'credentials.expiring', area: 'credentials', status: s.status, summary: s.summary, detail: s.detail };
  },

  async function aiSpend() {
    // agent_token_log.logged_at is timestamp WITHOUT time zone holding UTC digits.
    const nowUtc = "(NOW() AT TIME ZONE 'UTC')";
    const r = await queryOne(
      'SELECT COALESCE(SUM(cost_usd) FILTER (WHERE logged_at >= ' + nowUtc + " - INTERVAL '24 hours'), 0)::float8 AS last24, " +
      '       COALESCE(SUM(cost_usd) FILTER (WHERE logged_at <  ' + nowUtc + " - INTERVAL '24 hours'), 0)::float8 AS prev7 " +
      '  FROM agent_token_log WHERE logged_at >= ' + nowUtc + " - INTERVAL '8 days'", []);
    const last24 = Number((r && r.last24) || 0); const avg = Number((r && r.prev7) || 0) / 7;
    const c = classifyAiSpend(last24, avg);
    const usd = (n) => '$' + (Math.round(n * 100) / 100).toFixed(2);
    return {
      check_key: 'ai.spend', area: 'money', status: c.status,
      summary: 'AI spend ' + usd(last24) + ' in 24h vs ' + usd(avg) + '/day over the previous 7 days' +
               (c.ratio !== null && avg > 0 ? ' (' + (Math.round(c.ratio * 10) / 10) + 'x)' : ''),
      detail: { last_24h_usd: Math.round(last24 * 100) / 100, avg_7d_usd: Math.round(avg * 100) / 100,
                ratio: c.ratio === null ? null : Math.round(c.ratio * 100) / 100 },
    };
  },
];

/**
 * Run every internal check. One that throws is reported as a warning naming
 * the failure — a check that cannot run is itself something to know — and the
 * rest still run.
 */
async function computeInternalChecks(list) {
  const out = [];
  for (const fn of (list || INTERNAL)) {
    try {
      const c = await fn();
      if (c) out.push(Object.assign({ expected_every_seconds: INTERVAL_SECONDS, source: 'portal' }, c));
    } catch (err) {
      logErrorToDb(err, { context: 'system_checks.' + (fn.name || 'check'), category: 'system_checks' });
    }
  }
  return out;
}

/**
 * One pass of the worker: write the internal checks, then push whatever
 * changed — for every row, whoever wrote it. Never throws.
 */
async function runSystemChecks(deps) {
  const d = deps || {};
  const result = { written: 0, failed: 0, recovered: 0, stale: 0, briefs: 0 };
  try {
    const checks = await (d.computeInternalChecks || computeInternalChecks)();
    const _upsert = d.upsertCheck || upsertCheck;
    for (const c of checks) {
      try { await _upsert(c); result.written++; }
      catch (err) { logErrorToDb(err, { context: 'system_checks.upsert', category: 'system_checks', checkKey: c.check_key }); }
    }
  } catch (err) { logErrorToDb(err, { context: 'system_checks.compute', category: 'system_checks' }); }
  try { Object.assign(result, await processPushes(d)); }
  catch (err) { logErrorToDb(err, { context: 'system_checks.push', category: 'system_checks' }); }
  return result;
}

/** Drop history older than 90 days. Returns the number of rows removed. */
async function pruneCheckHistory() {
  const r = await execute(
    "DELETE FROM ops_check_history WHERE checked_at < NOW() - INTERVAL '" + HISTORY_RETENTION_DAYS + " days'", []);
  return (r && r.rowCount) || 0;
}

/** Counts for the daily digest: failing and stale checks right now. */
async function digestCounts(now) {
  const p = await readSystem(now);
  return { failing: p.counts.failing, warning: p.counts.warning, stale: p.counts.stale, total: p.counts.total };
}

module.exports = {
  AGENT_NAME, INTERVAL_SECONDS, AREAS, STATUSES, KEY_RE, MAX_BATCH, MAX_SUMMARY, MAX_DETAIL_BYTES,
  HISTORY_RETENTION_DAYS, BRIEF_PREFIX, BRIEF_PERIODS, UPSERT_SQL,
  validateCheck, validateBody, upsertCheck, upsertChecks,
  isStale, effectiveStatus, buildSystemPayload, readSystem,
  transitionKind, failedMode, staleMode, claimTransitions, claimStale, claimBriefs, processPushes,
  classifyAiSpend, classifySignups, computeInternalChecks, runSystemChecks,
  pruneCheckHistory, digestCounts,
};
