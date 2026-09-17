// tests/core/stranded-paid-case-rebroadcast.test.js
//
// A2 (AUDIT 2026-09-09) — a paid case must always have a durable path to a
// doctor. markCasePaid fires broadcastOrderToSpecialty fire-and-forget; if it
// throws or the process restarts, the case is left status=PAID / no doctor /
// acceptance_deadline_at NULL and only the stranded-paid-case sweep on the
// 5-minute SLA tick picks it up again.
//
// Launch gate 2026-09-15 (Task 2) — rewritten deliberately. The sweep had no
// payment check (a refunded row still at status PAID was re-broadcast every
// five minutes forever), no start date (the first tick broadcast every
// historical match), no retry cap, and it skipped a row whose doctor_id is ''
// — which the accept claim, the broadcast claim and the acceptance watcher
// also refused to treat as unassigned. This guard pins:
//
//   * the fetch SQL: payment predicate, start date BOUND as a parameter, no
//     COALESCE(paid_at, updated_at) fallback, NULLIF(doctor_id, ''), and the
//     terminal-event exclusion;
//   * a fake orders store that HONOURS those predicates (it reads the SQL it
//     is handed), driven across 8 ticks: exactly 6 broadcasts, one guarded
//     park at manual_queue, one registered terminal event, one final push the
//     per-order "stuck" throttle cannot swallow, then scanned 0;
//   * restart durability, a throwing park retried, a 0-row park still
//     terminal, refunded / pre-start / NULL-paid_at rows never swept;
//   * the empty-string doctor through the sweep, the broadcast claim, the
//     accept claim (same-doctor retry and CASE_ALREADY_TAKEN intact) and the
//     acceptance watcher;
//   * a thrown sweep error never fails the SLA job;
//   * with a local DATABASE_URL, the real fetch SQL and park UPDATE inside
//     BEGIN … ROLLBACK.
//
// Fix round 1 (controller ruling T2-R3) adds:
//   * the reset contract: both manual-queue approve handlers write
//     CASE_ROUTING_RESET when they release a case to automatic routing with no
//     doctor, and the sweep's terminal-event exclusion and both of its counts
//     only consider events after the latest reset — parked → reset → six more
//     attempts → parked again; a terminal event with no later reset stays
//     excluded (both handlers are driven for real in a child process);
//   * the park also requires acceptance_deadline_at IS NULL, and a park refused
//     because the case was taken meanwhile is recorded quietly (reason taken);
//   * the attempt is recorded BEFORE the broadcast with an INSERT that throws,
//     so a failing write skips the case instead of retrying uncapped;
//   * a successful 6th attempt never parks, and no bare doctor_id IS NULL sits
//     next to or instead of NULLIF at any of the seven unassigned predicates.
//
// The claim / containment checks run in a child process with a stubbed
// src/pg so the parent suite's require cache is never touched (same approach
// as theme8-notification-dropped). Every assertion was verified negatively;
// the record is in the commit body.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stripComments } = require('../_helpers/strip-comments');

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n♻️  A2 — stranded paid cases: payment check, start date, retry cap, empty-string doctor\n');

const ROOT = path.join(__dirname, '..', '..');
const worker = require('../../src/case_sla_worker');
const lifecycle = require('../../src/case_lifecycle');

function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

const START_ISO = '2026-09-15T00:00:00Z';
const MAX = 6;
const RETRY_EVENT = 'CASE_ROUTING_RETRIED';
const PARKED_EVENT = 'CASE_ROUTING_RETRY_FAILED';
const RESET_EVENT = 'CASE_ROUTING_RESET';
// The fake store's database clock (NOW()). Fixed, so the guard does not depend
// on when it runs relative to the start date.
const DB_NOW_MS = Date.parse('2026-09-20T12:00:00Z');
const PAID_AT = '2026-09-20T09:00:00Z';
const PRE_START_PAID_AT = '2026-09-14T23:59:00Z';
const YOUNG_PAID_AT = new Date(DB_NOW_MS - 5 * 60000).toISOString();

function needImpl() {
  if (typeof worker.STRANDED_PAID_START_ISO !== 'string' ||
      typeof worker.STRANDED_PAID_MAX_ATTEMPTS !== 'number' ||
      typeof worker.STRANDED_PAID_PARKED_EVENT !== 'string') {
    return 'not implemented: STRANDED_PAID_START_ISO / STRANDED_PAID_MAX_ATTEMPTS / STRANDED_PAID_PARKED_EVENT are not exported';
  }
  return null;
}

async function check(name, fn) {
  let timer = null;
  try {
    const why = await Promise.race([
      Promise.resolve().then(fn),
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error('timed out after 25s')); }, 25000);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (why) t.fail(name, new Error(why)); else t.pass(name);
  } catch (err) {
    t.fail(name, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── The fake world ──────────────────────────────────────────────────────────
//
// `rows` is the orders table, `events` is case_events. queryAll applies the
// predicates the fetch SQL actually carries: drop the payment predicate and a
// refunded row comes back; restore COALESCE(paid_at, updated_at) and a NULL
// paid_at row comes back; drop NULLIF and an empty-string row disappears.

function fakeFetch(sql, params, w) {
  const P = function (n) { return params[Number(n) - 1]; };
  const clean = String(sql).replace(/--[^\n]*/g, '');
  const statusPaid = /LOWER\(COALESCE\((?:o\.)?status, ''\)\)\s*=\s*'paid'/.test(clean);
  const payment = /LOWER\(COALESCE\((?:o\.)?payment_status, ''\)\)\s+IN\s+\('paid', 'captured'\)/.test(clean);
  const nullif = /NULLIF\((?:o\.)?doctor_id, ''\) IS NULL/.test(clean);
  const bareNull = /(?:^|[\s(])(?:o\.)?doctor_id IS NULL/.test(clean);
  const noDeadline = /acceptance_deadline_at IS NULL/.test(clean);
  const manual = /COALESCE\((?:o\.)?assignment_status, ''\) NOT IN \('manual_queue', 'manual_pending', 'manual_claimed'\)/.test(clean);
  const coalescedTime = /COALESCE\((?:o\.)?paid_at, (?:o\.)?updated_at\)/.test(clean);
  const age = clean.match(/<\s*NOW\(\)\s*-\s*make_interval\(mins => \$(\d+)\)/);
  const start = clean.match(/paid_at >= \$(\d+)::timestamptz/);
  const paidNotNull = /paid_at IS NOT NULL/.test(clean);
  const term = clean.match(/NOT EXISTS\s*\([\s\S]*?case_events[\s\S]*?event_type = \$(\d+)/);
  const reset = clean.match(/r\.event_type = \$(\d+)\s+AND r\.created_at >= ce\.created_at/);
  return w.rows.filter(function (r) {
    if (r.deleted_at) return false; // orders_active
    if (statusPaid && String(r.status || '').toLowerCase() !== 'paid') return false;
    if (payment) {
      const ps = String(r.payment_status || '').toLowerCase();
      if (ps !== 'paid' && ps !== 'captured') return false;
    }
    if (nullif) {
      if (!(r.doctor_id == null || r.doctor_id === '')) return false;
    } else if (bareNull) {
      if (r.doctor_id != null) return false;
    }
    if (noDeadline && r.acceptance_deadline_at != null) return false;
    if (manual && ['manual_queue', 'manual_pending', 'manual_claimed'].indexOf(r.assignment_status == null ? '' : r.assignment_status) !== -1) return false;
    if (paidNotNull && r.paid_at == null) return false;
    const eff = coalescedTime ? (r.paid_at != null ? r.paid_at : r.updated_at) : r.paid_at;
    if (age) {
      if (eff == null) return false;
      if (!(Date.parse(eff) < DB_NOW_MS - Number(P(age[1])) * 60000)) return false;
    }
    if (start) {
      if (r.paid_at == null) return false;
      if (Date.parse(r.paid_at) < Date.parse(P(start[1]))) return false;
    }
    if (term && liveEvents(w, r.id, P(term[1]), reset ? P(reset[1]) : null).length) return false;
    return true;
  }).map(function (r) { return { id: r.id }; });
}

// Events of `type` for the case. When the SQL scopes them to the latest reset
// (`r.event_type = $n AND r.created_at >= ce.created_at`), an event with a
// reset at or after it (by insertion order) is ignored — exactly what the
// NOT EXISTS does in Postgres.
function liveEvents(w, caseId, type, resetType) {
  return w.events.filter(function (e) {
    if (e.caseId !== caseId || e.type !== type) return false;
    if (!resetType) return true;
    return !w.events.some(function (x) { return x.caseId === caseId && x.type === resetType && x.seq >= e.seq; });
  });
}

function fakeQueryOne(sql, params, w) {
  const s = String(sql);
  if (/FROM case_events/.test(s)) {
    const lit = s.match(/event_type = '([A-Z_]+)'/);
    const type = lit ? lit[1] : params[1];
    const reset = s.match(/r\.event_type = \$(\d+)\s+AND r\.created_at >= ce\.created_at/);
    return { c: liveEvents(w, params[0], type, reset ? params[Number(reset[1]) - 1] : null).length };
  }
  // The re-read after a refused park: evaluates whichever "taken" arms it selects.
  if (/FROM orders_active\s+WHERE id = \$1/.test(s)) {
    const row = w.rows.find(function (r) { return r.id === params[0] && !r.deleted_at; });
    if (!row) return null;
    const sel = s.slice(0, s.search(/\bFROM\b/));
    let taken = false;
    if (/NULLIF\(doctor_id, ''\) IS NOT NULL/.test(sel) && !(row.doctor_id == null || row.doctor_id === '')) taken = true;
    if (/acceptance_deadline_at IS NOT NULL/.test(sel) && row.acceptance_deadline_at != null) taken = true;
    return { taken: taken };
  }
  return null;
}

// execute: a case_events INSERT lands in `events` (or throws while
// failRetryInsert is set), an event-payload UPDATE rewrites it, anything else
// is the park.
function fakeExecute(sql, params, w) {
  const s = String(sql);
  if (/^\s*INSERT INTO case_events\b/i.test(s)) {
    if (w.failRetryInsert && params[2] === RETRY_EVENT) throw new Error('case_events insert failed');
    w.ops.push('event:' + params[2]);
    w.events.push({ id: params[0], caseId: params[1], type: params[2], payload: params[3] == null ? null : JSON.parse(params[3]), tick: w.tick, seq: w.seq++ });
    return { rowCount: 1 };
  }
  if (/^\s*UPDATE case_events\b/i.test(s)) {
    const ev = w.events.find(function (e) { return e.id != null && params.indexOf(e.id) !== -1; });
    const m = s.match(/SET event_payload = \$(\d+)/);
    if (!ev || !m) return { rowCount: 0 };
    ev.payload = JSON.parse(params[Number(m[1]) - 1]);
    return { rowCount: 1 };
  }
  return fakePark(sql, params, w);
}

function fakePark(sql, params, w) {
  if (!/UPDATE\s+orders\b/i.test(sql)) return { rowCount: 0 };
  const row = w.rows.find(function (r) { return params.indexOf(r.id) !== -1; });
  if (!row) return { rowCount: 0 };
  const where = String(sql).slice(String(sql).search(/\bWHERE\b/i));
  const d = row.doctor_id;
  if (/NULLIF\(doctor_id, ''\) IS NULL/.test(where)) {
    if (!(d == null || d === '')) return { rowCount: 0 };
  } else if (/doctor_id IS NULL/.test(where)) {
    if (d != null) return { rowCount: 0 };
  }
  if (/COALESCE\(assignment_status, 'auto'\) = 'auto'/.test(where)) {
    if ((row.assignment_status == null ? 'auto' : row.assignment_status) !== 'auto') return { rowCount: 0 };
  }
  if (/deleted_at IS NULL/.test(where) && row.deleted_at) return { rowCount: 0 };
  if (/acceptance_deadline_at IS NULL/.test(where) && row.acceptance_deadline_at != null) return { rowCount: 0 };
  const set = String(sql).slice(0, String(sql).search(/\bWHERE\b/i));
  const m = set.match(/assignment_status = '([a-z_]+)'/);
  if (m) row.assignment_status = m[1];
  if (/doctor_id = NULL/.test(set)) row.doctor_id = null;
  return { rowCount: 1 };
}

function makeWorld(opts) {
  opts = opts || {};
  const w = {
    tick: 0,
    seq: 0, // insertion order of case_events — stands in for created_at
    rows: (opts.rows || []).map(function (r) {
      return Object.assign({
        status: 'PAID', payment_status: 'paid', paid_at: PAID_AT, updated_at: PAID_AT,
        doctor_id: null, acceptance_deadline_at: null, assignment_status: 'auto', deleted_at: null,
      }, r);
    }),
    events: [],
    fetches: [], counts: [], executes: [], broadcasts: [], pushes: [], errors: [], ops: [],
    claimed: new Set(),
    failRetryInsert: false,
  };
  for (const e of (opts.events || [])) w.events.push(Object.assign({}, e, { seq: w.seq++ }));
  const broadcastImpl = opts.broadcast || async function () { return { ok: false, reason: 'stub_failed' }; };
  w.deps = {
    queryAll: async function (sql, params) { w.fetches.push({ sql: sql, params: params || [] }); return fakeFetch(sql, params || [], w); },
    queryOne: async function (sql, params) { w.counts.push({ sql: sql, params: params || [] }); return fakeQueryOne(sql, params || [], w); },
    execute: async function (sql, params) { w.executes.push({ sql: sql, params: params || [], tick: w.tick }); return fakeExecute(sql, params || [], w); },
    broadcast: async function (caseId) {
      w.ops.push('broadcast');
      w.broadcasts.push({ caseId: caseId, tick: w.tick });
      const res = await broadcastImpl(caseId, w);
      if (res && res.ok) {
        const row = w.rows.find(function (r) { return r.id === caseId; });
        if (row) row.acceptance_deadline_at = '2026-09-20T12:30:00Z';
      }
      return res;
    },
    // Like the real logCaseEvent, a failed INSERT is swallowed: nothing lands and
    // nothing is thrown.
    logCaseEvent: async function (caseId, type, payload) {
      if (w.failRetryInsert && type === RETRY_EVENT) return;
      w.ops.push('event:' + type);
      w.events.push({ caseId: caseId, type: type, payload: payload, tick: w.tick, seq: w.seq++ });
    },
    // Honours ops_push's claim: a repeat of the same kind:dedupeKey is throttled.
    pushOpsEvent: async function (o) {
      const key = String(o.kind) + ':' + String(o.dedupeKey);
      const throttled = w.claimed.has(key);
      w.claimed.add(key);
      w.pushes.push(Object.assign({ throttled: throttled, tick: w.tick }, o));
      return throttled ? { sent: false, skipped: 'throttled' } : { sent: true };
    },
    logErrorToDb: function (err, ctx) { w.errors.push({ err: err, ctx: ctx || {} }); },
  };
  return w;
}

async function tick(w) {
  w.tick++;
  const rows = await worker.fetchStrandedPaidCases({ deps: w.deps });
  let placed = 0;
  for (const c of rows) placed += await worker.handleStrandedPaidCase(c, { deps: w.deps });
  return { scanned: rows.length, placed: placed };
}

function retryEvents(w, caseId) {
  return w.events.filter(function (e) { return e.type === RETRY_EVENT && (!caseId || e.caseId === caseId); });
}
function terminalEvents(w, caseId) {
  return w.events.filter(function (e) { return e.type === worker.STRANDED_PAID_PARKED_EVENT && (!caseId || e.caseId === caseId); });
}
function parks(w) {
  return w.executes.filter(function (x) { return /UPDATE\s+orders\b/i.test(x.sql); });
}
function seedAttempts(caseId, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ caseId: caseId, type: RETRY_EVENT, payload: { attempt: i, ok: false } });
  return out;
}
// What an approve handler leaves behind when it releases the case to 'auto'.
function addReset(w, caseId) {
  w.events.push({ caseId: caseId, type: RESET_EVENT, payload: { via: 'guard_operator' }, tick: w.tick, seq: w.seq++ });
}

// ── Child process with a stubbed src/pg ─────────────────────────────────────

function runChild(fn, marker) {
  const script =
    "'use strict';\n" +
    'const path = require("path");\n' +
    'const ROOT = ' + JSON.stringify(ROOT) + ';\n' +
    'const pg = require(path.join(ROOT, "src", "pg"));\n' +
    '(' + fn.toString() + ')(ROOT, pg, path).then(function (out) {\n' +
    '  process.stdout.write(' + JSON.stringify(marker) + ' + JSON.stringify(out) + "\\n");\n' +
    '  process.exit(0);\n' +
    '}).catch(function (err) {\n' +
    '  process.stderr.write("CHILD_ERROR: " + ((err && err.stack) || err) + "\\n");\n' +
    '  process.exit(2);\n' +
    '});\n';
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { DATABASE_URL: '', PG_SSL: 'false', PORT: '1', EMAIL_TEST_STUB: 'true' }),
    });
  } catch (e) {
    const stderr = String((e && e.stderr) || (e && e.message) || e);
    throw new Error('child process failed: ' + stderr.slice(-900));
  }
  const line = String(out).split('\n').find(function (l) { return l.indexOf(marker) === 0; });
  if (!line) throw new Error('child printed no ' + marker + ' line');
  return JSON.parse(line.slice(marker.length));
}

// Runs in the child: broadcastOrderToSpecialty's claim UPDATE against a stub
// that evaluates the claim's WHERE the way Postgres would.
async function broadcastClaimChild(ROOT, pg, path) {
  let current = null;
  const claims = [];
  pg.queryOne = async function (sql) {
    if (/FROM orders_active WHERE id = \$1/.test(sql)) return current ? Object.assign({}, current) : null;
    return null;
  };
  pg.queryAll = async function () { return []; };
  pg.execute = async function (sql, params) {
    if (/UPDATE orders/.test(sql) && /acceptance_deadline_at = \$3/.test(sql)) {
      const where = sql.slice(sql.search(/WHERE/));
      const d = current.doctor_id;
      let ok;
      if (/NULLIF\(doctor_id, ''\) IS NULL/.test(where)) ok = (d == null || d === '');
      else if (/doctor_id IS NULL/.test(where)) ok = (d == null);
      else ok = true;
      claims.push({ id: current.id, rowCount: ok ? 1 : 0 });
      return { rowCount: ok ? 1 : 0 };
    }
    return { rowCount: 0 };
  };
  const { broadcastOrderToSpecialty } = require(path.join(ROOT, 'src', 'notify', 'broadcast'));
  const scenarios = [
    { id: 'ord-empty', doctor_id: '' },
    { id: 'ord-null', doctor_id: null },
    { id: 'ord-held', doctor_id: 'doc-2' },
  ];
  const out = [];
  for (const s of scenarios) {
    // specialty_id and service_id are NULL, so a claim that lands returns
    // no_specialty before any doctor query or fan-out.
    current = Object.assign({
      status: 'PAID', payment_status: 'paid', assignment_status: 'auto',
      specialty_id: null, service_id: null, urgency_tier: 'standard',
    }, s);
    const r = await broadcastOrderToSpecialty(s.id);
    out.push({
      id: s.id, ok: !!(r && r.ok), reason: r && r.reason,
      claims: claims.filter(function (c) { return c.id === s.id; }).map(function (c) { return c.rowCount; }),
    });
  }
  return out;
}

// Runs in the child: assignDoctor's first-assignment claim. Everything after a
// claim that lands throws STOP_AFTER_CLAIM, so nothing past the claim runs.
async function acceptClaimChild(ROOT, pg, path) {
  const STOP = 'STOP_AFTER_CLAIM';
  let current = null;
  let stop = false;
  const claims = [];
  pg.queryOne = async function (sql) {
    if (/information_schema\.columns/.test(sql)) return { present: 1 };
    if (stop) throw new Error(STOP);
    if (/FROM orders WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) return Object.assign({}, current);
    return null;
  };
  pg.queryAll = async function () { if (stop) throw new Error(STOP); return []; };
  pg.execute = async function (sql, params) {
    if (/UPDATE orders SET doctor_id = \$1\s+WHERE id = \$2/.test(sql)) {
      const where = sql.slice(sql.search(/WHERE/));
      const d = current.doctor_id;
      let ok = false;
      if (/NULLIF\(doctor_id, ''\) IS NULL/.test(where) && (d == null || d === '')) ok = true;
      if (/\(\s*doctor_id IS NULL/.test(where) && d == null) ok = true;
      if (/doctor_id = \$1/.test(where) && d === params[0]) ok = true;
      claims.push({ id: current.id, rowCount: ok ? 1 : 0, where: where.replace(/\s+/g, ' ').trim() });
      if (ok) { current.doctor_id = params[0]; stop = true; }
      return { rowCount: ok ? 1 : 0 };
    }
    if (stop) throw new Error(STOP);
    return { rowCount: 0 };
  };
  pg.withTransaction = async function () { throw new Error(STOP); };
  const lc = require(path.join(ROOT, 'src', 'case_lifecycle'));
  const scenarios = [
    { id: 'ord-empty', doctor_id: '', by: 'doc-1' },
    { id: 'ord-null', doctor_id: null, by: 'doc-1' },
    { id: 'ord-mine', doctor_id: 'doc-1', by: 'doc-1' },
    { id: 'ord-taken', doctor_id: 'doc-2', by: 'doc-1' },
  ];
  const out = [];
  for (const s of scenarios) {
    stop = false;
    current = {
      id: s.id, doctor_id: s.doctor_id, status: 'PAID', payment_status: 'paid',
      paid_at: '2026-09-20T09:00:00Z', tier: 'standard', sla_hours: 48,
    };
    let codeOut = null;
    let message = null;
    try { await lc.assignDoctor(s.id, s.by); } catch (err) { codeOut = (err && err.code) || null; message = err && err.message; }
    out.push({ id: s.id, claims: claims.filter(function (c) { return c.id === s.id; }), code: codeOut, message: message });
  }
  return out;
}

// Runs in the child: the real SLA sweep with every fetch returning nothing
// except the stranded-paid fetch, which throws.
async function containmentChild(ROOT, pg, path) {
  let strandedFetchSeen = false;
  pg.queryAll = async function (sql) {
    if (/acceptance_deadline_at IS NULL/.test(sql) && /FROM orders_active/.test(sql)) {
      strandedFetchSeen = true;
      throw new Error('stranded fetch boom');
    }
    return [];
  };
  pg.queryOne = async function () { return { c: 0, count: 0, n: 0 }; };
  pg.execute = async function () { return { rowCount: 0 }; };
  const w = require(path.join(ROOT, 'src', 'case_sla_worker'));
  let result = null;
  let threw = null;
  try { result = await w.runCaseSlaSweep(new Date()); } catch (err) { threw = String((err && err.message) || err); }
  return { result: result, threw: threw, strandedFetchSeen: strandedFetchSeen };
}

// Runs in the child: the REAL web POST /superadmin/manual-queue/:id/approve,
// plucked off router.stack, over a stubbed src/pg. Records the routing write,
// the finalize fallback's reset UPDATE and every case_events INSERT in order.
async function webApproveChild(ROOT, pg, path) {
  const norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  const rec = { scn: null, log: [], errors: [] };
  pg.queryOne = async function (sql, params) {
    const s = norm(sql);
    if (/FROM orders_active WHERE id = \$1/.test(s) && /assignment_status/.test(s)) {
      return { id: params[0], patient_id: 'pat-1', assignment_status: 'manual_queue', payment_status: 'paid', specialty_id: 'spec-1', service_id: 'svc-1' };
    }
    if (/FROM services WHERE id = \$1/.test(s)) return { id: 'svc-1', specialty_id: 'spec-1' };
    return null;
  };
  pg.queryAll = async function () { return []; };
  pg.execute = async function (sql, params) {
    const s = norm(sql);
    if (/^INSERT INTO case_events/.test(s)) {
      rec.log.push({ op: 'event', type: params[2], caseId: params[1] });
      if (rec.scn.failResetInsert && params[2] === 'CASE_ROUTING_RESET') throw new Error('reset insert failed');
      return { rowCount: 1 };
    }
    if (/^UPDATE orders SET specialty_id/.test(s)) {
      rec.log.push({ op: 'route', status: /doctor_id = \$3/.test(s) ? params[3] : params[2] });
      return { rowCount: 1 };
    }
    if (/^UPDATE orders SET doctor_id = NULL, assignment_status = 'auto'/.test(s)) {
      rec.log.push({ op: 'fallback_reset', rowCount: rec.scn.fallbackRows });
      return { rowCount: rec.scn.fallbackRows };
    }
    return { rowCount: 1 };
  };
  pg.withTransaction = async function () { throw new Error('unexpected transaction'); };
  const assign = require(path.join(ROOT, 'src', 'services', 'assign_case'));
  assign.checkHandpickedDoctorEligibility = async function (orderId, doctorId) {
    return doctorId === 'doc-ok' ? { ok: true, doctorName: 'Dr OK' } : { ok: false, code: 'DOCTOR_PAUSED' };
  };
  assign.finalizeHandpickedAssignment = async function () { return rec.scn.finalizeOk ? { ok: true } : { ok: false, reason: 'finalize_boom' }; };
  require(path.join(ROOT, 'src', 'job_queue')).enqueueAutoAssign = async function () { return null; };
  require(path.join(ROOT, 'src', 'notify', 'broadcast')).broadcastOrderToSpecialty = async function () { rec.log.push({ op: 'broadcast' }); return { ok: false, reason: 'child' }; };
  require(path.join(ROOT, 'src', 'logger')).logErrorToDb = function (err, ctx) {
    rec.errors.push({ message: err && err.message, context: ctx && ctx.context, orderId: ctx && ctx.orderId });
  };
  const { router } = require(path.join(ROOT, 'src', 'routes', 'superadmin'));
  const layer = router.stack.find(function (l) { return l.route && l.route.path === '/superadmin/manual-queue/:id/approve' && l.route.methods.post; });
  if (!layer) throw new Error('web approve handler not on router.stack');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const scenarios = [
    { name: 'no-doctor', doctor: '' },
    { name: 'ineligible-pick', doctor: 'doc-bad' },
    { name: 'assigned-ok', doctor: 'doc-ok', finalizeOk: true },
    { name: 'finalize-failed', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 1 },
    { name: 'finalize-failed-not-released', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 0 },
    { name: 'no-doctor-insert-fails', doctor: '', failResetInsert: true },
    { name: 'finalize-failed-insert-fails', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 1, failResetInsert: true },
  ];
  const out = [];
  for (const scn of scenarios) {
    rec.scn = scn; rec.log = []; rec.errors = [];
    const orderId = 'ord-web-' + scn.name;
    let redirect = null;
    let threw = null;
    const req = { params: { id: orderId }, body: { specialty_id: 'spec-1', service_id: 'svc-1', doctor_id: scn.doctor }, user: { id: 'sa-1', role: 'superadmin' }, query: {}, session: {}, requestId: 'rq-1' };
    const res = { locals: {}, status: function () { return res; }, redirect: function (u) { redirect = u; return res; }, send: function () { return res; }, render: function () { return res; }, json: function () { return res; } };
    try { await handler(req, res, function () {}); } catch (e) { threw = String((e && e.message) || e); }
    await new Promise(function (r) { setTimeout(r, 20); });
    out.push({ name: scn.name, orderId: orderId, redirect: redirect, threw: threw, log: rec.log.slice(), errors: rec.errors.slice() });
  }
  return out;
}

// Runs in the child: the REAL Command POST /manual-queue/:id/approve from the
// admin router factory, with a fake db (its txn client), fake helpers.safeRun
// and injected routing deps.
async function apiApproveChild(ROOT, pg, path) {
  const norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  const rec = { scn: null, log: [], errors: [] };
  const assign = require(path.join(ROOT, 'src', 'services', 'assign_case'));
  assign.checkHandpickedDoctorEligibility = async function (orderId, doctorId) {
    return doctorId === 'doc-ok' ? { ok: true, doctorName: 'Dr OK' } : { ok: false, code: 'DOCTOR_PAUSED' };
  };
  assign.finalizeHandpickedAssignment = async function () { return rec.scn.finalizeOk ? { ok: true } : { ok: false, reason: 'finalize_boom' }; };
  const eventInsert = function (via, params) {
    rec.log.push({ op: 'event', via: via, type: params[2], caseId: params[1] });
    if (rec.scn.failResetInsert && params[2] === 'CASE_ROUTING_RESET') throw new Error('reset insert failed');
  };
  const client = {
    query: async function (sql, params) {
      const s = norm(sql);
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') { rec.log.push({ op: s }); return { rows: [], rowCount: 0 }; }
      if (/FROM orders WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(s)) {
        return { rows: [{ id: params[0], patient_id: 'pat-1', assignment_status: 'manual_queue', payment_status: 'paid', specialty_id: 'spec-1', service_id: 'svc-1' }] };
      }
      if (/FROM services WHERE id = \$1/.test(s)) return { rows: [{ id: 'svc-1', specialty_id: 'spec-1' }] };
      if (/FROM specialty_classifications/.test(s)) return { rows: [] };
      if (/^UPDATE orders SET specialty_id/.test(s)) {
        rec.log.push({ op: 'route', status: /doctor_id = \$3/.test(s) ? params[3] : params[2] });
        return { rows: [{ id: params[params.length - 1] }], rowCount: 1 };
      }
      if (/^INSERT INTO case_events/.test(s)) { eventInsert('client', params); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    },
    release: function () {},
  };
  const db = { connect: async function () { return client; } };
  const safeRun = async function (sql, params) {
    const s = norm(sql);
    if (/^UPDATE orders SET doctor_id = NULL, assignment_status = 'auto'/.test(s)) {
      rec.log.push({ op: 'fallback_reset', rowCount: rec.scn.fallbackRows });
      return { rowCount: rec.scn.fallbackRows };
    }
    if (/^INSERT INTO case_events/.test(s)) { eventInsert('safeRun', params); return { rowCount: 1 }; }
    return { rowCount: 1 };
  };
  const helpers = {
    safeGet: async function () { return null; }, safeAll: async function () { return []; }, safeRun: safeRun,
    mustGet: async function () { return null; }, mustAll: async function () { return []; },
  };
  const deps = {
    enqueueAutoAssign: async function () { return null; },
    broadcastOrderToSpecialty: async function () { rec.log.push({ op: 'broadcast' }); return { ok: false }; },
    logErrorToDb: function (err, ctx) { rec.errors.push({ message: err && err.message, context: ctx && ctx.context, orderId: ctx && ctx.orderId }); },
    logCaseEvent: async function (caseId, type) { rec.log.push({ op: 'logCaseEvent', type: type }); },
    queueMultiChannelNotification: async function () { return { ok: true }; },
    ensureConversation: async function () { return null; },
    notifyCaseAssigned: async function () { return null; },
    issueDoctorWelcome: async function () { return null; },
    recomputeOnRefund: async function () { return null; },
  };
  const origError = console.error;
  console.error = function () {};
  const router = require(path.join(ROOT, 'src', 'routes', 'api', 'admin'))(db, helpers, { gitSha: 'guard' }, deps);
  const layer = router.stack.find(function (l) { return l.route && l.route.path === '/manual-queue/:id/approve' && l.route.methods.post; });
  if (!layer) throw new Error('Command approve handler not on router.stack');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const scenarios = [
    { name: 'no-doctor', doctor: '' },
    { name: 'assigned-ok', doctor: 'doc-ok', finalizeOk: true },
    { name: 'finalize-failed', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 1 },
    { name: 'finalize-failed-not-released', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 0 },
    { name: 'no-doctor-insert-fails', doctor: '', failResetInsert: true },
    { name: 'finalize-failed-insert-fails', doctor: 'doc-ok', finalizeOk: false, fallbackRows: 1, failResetInsert: true },
  ];
  const out = [];
  for (const scn of scenarios) {
    rec.scn = scn; rec.log = []; rec.errors = [];
    const orderId = 'ord-api-' + scn.name;
    const got = { status: null, code: null };
    let threw = null;
    const req = { params: { id: orderId }, body: { specialtyId: 'spec-1', serviceId: 'svc-1', doctorId: scn.doctor }, user: { id: 'sa-1', role: 'superadmin' }, requestId: 'rq-2' };
    const res = {
      ok: function () { got.status = 200; return res; },
      fail: function (msg, status, codeOut) { got.status = status; got.code = codeOut; return res; },
    };
    try { await handler(req, res, function () {}); } catch (e) { threw = String((e && e.message) || e); }
    await new Promise(function (r) { setTimeout(r, 20); });
    out.push({ name: scn.name, orderId: orderId, status: got.status, code: got.code, threw: threw, log: rec.log.slice(), errors: rec.errors.slice() });
  }
  console.error = origError;
  return out;
}

module.exports = (async function () {

  // ── Constants ──────────────────────────────────────────────────────────────
  await check('module constants: 10-minute age, start date 2026-09-15T00:00:00Z, cap 6, registered terminal event', async function () {
    const miss = needImpl(); if (miss) return miss;
    if (worker.STRANDED_PAID_MIN_AGE_MINUTES !== 10) return 'STRANDED_PAID_MIN_AGE_MINUTES must stay 10, got ' + worker.STRANDED_PAID_MIN_AGE_MINUTES;
    if (worker.STRANDED_PAID_START_ISO !== START_ISO) return 'STRANDED_PAID_START_ISO must be ' + START_ISO + ', got ' + worker.STRANDED_PAID_START_ISO;
    if (worker.STRANDED_PAID_MAX_ATTEMPTS !== MAX) return 'STRANDED_PAID_MAX_ATTEMPTS must be ' + MAX + ', got ' + worker.STRANDED_PAID_MAX_ATTEMPTS;
    if (worker.STRANDED_PAID_RETRY_EVENT !== RETRY_EVENT) return 'STRANDED_PAID_RETRY_EVENT must be ' + RETRY_EVENT;
    return null;
  });

  // ── 1. Fetch SQL shape ────────────────────────────────────────────────────
  await check('fetch SQL: payment predicate, start date bound as a parameter, no updated_at fallback, NULLIF doctor, terminal-event exclusion', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld();
    await worker.fetchStrandedPaidCases({ deps: w.deps });
    if (w.fetches.length !== 1) return 'fetchStrandedPaidCases must run exactly one query through deps.queryAll, got ' + w.fetches.length;
    const sql = w.fetches[0].sql;
    const params = w.fetches[0].params;
    const must = [
      'FROM orders_active o',
      "LOWER(COALESCE(o.status, '')) = 'paid'",
      "LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')",
      "NULLIF(o.doctor_id, '') IS NULL",
      'o.acceptance_deadline_at IS NULL',
      "COALESCE(o.assignment_status, '') NOT IN ('manual_queue', 'manual_pending', 'manual_claimed')",
      'o.paid_at IS NOT NULL',
    ];
    for (const m of must) if (sql.indexOf(m) === -1) return 'fetch SQL is missing `' + m + '`';
    if (/COALESCE\(\s*(?:o\.)?paid_at\s*,\s*(?:o\.)?updated_at\s*\)/.test(sql)) return 'fetch SQL still falls back to updated_at (COALESCE(paid_at, updated_at)) — a row with no paid_at would be swept';
    if (/(?:^|[\s(])(?:o\.)?doctor_id IS NULL/.test(sql)) return "fetch SQL still has a bare doctor_id IS NULL — an empty-string doctor would be skipped";
    const start = sql.match(/o\.paid_at >= \$(\d+)::timestamptz/);
    if (!start) return 'fetch SQL has no `o.paid_at >= $n::timestamptz` start-date predicate';
    if (params[Number(start[1]) - 1] !== worker.STRANDED_PAID_START_ISO) return 'the start-date placeholder must be bound to STRANDED_PAID_START_ISO, got ' + params[Number(start[1]) - 1];
    if (sql.indexOf('2026-09-15') !== -1) return 'the start date must be a bound parameter, not inlined in the SQL';
    const age = sql.match(/o\.paid_at < NOW\(\) - make_interval\(mins => \$(\d+)\)/);
    if (!age || params[Number(age[1]) - 1] !== 10) return 'the 10-minute minimum age must be measured from paid_at and bound as a parameter';
    const term = sql.match(/NOT EXISTS\s*\(\s*SELECT 1 FROM case_events ce\s+WHERE ce\.case_id = o\.id AND ce\.event_type = \$(\d+)/);
    if (!term) return 'fetch SQL has no NOT EXISTS terminal-event exclusion on case_events';
    if (params[Number(term[1]) - 1] !== worker.STRANDED_PAID_PARKED_EVENT) return 'the terminal-event placeholder must be bound to STRANDED_PAID_PARKED_EVENT';
    const scoped = sql.match(/ce\.event_type = \$\d+\s+AND NOT EXISTS\s*\(\s*SELECT 1 FROM case_events r\s+WHERE r\.case_id = ce\.case_id AND r\.event_type = \$(\d+)\s+AND r\.created_at >= ce\.created_at\s*\)\s*\)/);
    if (!scoped) return 'the terminal-event exclusion is not scoped to events after the latest CASE_ROUTING_RESET — a case an operator sent back to automatic routing would stay excluded forever';
    if (params[Number(scoped[1]) - 1] !== RESET_EVENT) return 'the reset placeholder must be bound to ' + RESET_EVENT + ', got ' + params[Number(scoped[1]) - 1];
    return null;
  });

  // ── 2. Attempts 1 and 2, success ──────────────────────────────────────────
  await check('attempt 1 re-broadcasts, records CASE_ROUTING_RETRIED attempt 1, does not alert', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-1' }] });
    const r = await tick(w);
    if (r.scanned !== 1 || w.broadcasts.length !== 1) return 'expected one scan and one broadcast, got ' + JSON.stringify(r) + ' broadcasts=' + w.broadcasts.length;
    const ev = retryEvents(w, 'ord-1');
    if (ev.length !== 1 || ev[0].payload.attempt !== 1 || ev[0].payload.ok !== false) return 'retry event must record attempt 1 ok:false, got ' + JSON.stringify(ev);
    if (w.pushes.length !== 0) return 'ops was alerted on the FIRST failure';
    return null;
  });

  await check('attempt 2 alerts once via pushOpsEvent (case_routing_stuck, keyed per order)', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-2' }], events: seedAttempts('ord-2', 1) });
    await tick(w);
    if (w.pushes.length !== 1) return 'expected one push on the second failure, got ' + w.pushes.length;
    const p = w.pushes[0];
    if (p.kind !== 'case_routing_stuck') return 'wrong ops kind: ' + p.kind;
    if (String(p.dedupeKey) !== 'ord-2') return 'stuck push must be deduped per order, got ' + p.dedupeKey;
    if (p.orderId !== 'ord-2') return 'stuck push must carry orderId';
    return null;
  });

  await check('a successful re-broadcast counts as placed, never alerts, and the next tick scans nothing', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-ok' }], broadcast: async function () { return { ok: true, tier: 'standard', sent: 3 }; } });
    const r1 = await tick(w);
    if (r1.placed !== 1) return 'a successful broadcast must count 1 placed, got ' + JSON.stringify(r1);
    if (w.pushes.length !== 0) return 'ops alerted on a successful re-broadcast';
    const r2 = await tick(w);
    if (r2.scanned !== 0 || w.broadcasts.length !== 1) return 'a broadcast case (deadline set) was scanned again';
    return null;
  });

  // ── 3. The cap across 8 ticks ─────────────────────────────────────────────
  await check('8 ticks: exactly 6 broadcasts, one guarded park at manual_queue, one terminal event, one final push, then scanned 0', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-cap' }] });
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await tick(w));
    if (w.broadcasts.length !== MAX) return 'expected exactly ' + MAX + ' broadcasts over 8 ticks, got ' + w.broadcasts.length;
    const attempts = retryEvents(w, 'ord-cap').map(function (e) { return e.payload && e.payload.attempt; }).join(',');
    if (attempts !== '1,2,3,4,5,6') return 'attempt numbers must run 1..6, got ' + attempts;
    const term = terminalEvents(w, 'ord-cap');
    if (term.length !== 1) return 'expected exactly one ' + worker.STRANDED_PAID_PARKED_EVENT + ' event, got ' + term.length;
    if (!term[0].payload || term[0].payload.parked !== true || term[0].payload.attempts !== MAX) return 'terminal payload must record parked:true attempts:6, got ' + JSON.stringify(term[0].payload);
    if (term[0].tick !== 6) return 'the terminal event must land on tick 6 (the capped attempt), got tick ' + term[0].tick;
    const p = parks(w);
    if (p.length !== 1) return 'expected exactly one park UPDATE, got ' + p.length;
    const psql = p[0].sql;
    if (psql.indexOf("assignment_status = 'manual_queue'") === -1) return "park must set assignment_status = 'manual_queue'";
    if (psql.indexOf("NULLIF(doctor_id, '') IS NULL") === -1) return "park guard must carry NULLIF(doctor_id, '') IS NULL";
    if (psql.indexOf("COALESCE(assignment_status, 'auto') = 'auto'") === -1) return "park guard must carry COALESCE(assignment_status, 'auto') = 'auto'";
    if (!/\bWHERE\b[\s\S]*\bacceptance_deadline_at IS NULL/.test(psql)) return 'park guard must carry acceptance_deadline_at IS NULL';
    if (p[0].params.indexOf('ord-cap') === -1) return 'park must be keyed on the case id';
    if (w.rows[0].assignment_status !== 'manual_queue') return 'the case did not end at manual_queue: ' + w.rows[0].assignment_status;
    const onTick1 = w.pushes.filter(function (x) { return x.tick === 1; });
    if (onTick1.length !== 0) return 'attempt 1 must not push';
    const stuck = w.pushes.filter(function (x) { return x.tick === 2; });
    if (stuck.length !== 1) return 'attempt 2 must push the stuck alert once';
    const finals = w.pushes.filter(function (x) { return x.tick === 6; });
    if (finals.length !== 1) return 'expected exactly ONE push on the capped tick (the final push), got ' + finals.length + ' ' + JSON.stringify(finals.map(function (x) { return x.dedupeKey; }));
    const fin = finals[0];
    if (String(fin.dedupeKey) === String(stuck[0].dedupeKey) && fin.kind === stuck[0].kind) return 'the final push shares the stuck push\'s kind:dedupeKey — the per-order throttle swallows it';
    if (fin.throttled) return 'the final push was swallowed by the throttle';
    if (fin.orderId !== 'ord-cap' || !fin.title || !fin.body) return 'final push must carry orderId, title and body';
    if (!fin.data || fin.data.parked !== true) return 'final push data must say parked:true';
    if (results[6].scanned !== 0 || results[7].scanned !== 0) return 'ticks 7 and 8 must scan nothing, got ' + JSON.stringify(results.slice(6));
    return null;
  });

  // ── 4. Durability ─────────────────────────────────────────────────────────
  await check('restart durability: 6 attempts recorded, no terminal event → next tick parks without broadcasting (empty-string doctor normalised to NULL), then scanned 0', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-restart', doctor_id: '' }], events: seedAttempts('ord-restart', MAX) });
    const r1 = await tick(w);
    if (r1.scanned !== 1) return 'the capped-but-unparked case must still be fetched, got ' + JSON.stringify(r1);
    if (w.broadcasts.length !== 0) return 'the cap was already reached — the case must NOT be broadcast again, got ' + w.broadcasts.length;
    if (parks(w).length !== 1) return 'expected exactly one park UPDATE, got ' + parks(w).length;
    if (w.rows[0].assignment_status !== 'manual_queue') return 'the case must end at manual_queue, got ' + w.rows[0].assignment_status;
    if (w.rows[0].doctor_id !== null) return "the park must normalise doctor_id '' to NULL so every operator view that reads doctor_id IS NULL lists it, got " + JSON.stringify(w.rows[0].doctor_id);
    const term = terminalEvents(w, 'ord-restart');
    if (term.length !== 1 || term[0].payload.parked !== true || term[0].payload.attempts !== MAX) return 'expected one terminal event parked:true attempts:6, got ' + JSON.stringify(term);
    if (retryEvents(w, 'ord-restart').length !== MAX) return 'finishing the park must not write another retry event';
    if (w.pushes.length !== 1) return 'expected exactly one (final) push, got ' + w.pushes.length;
    const r2 = await tick(w);
    if (r2.scanned !== 0) return 'after the park the case must never be scanned again, got ' + JSON.stringify(r2);
    return null;
  });

  await check('a park that THROWS writes no terminal event and no push, logs once, and is retried on the next tick', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-throw' }], events: seedAttempts('ord-throw', MAX) });
    const realExecute = w.deps.execute;
    let calls = 0;
    w.deps.execute = async function (sql, params) {
      calls++;
      if (calls === 1) throw new Error('connection reset');
      return realExecute(sql, params);
    };
    await tick(w);
    if (w.broadcasts.length !== 0) return 'must not broadcast past the cap';
    if (terminalEvents(w, 'ord-throw').length !== 0) return 'a park that threw must NOT write the terminal event (the fetch would then drop the case with nothing parked)';
    if (w.pushes.length !== 0) return 'no final push before the park lands, got ' + w.pushes.length;
    if (w.errors.length !== 1 || w.errors[0].ctx.orderId !== 'ord-throw') return 'the thrown park must be logged once via logErrorToDb with orderId, got ' + w.errors.length;
    const r2 = await tick(w);
    if (r2.scanned !== 1 || calls !== 2) return 'the park must be retried on the next tick, execute calls=' + calls + ' scan=' + JSON.stringify(r2);
    const term = terminalEvents(w, 'ord-throw');
    if (term.length !== 1 || term[0].payload.parked !== true) return 'the retried park must land and be recorded parked:true, got ' + JSON.stringify(term);
    if (w.rows[0].assignment_status !== 'manual_queue') return 'the case must end at manual_queue';
    if (w.pushes.length !== 1) return 'exactly one final push once the park landed, got ' + w.pushes.length;
    return null;
  });

  await check('a park refused by its guard (0 rows) still records the terminal event parked:false, pushes once, and the case is never scanned again', async function () {
    const miss = needImpl(); if (miss) return miss;
    // Empty-string doctor with a non-auto assignment_status: matches the fetch
    // (not a manual state) but the park guard refuses it.
    const w = makeWorld({ rows: [{ id: 'ord-refused', doctor_id: '', assignment_status: 'assigned' }] });
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await tick(w));
    if (w.broadcasts.length !== MAX) return 'expected ' + MAX + ' broadcasts, got ' + w.broadcasts.length;
    const term = terminalEvents(w, 'ord-refused');
    if (term.length !== 1 || term[0].payload.parked !== false) return 'expected one terminal event parked:false, got ' + JSON.stringify(term);
    if (w.rows[0].assignment_status !== 'assigned') return 'the park must not overwrite a non-auto assignment_status';
    const finals = w.pushes.filter(function (x) { return x.tick === 6; });
    if (finals.length !== 1 || finals[0].throttled) return 'the refused park must still push once, unthrottled';
    if (!finals[0].data || finals[0].data.parked !== false) return 'final push data must say parked:false';
    if (results[6].scanned !== 0 || results[7].scanned !== 0) return 'a terminal-but-unparked case must not be scanned again (terminal-event exclusion), got ' + JSON.stringify(results.slice(6));
    return null;
  });

  await check('a failed attempt-count read skips the case this tick (never an uncapped broadcast) and logs', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-count' }], events: seedAttempts('ord-count', MAX) });
    w.deps.queryOne = async function () { throw new Error('case_events read failed'); };
    await tick(w);
    if (w.broadcasts.length !== 0) return 'a case whose attempt count cannot be read must not be broadcast (the cap would be bypassed)';
    if (w.errors.length !== 1) return 'the failed count read must be logged once, got ' + w.errors.length;
    return null;
  });

  // ── 4b. The attempt record, the capped success, the taken case ────────────
  await check('the attempt is recorded BEFORE the broadcast with an INSERT that throws; a failing write skips the case with no broadcast and is logged, so retries never run uncapped', async function () {
    const miss = needImpl(); if (miss) return miss;
    const ok = makeWorld({ rows: [{ id: 'ord-order' }] });
    await tick(ok);
    if (!ok.executes.some(function (x) { return /^\s*INSERT INTO case_events\b/.test(x.sql) && x.params[2] === RETRY_EVENT; })) return 'the retry event must be a direct INSERT through execute — logCaseEvent swallows a failed write';
    const iEv = ok.ops.indexOf('event:' + RETRY_EVENT);
    const iBc = ok.ops.indexOf('broadcast');
    if (iEv === -1 || iBc === -1 || iEv > iBc) return 'the attempt must be recorded before the broadcast runs, got ops ' + JSON.stringify(ok.ops);
    const ev = retryEvents(ok, 'ord-order');
    if (ev.length !== 1 || ev[0].payload.attempt !== 1 || ev[0].payload.ok !== false) return 'the attempt row must end with its outcome (attempt 1, ok:false), got ' + JSON.stringify(ev);
    const w = makeWorld({ rows: [{ id: 'ord-noattempt' }] });
    w.failRetryInsert = true;
    for (let i = 0; i < 8; i++) await tick(w);
    if (w.broadcasts.length !== 0) return 'the retry-event write failed on every tick but the case was broadcast ' + w.broadcasts.length + ' times over 8 ticks — the attempt count never advances, so retries run uncapped';
    if (w.errors.length !== 8) return 'each failed retry-event write must be logged via logErrorToDb, got ' + w.errors.length + ' over 8 ticks';
    if (w.errors.some(function (e) { return e.ctx.orderId !== 'ord-noattempt'; })) return 'the logged failure must carry orderId';
    if (parks(w).length !== 0 || w.pushes.length !== 0) return 'a skipped tick must not park or push';
    return null;
  });

  await check('a capped (6th) attempt whose broadcast SUCCEEDS counts as placed: no park UPDATE, no terminal event, no push', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-sixth-ok' }], events: seedAttempts('ord-sixth-ok', MAX - 1), broadcast: async function () { return { ok: true, tier: 'standard', sent: 2 }; } });
    const r = await tick(w);
    if (r.placed !== 1) return 'a 6th attempt that succeeded must count 1 placed, got ' + JSON.stringify(r);
    if (parks(w).length !== 0) return 'a 6th attempt that succeeded was parked for a human anyway';
    if (terminalEvents(w, 'ord-sixth-ok').length !== 0) return 'a 6th attempt that succeeded wrote the terminal event';
    if (w.pushes.length !== 0) return 'a 6th attempt that succeeded pushed an alert';
    const ev = retryEvents(w, 'ord-sixth-ok');
    const last = ev[ev.length - 1];
    if (ev.length !== MAX || !last || last.payload.attempt !== MAX || last.payload.ok !== true) return 'the 6th attempt must be recorded ok:true, got ' + JSON.stringify(last);
    return null;
  });

  await check('the park requires acceptance_deadline_at IS NULL: a case whose broadcast claim landed between the fetch and the park is not parked, and is recorded quietly (reason taken, no push)', async function () {
    const miss = needImpl(); if (miss) return miss;
    // The capped attempt's claim lands (sets the deadline) but reaches no doctor.
    const w = makeWorld({
      rows: [{ id: 'ord-claimed' }], events: seedAttempts('ord-claimed', MAX - 1),
      broadcast: async function (caseId, world) { world.rows[0].acceptance_deadline_at = '2026-09-20T12:30:00Z'; return { ok: false, reason: 'no_specialty' }; },
    });
    await tick(w);
    if (parks(w).length !== 1) return 'expected one park attempt on the capped tick, got ' + parks(w).length;
    if (w.rows[0].assignment_status !== 'auto') return 'a case whose broadcast claim already landed was parked at ' + w.rows[0].assignment_status + ' — announced to doctors AND sitting in the manual queue';
    if (w.pushes.length !== 0) return 'a case placed meanwhile raised a false alarm: ' + JSON.stringify(w.pushes.map(function (x) { return x.body; }));
    const term = terminalEvents(w, 'ord-claimed');
    if (term.length !== 1 || term[0].payload.parked !== false || term[0].payload.reason !== 'taken') return 'expected one terminal event parked:false reason:taken, got ' + JSON.stringify(term.map(function (x) { return x.payload; }));
    const psql = parks(w)[0].sql;
    if (!/\bWHERE\b[\s\S]*\bacceptance_deadline_at IS NULL/.test(psql)) return 'park guard must carry acceptance_deadline_at IS NULL';
    return null;
  });

  await check('a park refused because a doctor accepted meanwhile is recorded quietly (reason taken, no push); a refused park on a case still unrouted keeps its alarm', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({
      rows: [{ id: 'ord-accepted' }], events: seedAttempts('ord-accepted', MAX - 1),
      broadcast: async function (caseId, world) { world.rows[0].doctor_id = 'doc-9'; return { ok: false, reason: 'stub_failed' }; },
    });
    await tick(w);
    if (w.rows[0].doctor_id !== 'doc-9' || w.rows[0].assignment_status !== 'auto') return 'the park touched a case a doctor holds: ' + JSON.stringify(w.rows[0]);
    if (!w.counts.some(function (c) { return /FROM orders_active\s+WHERE id = \$1/.test(c.sql); })) return 'a refused park must re-read the case';
    if (w.pushes.length !== 0) return "a case a doctor accepted meanwhile raised a false alarm ('check it has a doctor'): " + JSON.stringify(w.pushes.map(function (x) { return x.title; }));
    const term = terminalEvents(w, 'ord-accepted');
    if (term.length !== 1 || term[0].payload.parked !== false || term[0].payload.reason !== 'taken') return 'expected one terminal event parked:false reason:taken, got ' + JSON.stringify(term.map(function (x) { return x.payload; }));
    const u = makeWorld({ rows: [{ id: 'ord-unrouted', doctor_id: '', assignment_status: 'assigned' }], events: seedAttempts('ord-unrouted', MAX) });
    await tick(u);
    const t2 = terminalEvents(u, 'ord-unrouted');
    if (t2.length !== 1 || t2[0].payload.parked !== false || t2[0].payload.reason === 'taken') return 'a refused park on a case still unrouted must not be recorded as taken, got ' + JSON.stringify(t2.map(function (x) { return x.payload; }));
    if (u.pushes.length !== 1 || !u.pushes[0].data || u.pushes[0].data.parked !== false) return 'a refused park on a case still unrouted must still alarm once, got ' + u.pushes.length;
    return null;
  });

  // ── 4c. The reset contract (T2-R3) ────────────────────────────────────────
  await check('parked → CASE_ROUTING_RESET → the sweep resumes from attempt 1 → 6 more broadcasts → parks again with a second terminal event', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-reset' }] });
    for (let i = 0; i < 8; i++) await tick(w);
    if (w.rows[0].assignment_status !== 'manual_queue' || terminalEvents(w, 'ord-reset').length !== 1) return 'setup: the first episode did not park';
    // An operator approves it back to automatic routing with no doctor.
    w.rows[0].assignment_status = 'auto';
    addReset(w, 'ord-reset');
    const after = [];
    for (let i = 0; i < 8; i++) after.push(await tick(w));
    if (after[0].scanned !== 1) return 'after CASE_ROUTING_RESET the case must be fetched again, got ' + JSON.stringify(after[0]);
    if (w.broadcasts.length !== 2 * MAX) return 'expected ' + MAX + ' more broadcasts after the reset (' + (2 * MAX) + ' in all), got ' + w.broadcasts.length;
    const second = retryEvents(w, 'ord-reset').slice(MAX).map(function (e) { return e.payload && e.payload.attempt; }).join(',');
    if (second !== '1,2,3,4,5,6') return 'attempts after the reset must restart at 1..6, got ' + second;
    const term = terminalEvents(w, 'ord-reset');
    if (term.length !== 2 || term[1].payload.parked !== true || term[1].payload.attempts !== MAX) return 'expected a second terminal event parked:true attempts:6, got ' + JSON.stringify(term.map(function (x) { return x.payload; }));
    if (term[1].tick !== 14) return 'the second terminal event must land on the 6th tick after the reset (tick 14), got ' + term[1].tick;
    if (parks(w).length !== 2 || w.rows[0].assignment_status !== 'manual_queue') return 'the second episode must park again, parks=' + parks(w).length + ' status=' + w.rows[0].assignment_status;
    if (after[6].scanned !== 0 || after[7].scanned !== 0) return 'after the second park the case must scan 0, got ' + JSON.stringify(after.slice(6));
    // The real ops_push cooldown is 15 minutes and an episode takes 30, so this
    // push goes out; the fake's claim never expires, so only the offer is checked.
    if (!w.pushes.some(function (x) { return x.tick === 14 && x.data && x.data.parked === true; })) return 'the second park must offer its final push';
    return null;
  });

  await check('a terminal event with no CASE_ROUTING_RESET after it keeps the case excluded (an older reset does not count); a new capped episode after a reset finishes its park on restart', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({
      rows: [{ id: 'ord-old-reset' }],
      events: [{ caseId: 'ord-old-reset', type: RESET_EVENT }].concat(seedAttempts('ord-old-reset', MAX), [{ caseId: 'ord-old-reset', type: PARKED_EVENT, payload: { parked: false } }]),
    });
    const r = await tick(w);
    if (r.scanned !== 0 || w.broadcasts.length !== 0) return 'a case whose only reset is OLDER than its terminal event was fetched again: ' + JSON.stringify(r);
    const x = makeWorld({
      rows: [{ id: 'ord-restart2' }],
      events: seedAttempts('ord-restart2', MAX).concat(
        [{ caseId: 'ord-restart2', type: PARKED_EVENT, payload: { parked: true } }, { caseId: 'ord-restart2', type: RESET_EVENT }],
        seedAttempts('ord-restart2', MAX)),
    });
    const r2 = await tick(x);
    if (r2.scanned !== 1) return 'a reset case whose new episode is capped must be fetched, got ' + JSON.stringify(r2);
    if (x.broadcasts.length !== 0) return 'the new episode already used ' + MAX + ' attempts — it must not broadcast';
    if (parks(x).length !== 1 || x.rows[0].assignment_status !== 'manual_queue') return 'the new episode must finish its park (the old terminal event predates the reset), parks=' + parks(x).length;
    if (terminalEvents(x, 'ord-restart2').length !== 2) return 'expected a second terminal event, got ' + terminalEvents(x, 'ord-restart2').length;
    return null;
  });

  await check('a refused (0-row) park stays excluded until an operator resets routing; after CASE_ROUTING_RESET the next tick broadcasts attempt 1', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-refused-reset', doctor_id: '', assignment_status: 'assigned' }] });
    for (let i = 0; i < 8; i++) await tick(w);
    const term = terminalEvents(w, 'ord-refused-reset');
    if (term.length !== 1 || term[0].payload.parked !== false) return 'setup: expected one refused park, got ' + JSON.stringify(term.map(function (e) { return e.payload; }));
    const quiet = await tick(w);
    if (quiet.scanned !== 0) return 'a refused park with no reset must stay excluded, got ' + JSON.stringify(quiet);
    addReset(w, 'ord-refused-reset');
    const r = await tick(w);
    if (r.scanned !== 1 || w.broadcasts.length !== MAX + 1) return 'after CASE_ROUTING_RESET the refused case must be broadcast again, got ' + JSON.stringify(r) + ' broadcasts=' + w.broadcasts.length;
    const ev = retryEvents(w, 'ord-refused-reset');
    if (ev[ev.length - 1].payload.attempt !== 1) return 'the first attempt after the reset must be attempt 1, got ' + ev[ev.length - 1].payload.attempt;
    return null;
  });

  await check('both sweep counts (attempts and already-parked) only count events after the latest CASE_ROUTING_RESET, bound as a parameter', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-shape' }], events: seedAttempts('ord-shape', MAX) });
    await tick(w);
    const counts = w.counts.filter(function (c) { return /FROM case_events/.test(c.sql); });
    if (counts.length < 2) return 'expected the attempt count and the already-parked count to run, got ' + counts.length;
    for (const c of counts) {
      const m = c.sql.match(/NOT EXISTS\s*\(\s*SELECT 1 FROM case_events r\s+WHERE r\.case_id = ce\.case_id AND r\.event_type = \$(\d+)\s+AND r\.created_at >= ce\.created_at\s*\)/);
      if (!m) return 'a sweep count ignores CASE_ROUTING_RESET: ' + c.sql.replace(/\s+/g, ' ');
      if (c.params[Number(m[1]) - 1] !== RESET_EVENT) return 'the count reset placeholder must be bound to ' + RESET_EVENT + ', got ' + c.params[Number(m[1]) - 1];
    }
    return null;
  });

  // ── 5. Rows that must never be swept ──────────────────────────────────────
  await check('a refunded row still at status PAID is never swept; paid and CAPTURED rows are', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [
      { id: 'ord-refunded', payment_status: 'refunded' },
      { id: 'ord-unpaid', payment_status: 'unpaid' },
      { id: 'ord-paid' },
      { id: 'ord-captured', payment_status: 'CAPTURED' },
    ] });
    await tick(w);
    const got = w.broadcasts.map(function (b) { return b.caseId; }).sort().join(',');
    if (got !== 'ord-captured,ord-paid') return 'expected only ord-captured,ord-paid to be broadcast, got ' + got;
    return null;
  });

  await check('a row paid before the start date, a row with NULL paid_at, and a row paid under 10 minutes ago are never swept', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [
      { id: 'ord-pre-start', paid_at: PRE_START_PAID_AT },
      { id: 'ord-null-paid', paid_at: null, updated_at: '2026-09-16T00:00:00Z' },
      { id: 'ord-young', paid_at: YOUNG_PAID_AT },
      { id: 'ord-eligible' },
    ] });
    const r = await tick(w);
    const got = w.broadcasts.map(function (b) { return b.caseId; }).join(',');
    if (got !== 'ord-eligible') return 'expected only ord-eligible to be broadcast, got ' + got;
    if (r.scanned !== 1) return 'expected scanned 1, got ' + r.scanned;
    return null;
  });

  // ── 6. Empty-string doctor on the path to a doctor ────────────────────────
  await check('an empty-string-doctor row is swept; a row held by a doctor is not', async function () {
    const miss = needImpl(); if (miss) return miss;
    const w = makeWorld({ rows: [{ id: 'ord-empty', doctor_id: '' }, { id: 'ord-held', doctor_id: 'doc-2' }] });
    await tick(w);
    const got = w.broadcasts.map(function (b) { return b.caseId; }).join(',');
    if (got !== 'ord-empty') return 'expected only ord-empty to be broadcast, got ' + got;
    return null;
  });

  await check("broadcast claim accepts an empty-string doctor (claim lands) and still refuses a held case", async function () {
    const out = runChild(broadcastClaimChild, 'BROADCAST_CLAIM=');
    const by = {};
    for (const o of out) by[o.id] = o;
    if (!by['ord-empty'] || by['ord-empty'].claims.join(',') !== '1') return "the broadcast claim refused doctor_id = '' (claims " + JSON.stringify(by['ord-empty'] && by['ord-empty'].claims) + ', reason ' + (by['ord-empty'] && by['ord-empty'].reason) + ')';
    if (by['ord-empty'].reason !== 'no_specialty') return "an empty-string row must pass the claim and reach specialty resolution, got reason " + by['ord-empty'].reason;
    if (!by['ord-null'] || by['ord-null'].claims.join(',') !== '1') return 'the broadcast claim refused a NULL doctor';
    if (!by['ord-held'] || by['ord-held'].reason !== 'already_assigned' || by['ord-held'].claims.length !== 0) return 'a held case must exit already_assigned before the claim, got ' + JSON.stringify(by['ord-held']);
    const src = code('src/notify/broadcast.js');
    if (!/acceptance_deadline_at = \$3,[\s\S]*?WHERE id = \$4\s+AND NULLIF\(doctor_id, ''\) IS NULL/.test(src)) return "broadcast.js claim UPDATE must guard on NULLIF(doctor_id, '') IS NULL";
    return null;
  });

  await check("accept claim (assignDoctor) takes an empty-string or NULL doctor, keeps the same-doctor retry, and a case held by another doctor still throws CASE_ALREADY_TAKEN", async function () {
    const out = runChild(acceptClaimChild, 'ACCEPT_CLAIM=');
    const by = {};
    for (const o of out) by[o.id] = o;
    const landed = function (id) { return by[id] && by[id].claims.length === 1 && by[id].claims[0].rowCount === 1 && by[id].code !== 'CASE_ALREADY_TAKEN'; };
    if (!by['ord-empty'] || by['ord-empty'].claims.length !== 1) return 'assignDoctor did not reach the claim for the empty-string row: ' + JSON.stringify(by['ord-empty']);
    if (!/NULLIF\(doctor_id, ''\) IS NULL OR doctor_id = \$1/.test(by['ord-empty'].claims[0].where)) return "the claim WHERE must be (NULLIF(doctor_id, '') IS NULL OR doctor_id = $1), got " + by['ord-empty'].claims[0].where;
    if (!landed('ord-empty')) return "the accept claim refused doctor_id = '' (" + JSON.stringify(by['ord-empty']) + ')';
    if (!landed('ord-null')) return 'the accept claim refused a NULL doctor (' + JSON.stringify(by['ord-null']) + ')';
    if (!landed('ord-mine')) return 'the same-doctor retry no longer passes the claim (' + JSON.stringify(by['ord-mine']) + ')';
    const taken = by['ord-taken'];
    if (!taken || taken.claims.length !== 1 || taken.claims[0].rowCount !== 0) return 'a case held by another doctor must match 0 rows, got ' + JSON.stringify(taken);
    if (taken.code !== 'CASE_ALREADY_TAKEN') return 'a lost claim must throw CASE_ALREADY_TAKEN, got ' + taken.code + ' ' + taken.message;
    return null;
  });

  await check("acceptance watcher: the expired-order query, its no-doctor backoff and its auto-assign claim use NULLIF(doctor_id, '')", async function () {
    const src = code('src/workers/acceptance_watcher.js');
    const q = src.match(/const expiredOrders = await queryAll\(`([\s\S]*?)`/);
    if (!q) return 'expiredOrders query not found';
    const sql = q[1].replace(/--[^\n]*/g, '');
    if (sql.indexOf("NULLIF(o.doctor_id, '') IS NULL") === -1) return "expired-order query must select NULLIF(o.doctor_id, '') IS NULL";
    if (/(?:^|[\s(])o\.doctor_id IS NULL/.test(sql)) return 'expired-order query still has a bare o.doctor_id IS NULL';
    if (!/SET acceptance_deadline_at = \$1,\s*updated_at = \$1\s*WHERE id = \$2\s*AND NULLIF\(doctor_id, ''\) IS NULL/.test(src)) return "no-doctor backoff UPDATE must guard on NULLIF(doctor_id, '') IS NULL (else an empty-string row is re-selected every sweep)";
    if (!/SET doctor_id = \$1,[\s\S]*?WHERE id = \$3\s*AND NULLIF\(doctor_id, ''\) IS NULL/.test(src)) return "auto-assign claim UPDATE must guard on NULLIF(doctor_id, '') IS NULL (else an empty-string row is selected and never claimed)";
    return null;
  });

  await check("no bare doctor_id IS NULL next to or instead of NULLIF(doctor_id, '') at any of the seven unassigned predicates", async function () {
    const BARE = /(?:^|[\s(])(?:o\.)?doctor_id IS NULL/;
    const sites = [
      ['sweep fetch', 'src/case_sla_worker.js', /async function fetchStrandedPaidCases[\s\S]*?`([\s\S]*?)`/, "NULLIF(o.doctor_id, '') IS NULL"],
      ['sweep park', 'src/case_sla_worker.js', /async function parkStrandedPaidCase[\s\S]*?`(\s*UPDATE orders[\s\S]*?)`/, "NULLIF(doctor_id, '') IS NULL"],
      ['broadcast claim', 'src/notify/broadcast.js', /`(\s*UPDATE orders\s+SET tier = \$1,[\s\S]*?)`/, "NULLIF(doctor_id, '') IS NULL"],
      ['accept claim', 'src/case_lifecycle.js', /`(UPDATE \$\{CASE_TABLE\} SET doctor_id = \$1\s+WHERE id = \$2[\s\S]*?)`/, "NULLIF(doctor_id, '') IS NULL"],
      ['watcher expired-order query', 'src/workers/acceptance_watcher.js', /const expiredOrders = await queryAll\(`([\s\S]*?)`/, "NULLIF(o.doctor_id, '') IS NULL"],
      ['watcher no-doctor backoff', 'src/workers/acceptance_watcher.js', /`(\s*UPDATE orders\s+SET acceptance_deadline_at = \$1,\s*updated_at = \$1[\s\S]*?)`/, "NULLIF(doctor_id, '') IS NULL"],
      ['watcher auto-assign claim', 'src/workers/acceptance_watcher.js', /`(\s*UPDATE orders\s+SET doctor_id = \$1,\s*status = 'assigned'[\s\S]*?)`/, "NULLIF(doctor_id, '') IS NULL"],
    ];
    for (const s of sites) {
      const m = code(s[1]).match(s[2]);
      if (!m) return s[0] + ': statement not found in ' + s[1];
      const stmt = m[1].replace(/--[^\n]*/g, '');
      const where = stmt.slice(stmt.search(/\bWHERE\b/));
      if (where.indexOf(s[3]) === -1) return s[0] + ': WHERE must carry ' + s[3];
      if (BARE.test(where)) return s[0] + ": a bare doctor_id IS NULL sits in the WHERE — Postgres refuses doctor_id = '' there even with NULLIF beside it";
    }
    return null;
  });

  // ── 7. Registry ───────────────────────────────────────────────────────────
  await check('the terminal event is registered in SILENT_FAILURE_EVENTS with a valid suffix; the retry event is not', async function () {
    const miss = needImpl(); if (miss) return miss;
    const reg = lifecycle.SILENT_FAILURE_EVENTS;
    const ev = worker.STRANDED_PAID_PARKED_EVENT;
    if (!Array.isArray(reg)) return 'SILENT_FAILURE_EVENTS is not exported as an array';
    if (!/^[A-Z][A-Z0-9_]*_(SKIPPED|FAILED|DROPPED|NO_OP)$/.test(ev)) return ev + ' does not end in _SKIPPED / _FAILED / _DROPPED / _NO_OP';
    if (reg.indexOf(ev) === -1) return ev + ' is not registered in SILENT_FAILURE_EVENTS — /ops/silent-failures would not name it';
    if (reg.indexOf(RETRY_EVENT) !== -1) return RETRY_EVENT + ' must not be registered — a retry is not a silent failure';
    return null;
  });

  await check('CASE_ROUTING_RESET is one timeline event shared by case_lifecycle and the sweep, and is NOT a silent failure', async function () {
    if (lifecycle.CASE_ROUTING_RESET_EVENT !== RESET_EVENT) return 'case_lifecycle must export CASE_ROUTING_RESET_EVENT = ' + RESET_EVENT + ', got ' + lifecycle.CASE_ROUTING_RESET_EVENT;
    if (worker.STRANDED_PAID_RESET_EVENT !== RESET_EVENT) return 'case_sla_worker must export STRANDED_PAID_RESET_EVENT = ' + RESET_EVENT + ', got ' + worker.STRANDED_PAID_RESET_EVENT;
    if (typeof lifecycle.insertCaseEventOrThrow !== 'function') return 'case_lifecycle must export insertCaseEventOrThrow';
    const reg = lifecycle.SILENT_FAILURE_EVENTS || [];
    if (reg.indexOf(RESET_EVENT) !== -1) return RESET_EVENT + ' must not be registered in SILENT_FAILURE_EVENTS — an operator reset is not a failure';
    if (/_(SKIPPED|FAILED|DROPPED|NO_OP)$/.test(RESET_EVENT)) return RESET_EVENT + ' must not carry a silent-failure suffix';
    return null;
  });

  // ── 8. Wiring and containment ─────────────────────────────────────────────
  await check('the sweep stays wired into the 5-minute tick, and a stranded-fetch failure does not join fetchError', async function () {
    const src = code('src/case_sla_worker.js');
    if (!/stranded\s*=\s*await fetchStrandedPaidCases\(\)/.test(src)) return 'fetchStrandedPaidCases not called in the sweep';
    if (!/handleStrandedPaidCase\(candidate\)/.test(src)) return 'handleStrandedPaidCase not invoked per candidate';
    const at = src.indexOf('stranded = await fetchStrandedPaidCases()');
    const end = src.indexOf('let breachCount', at);
    const block = src.slice(at, end);
    if (/fetchError\s*=/.test(block)) return 'a stranded-fetch failure is added to fetchError — a routing problem would fail the SLA job';
    return null;
  });

  await check('a thrown stranded-sweep fetch is contained: runCaseSlaSweep resolves with its pinned shape', async function () {
    const out = runChild(containmentChild, 'CONTAINMENT=');
    if (!out.strandedFetchSeen) return 'the stranded fetch never ran inside runCaseSlaSweep';
    if (out.threw) return 'runCaseSlaSweep rejected because the stranded fetch threw: ' + out.threw;
    const r = out.result || {};
    if (r.preBreaches !== 0 || r.breaches !== 0 || r.timeouts !== 0) return 'unexpected sweep result ' + JSON.stringify(out.result);
    return null;
  });

  // ── 8b. Both manual-queue approve handlers write the reset marker ─────────
  const resetsOf = function (o) { return o.log.filter(function (x) { return x.op === 'event' && x.type === RESET_EVENT; }); };
  const indexOf = function (o, pred) { return o.log.findIndex(pred); };

  await check('web POST /superadmin/manual-queue/:id/approve (real handler, fake pg): every release to automatic routing with no doctor writes CASE_ROUTING_RESET right after the routing write; a failed write is logged and does not fail the approve', async function () {
    const out = runChild(webApproveChild, 'WEB_APPROVE=');
    const by = {};
    for (const o of out) by[o.name] = o;
    for (const n of ['no-doctor', 'ineligible-pick']) {
      const o = by[n];
      if (!o || o.threw) return n + ': handler threw ' + (o && o.threw);
      const iRoute = indexOf(o, function (x) { return x.op === 'route' && x.status === 'auto'; });
      const iReset = indexOf(o, function (x) { return x.op === 'event' && x.type === RESET_EVENT; });
      if (iRoute === -1) return n + ': the routing write to auto was not seen: ' + JSON.stringify(o.log);
      if (iReset === -1) return n + ': the case was released to auto with no doctor but no ' + RESET_EVENT + ' was written: ' + JSON.stringify(o.log);
      if (iReset < iRoute) return n + ': ' + RESET_EVENT + ' must follow the routing write';
      if (resetsOf(o).length !== 1 || resetsOf(o)[0].caseId !== o.orderId) return n + ': expected one reset event for the case, got ' + JSON.stringify(resetsOf(o));
      if (o.errors.length) return n + ': unexpected error log ' + JSON.stringify(o.errors);
    }
    if (!/flash=approved/.test(by['no-doctor'].redirect)) return 'no-doctor: redirect changed: ' + by['no-doctor'].redirect;
    if (resetsOf(by['assigned-ok']).length !== 0) return 'assigned-ok: a case handed to a doctor must not get ' + RESET_EVENT;
    const ff = by['finalize-failed'];
    const iFallback = indexOf(ff, function (x) { return x.op === 'fallback_reset'; });
    const iFfReset = indexOf(ff, function (x) { return x.op === 'event' && x.type === RESET_EVENT; });
    if (iFallback === -1) return 'finalize-failed: the fallback reset UPDATE was not seen: ' + JSON.stringify(ff.log);
    if (iFfReset === -1 || iFfReset < iFallback) return 'finalize-failed: the fallback released the case to auto but ' + RESET_EVENT + ' was not written after it: ' + JSON.stringify(ff.log);
    if (resetsOf(by['finalize-failed-not-released']).length !== 0) return 'finalize-failed-not-released: the fallback matched 0 rows (nothing released) but ' + RESET_EVENT + ' was written';
    for (const n of ['no-doctor-insert-fails', 'finalize-failed-insert-fails']) {
      const o = by[n];
      if (!o || o.threw) return n + ': handler threw ' + (o && o.threw);
      if (!o.errors.some(function (e) { return /routing_reset/.test(String(e.context)) && e.orderId === o.orderId; })) return n + ': a failed ' + RESET_EVENT + ' write must go to logErrorToDb with orderId, got ' + JSON.stringify(o.errors);
    }
    if (!/flash=approved/.test(by['no-doctor-insert-fails'].redirect)) return 'no-doctor-insert-fails: a failed reset write must not fail the approve, redirect ' + by['no-doctor-insert-fails'].redirect;
    return null;
  });

  await check('Command POST /manual-queue/:id/approve (real handler, fake db): the release to auto writes CASE_ROUTING_RESET inside the routing transaction; the finalize fallback writes it right after its reset; a failed write rolls back or is logged', async function () {
    const out = runChild(apiApproveChild, 'API_APPROVE=');
    const by = {};
    for (const o of out) by[o.name] = o;
    const nd = by['no-doctor'];
    if (!nd || nd.threw || nd.status !== 200) return 'no-doctor: expected 200, got ' + JSON.stringify(nd && { status: nd.status, code: nd.code, threw: nd.threw });
    const iRoute = indexOf(nd, function (x) { return x.op === 'route' && x.status === 'auto'; });
    const iReset = indexOf(nd, function (x) { return x.op === 'event' && x.type === RESET_EVENT; });
    const iCommit = indexOf(nd, function (x) { return x.op === 'COMMIT'; });
    if (iRoute === -1 || iCommit === -1) return 'no-doctor: routing write or COMMIT not seen: ' + JSON.stringify(nd.log);
    if (iReset === -1) return 'no-doctor: the case was released to auto with no doctor but no ' + RESET_EVENT + ' was written: ' + JSON.stringify(nd.log);
    if (!(iRoute < iReset && iReset < iCommit) || nd.log[iReset].via !== 'client') return 'no-doctor: ' + RESET_EVENT + ' must be written on the txn client between the routing write and COMMIT: ' + JSON.stringify(nd.log);
    if (resetsOf(by['assigned-ok']).length !== 0) return 'assigned-ok: a case handed to a doctor must not get ' + RESET_EVENT;
    const ff = by['finalize-failed'];
    const iFallback = indexOf(ff, function (x) { return x.op === 'fallback_reset'; });
    const iFfReset = indexOf(ff, function (x) { return x.op === 'event' && x.type === RESET_EVENT; });
    if (iFallback === -1) return 'finalize-failed: the fallback reset UPDATE was not seen: ' + JSON.stringify(ff.log);
    if (iFfReset === -1 || iFfReset < iFallback) return 'finalize-failed: the fallback released the case to auto but ' + RESET_EVENT + ' was not written after it: ' + JSON.stringify(ff.log);
    if (resetsOf(by['finalize-failed-not-released']).length !== 0) return 'finalize-failed-not-released: nothing was released but ' + RESET_EVENT + ' was written';
    const nf = by['no-doctor-insert-fails'];
    if (indexOf(nf, function (x) { return x.op === 'COMMIT'; }) !== -1 || indexOf(nf, function (x) { return x.op === 'ROLLBACK'; }) === -1 || nf.status !== 500) return 'no-doctor-insert-fails: the routing write and its marker must roll back together (500, no COMMIT), got ' + JSON.stringify({ status: nf.status, log: nf.log });
    const fif = by['finalize-failed-insert-fails'];
    if (!fif.errors.some(function (e) { return /routing_reset/.test(String(e.context)) && e.orderId === fif.orderId; })) return 'finalize-failed-insert-fails: a failed ' + RESET_EVENT + ' write must go to logErrorToDb with orderId, got ' + JSON.stringify(fif.errors);
    return null;
  });

  // ── 9. Local DB: the real SQL inside BEGIN … ROLLBACK ─────────────────────
  //
  // Runs only with a schema-current Postgres (the runner blanks DATABASE_URL
  // otherwise). No skip line in no-DB mode, so the Skipped count is untouched.
  if (process.env.DATABASE_URL) {
    await check('local DB (BEGIN…ROLLBACK): the real fetch selects exactly the stranded shape; the real park lands on an empty-string-doctor case and is refused on a held one', async function () {
      const miss = needImpl(); if (miss) return miss;
      const pg = require('../../src/pg');
      const { randomUUID } = require('crypto');
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        const clock = await client.query("SELECT (NOW() - INTERVAL '20 minutes') >= $1::timestamptz AS ok", [START_ISO]);
        if (!clock.rows[0].ok) return 'local DB clock is earlier than the start date + 20 minutes';
        const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const id = function (k) { return 'tsweep-' + k + '-' + sfx; };
        const ins = async function (k, o) {
          await client.query(
            'INSERT INTO orders (id, status, payment_status, paid_at, updated_at, created_at, doctor_id, assignment_status, acceptance_deadline_at) ' +
            "VALUES ($1, $2, $3, " + o.paidAt + ", NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', $4, $5, NULL)",
            [id(k), 'PAID', o.payment || 'paid', o.doctor === undefined ? null : o.doctor, o.assign === undefined ? 'auto' : o.assign]
          );
        };
        const OLD = "NOW() - INTERVAL '20 minutes'";
        await ins('ok', { paidAt: OLD });
        await ins('empty', { paidAt: OLD, doctor: '' });
        await ins('held', { paidAt: OLD, doctor: 'doc-held-' + sfx });
        await ins('refund', { paidAt: OLD, payment: 'refunded' });
        await ins('pre', { paidAt: "'2026-09-14T23:00:00Z'::timestamptz" });
        await ins('nullpaid', { paidAt: 'NULL' });
        await ins('young', { paidAt: "NOW() - INTERVAL '2 minutes'" });
        await ins('term', { paidAt: OLD });
        const addEvent = async function (caseId, type, payload) {
          await client.query(
            'INSERT INTO case_events (id, case_id, event_type, event_payload, created_at) VALUES ($1, $2, $3, $4, NOW())',
            [randomUUID(), caseId, type, payload == null ? null : JSON.stringify(payload)]
          );
        };
        await addEvent(id('term'), worker.STRANDED_PAID_PARKED_EVENT, { parked: false });
        const txAll = async function (sql, params) { return (await client.query(sql, params)).rows; };
        const rows = await worker.fetchStrandedPaidCases({ deps: { queryAll: txAll } });
        const got = new Set(rows.map(function (r) { return r.id; }));
        for (const k of ['ok', 'empty']) if (!got.has(id(k))) return 'real fetch did not select the ' + k + ' row';
        for (const k of ['held', 'refund', 'pre', 'nullpaid', 'young', 'term']) if (got.has(id(k))) return 'real fetch selected the ' + k + ' row';

        for (let i = 1; i <= MAX; i++) {
          await addEvent(id('empty'), RETRY_EVENT, { attempt: i, ok: false });
          await addEvent(id('held'), RETRY_EVENT, { attempt: i, ok: false });
        }
        const errors = [];
        const pushes = [];
        let broadcasts = 0;
        const txDeps = {
          queryOne: async function (sql, params) { return (await client.query(sql, params)).rows[0] || null; },
          execute: async function (sql, params) { const r = await client.query(sql, params); return { rowCount: r.rowCount }; },
          logCaseEvent: addEvent,
          broadcast: async function () { broadcasts++; return { ok: false, reason: 'db_probe' }; },
          pushOpsEvent: async function (o) { pushes.push(o); return { sent: true }; },
          logErrorToDb: function (err) { errors.push(err); },
        };
        await worker.handleStrandedPaidCase({ id: id('empty') }, { deps: txDeps });
        await worker.handleStrandedPaidCase({ id: id('held') }, { deps: txDeps });
        if (errors.length) return 'park SQL failed against the app schema: ' + (errors[0] && errors[0].message);
        if (broadcasts !== 0) return 'a capped case was broadcast again';
        const after = (await client.query('SELECT id, doctor_id, assignment_status FROM orders_active WHERE id = ANY($1::text[])', [[id('empty'), id('held')]])).rows;
        const empty = after.find(function (r) { return r.id === id('empty'); });
        const held = after.find(function (r) { return r.id === id('held'); });
        if (!empty || empty.assignment_status !== 'manual_queue' || empty.doctor_id !== null) return 'real park did not move the empty-string case to manual_queue with doctor_id NULL: ' + JSON.stringify(empty);
        if (!held || held.assignment_status !== 'auto' || held.doctor_id !== 'doc-held-' + sfx) return 'real park touched a held case: ' + JSON.stringify(held);
        const termRows = (await client.query('SELECT case_id, event_payload FROM case_events WHERE case_id = ANY($1::text[]) AND event_type = $2', [[id('empty'), id('held')], worker.STRANDED_PAID_PARKED_EVENT])).rows;
        const payloadOf = function (cid) {
          const r = termRows.filter(function (x) { return x.case_id === cid; });
          return r.length === 1 ? JSON.parse(r[0].event_payload) : { count: r.length };
        };
        if (payloadOf(id('empty')).parked !== true) return 'empty-string case terminal event must be one row parked:true, got ' + JSON.stringify(payloadOf(id('empty')));
        // Fix round 1: the held case's park is refused because a doctor holds
        // it, so the real re-read records it quietly as taken — no push.
        const heldPayload = payloadOf(id('held'));
        if (heldPayload.parked !== false || heldPayload.reason !== 'taken') return 'held case terminal event must be one row parked:false reason:taken, got ' + JSON.stringify(heldPayload);
        if (pushes.length !== 1 || pushes[0].orderId !== id('empty')) return 'expected exactly one final push, for the parked empty-string case, got ' + JSON.stringify(pushes.map(function (p) { return p.orderId; }));
        const again = await worker.fetchStrandedPaidCases({ deps: { queryAll: txAll } });
        if (again.some(function (r) { return r.id === id('empty'); })) return 'the parked case was fetched again';
        return null;
      } finally {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        client.release();
      }
    });

    await check('local DB (BEGIN…ROLLBACK): CASE_ROUTING_RESET scopes the real fetch and both real counts; the attempt INSERT and the reset helper really land, and the helper throws a real error', async function () {
      const miss = needImpl(); if (miss) return miss;
      if (typeof lifecycle.insertCaseEventOrThrow !== 'function') return 'case_lifecycle.insertCaseEventOrThrow is not exported';
      const pg = require('../../src/pg');
      const { randomUUID } = require('crypto');
      const client = await pg.pool.connect();
      try {
        await client.query('BEGIN');
        const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const id = function (k) { return 'treset-' + k + '-' + sfx; };
        const ins = async function (k) {
          await client.query(
            'INSERT INTO orders (id, status, payment_status, paid_at, updated_at, created_at, doctor_id, assignment_status, acceptance_deadline_at) ' +
            "VALUES ($1, 'PAID', 'paid', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NULL, 'auto', NULL)",
            [id(k)]
          );
        };
        // Explicit, hours-apart created_at: NOW() is fixed for the whole
        // transaction, so relying on it would give every seeded event the same
        // timestamp.
        const at = async function (caseId, type, payload, ago) {
          await client.query(
            'INSERT INTO case_events (id, case_id, event_type, event_payload, created_at) VALUES ($1, $2, $3, $4, NOW() - $5::interval)',
            [randomUUID(), caseId, type, payload == null ? null : JSON.stringify(payload), ago]
          );
        };
        const attempts = async function (caseId, ago) { for (let i = 1; i <= MAX; i++) await at(caseId, RETRY_EVENT, { attempt: i, ok: false }, ago); };
        await ins('after'); await ins('before'); await ins('restart'); await ins('helper');
        // after: parked, then reset → fetched with a fresh budget.
        await attempts(id('after'), '5 hours'); await at(id('after'), PARKED_EVENT, { parked: true }, '4 hours'); await at(id('after'), RESET_EVENT, null, '3 hours');
        // before: reset, then a later terminal event → still excluded.
        await at(id('before'), RESET_EVENT, null, '5 hours'); await attempts(id('before'), '4 hours'); await at(id('before'), PARKED_EVENT, { parked: false }, '3 hours');
        // restart: parked, reset, then a new capped episode with no terminal event.
        await attempts(id('restart'), '6 hours'); await at(id('restart'), PARKED_EVENT, { parked: true }, '5 hours');
        await at(id('restart'), RESET_EVENT, null, '4 hours'); await attempts(id('restart'), '3 hours');

        const txAll = async function (sql, params) { return (await client.query(sql, params)).rows; };
        const got = new Set((await worker.fetchStrandedPaidCases({ deps: { queryAll: txAll } })).map(function (r) { return r.id; }));
        if (!got.has(id('after'))) return 'real fetch did not select a case reset after its terminal event';
        if (!got.has(id('restart'))) return 'real fetch did not select a reset case whose new episode has no terminal event';
        if (got.has(id('before'))) return 'real fetch selected a case whose terminal event is newer than its reset';

        const errors = [];
        let broadcasts = 0;
        const txDeps = {
          queryOne: async function (sql, params) { return (await client.query(sql, params)).rows[0] || null; },
          execute: async function (sql, params) { const r = await client.query(sql, params); return { rowCount: r.rowCount }; },
          logCaseEvent: function (caseId, type, payload) { return lifecycle.logCaseEvent(caseId, type, payload, client); },
          broadcast: async function () { broadcasts++; return { ok: false, reason: 'db_probe' }; },
          pushOpsEvent: async function () { return { sent: true }; },
          logErrorToDb: function (err) { errors.push(err); },
        };
        await worker.handleStrandedPaidCase({ id: id('after') }, { deps: txDeps });
        if (errors.length) return 'the sweep failed against the app schema: ' + (errors[0] && errors[0].message);
        if (broadcasts !== 1) return 'a reset case with a fresh budget must be broadcast once, got ' + broadcasts;
        const newAttempt = (await client.query(
          "SELECT event_payload FROM case_events WHERE case_id = $1 AND event_type = $2 AND created_at > NOW() - INTERVAL '1 hour'",
          [id('after'), RETRY_EVENT]
        )).rows;
        if (newAttempt.length !== 1) return 'expected one new attempt row written by the sweep, got ' + newAttempt.length;
        const p = JSON.parse(newAttempt[0].event_payload);
        if (p.attempt !== 1 || p.ok !== false || p.reason !== 'db_probe') return 'the new attempt must be attempt 1 with its outcome, got ' + JSON.stringify(p);

        await worker.handleStrandedPaidCase({ id: id('restart') }, { deps: txDeps });
        if (errors.length) return 'the restart park failed against the app schema: ' + (errors[0] && errors[0].message);
        if (broadcasts !== 1) return 'a reset case whose new episode is capped must not be broadcast';
        const restartRow = (await client.query('SELECT assignment_status, doctor_id FROM orders_active WHERE id = $1', [id('restart')])).rows[0];
        if (!restartRow || restartRow.assignment_status !== 'manual_queue') return 'the new capped episode did not finish its park: ' + JSON.stringify(restartRow);
        const restartTerm = (await client.query('SELECT COUNT(*)::int AS c FROM case_events WHERE case_id = $1 AND event_type = $2', [id('restart'), PARKED_EVENT])).rows[0].c;
        if (restartTerm !== 2) return 'expected a second terminal event for the restart case, got ' + restartTerm;

        const helperId = await lifecycle.insertCaseEventOrThrow(id('helper'), RESET_EVENT, { via: 'guard' }, client);
        const helperRow = (await client.query('SELECT case_id, event_type, event_payload, created_at FROM case_events WHERE id = $1', [helperId])).rows[0];
        if (!helperRow || helperRow.event_type !== RESET_EVENT || helperRow.case_id !== id('helper') || JSON.parse(helperRow.event_payload).via !== 'guard' || !helperRow.created_at) return 'insertCaseEventOrThrow did not land the row it returned: ' + JSON.stringify(helperRow);
        await client.query('SAVEPOINT reset_helper_throw');
        let threw = null;
        try {
          await lifecycle.insertCaseEventOrThrow(id('helper'), RESET_EVENT, null, function (sql, params) {
            return client.query(sql.replace('INSERT INTO case_events', 'INSERT INTO case_events_guard_missing'), params);
          });
        } catch (e) { threw = e; }
        await client.query('ROLLBACK TO SAVEPOINT reset_helper_throw');
        if (!threw) return 'insertCaseEventOrThrow swallowed a real INSERT error';
        return null;
      } finally {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        client.release();
      }
    });
  }

  if (!global._testRunner) {
    try { await require('../../src/pg').pool.end(); } catch (_) { /* ignore */ }
  }
})();
