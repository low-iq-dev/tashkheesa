// tests/core/api-doctor-availability.test.js
//
// Doctor away dates + doctor-set cap (migration 116):
//   routes/api/doctor_me.js   GET /availability, POST /availability/away,
//                             DELETE /availability/away/:id,
//                             PUT /availability/taking-cases (doctor_away lift),
//                             PUT /availability/max-active
//   services/doctor_pause.js  applyDoctorAwayPeriods (the sweep)
//   services/doctor_eligibility.js capFor with doctor_max_active_override
//
// What these pin:
//   1. Away dates are a SCHEDULED SELF-PAUSE on users.is_paused /
//      pause_reason='doctor_away' — the one flag every routing path respects —
//      not a second availability concept. The sweep's two UPDATEs touch only a
//      doctor with no pause (to set) and only the 'doctor_away' reason (to
//      lift). A platform pause is never overwritten or lifted here.
//   2. A period that contains today pauses in the SAME request (the handler
//      runs the sweep before answering), and cancelling / "back early" lifts
//      in the same request.
//   3. The doctor's cap can only LOWER the platform's: capFor takes the
//      minimum, and the write path bounds n by the platform ceiling.
//   4. Every error code has a stable status + code; "not mine" and "missing"
//      are the same 404.
//
// Hermetic, same pattern as api-doctor-submit-report.test.js: mocked helpers,
// handlers pulled from router.stack, portal functions stubbed BY ASSIGNMENT on
// the real module objects (never by replacing require.cache entries).
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-availability-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '../../src');
const pg = require(path.join(ROOT, 'pg'));
const logger = require(path.join(ROOT, 'logger'));
const pauseMod = require(path.join(ROOT, 'services/doctor_pause'));
const { capFor } = require(path.join(ROOT, 'services/doctor_eligibility'));
const caseLifecycle = require(path.join(ROOT, 'case_lifecycle'));

// ─── routes/doctor.js `_queue` (same seeding rule as api-doctor-me.test.js) ─
const doctorPath = require.resolve(path.join(ROOT, 'routes/doctor'));
let seededDoctor = false;
let doctorMod;
try {
  doctorMod = require(doctorPath);
} catch (_) {
  if (!require.cache[doctorPath]) {
    doctorMod = { _queue: {} };
    require.cache[doctorPath] = { id: doctorPath, filename: doctorPath, loaded: true, exports: doctorMod };
    seededDoctor = true;
  } else {
    doctorMod = require.cache[doctorPath].exports;
  }
}
const q = doctorMod._queue;
const savedQueue = {
  countActiveCasesForDoctor: q.countActiveCasesForDoctor,
  readDoctorTiers: q.readDoctorTiers,
  DOCTOR_SLA_TIERS: q.DOCTOR_SLA_TIERS,
};
q.countActiveCasesForDoctor = async () => 2;
q.DOCTOR_SLA_TIERS = q.DOCTOR_SLA_TIERS || ['standard', 'vip', 'urgent'];
q.readDoctorTiers = q.readDoctorTiers || function (raw) {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { arr = null; } }
  if (!Array.isArray(arr)) return ['standard'];
  const out = ['standard', 'vip', 'urgent'].filter((t) => arr.includes(t));
  return out.length ? out : ['standard'];
};

// ─── Stubs by assignment on the real modules ───────────────────────────────
const saved = {
  execute: pg.execute,
  logErrorToDb: logger.logErrorToDb,
  applyDoctorAwayPeriods: pauseMod.applyDoctorAwayPeriods,
  cairoDateString: pauseMod.cairoDateString,
};
const calls = { execute: [], apply: [], log: [] };
// A fixed "today" so the range rules are deterministic whatever the wall clock.
const TODAY = '2026-09-24';
let today = TODAY;
let executeResults = [];
let applyShouldThrow = false;

pg.execute = async (sql, params) => {
  calls.execute.push({ sql, params });
  return executeResults.shift() || { rowCount: 0, rows: [] };
};
logger.logErrorToDb = async (err, ctx) => { calls.log.push({ err, ctx }); return 'err_x'; };
pauseMod.cairoDateString = () => today;
pauseMod.applyDoctorAwayPeriods = async (now) => {
  calls.apply.push(now);
  if (applyShouldThrow) throw new Error('sweep down');
  return { paused: 0, lifted: 0 };
};

test.after(() => {
  pg.execute = saved.execute;
  logger.logErrorToDb = saved.logErrorToDb;
  pauseMod.applyDoctorAwayPeriods = saved.applyDoctorAwayPeriods;
  pauseMod.cairoDateString = saved.cairoDateString;
  if (seededDoctor) delete require.cache[doctorPath];
  else Object.assign(q, savedQueue);
});

const buildRouter = require(path.join(ROOT, 'routes/api/doctor_me'));

// ─── Harness ───────────────────────────────────────────────────────────────
function handler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} ${routePath} not registered`);
}

function mockRes() {
  return {
    statusCode: 200, _json: null, _code: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    ok(data) { this._json = { success: true, data }; return this; },
    fail(message, status = 400, code) {
      this.statusCode = status; this._code = code;
      this._json = { success: false, error: message, code };
      return this;
    },
  };
}

const DOCTOR = {
  id: 'doc_1', name: 'Dr. Mona', role: 'doctor', specialty_id: 'spec_radiology',
  spoken_languages: '["ar","en"]', sub_specialties: [], onboarding_complete: true,
  approved_at: '2026-01-02T00:00:00Z', is_paused: false, paused_at: null, pause_reason: null,
  sla_tiers_supported: ['standard', 'vip'], max_active_cases: 4, max_active_cases_urgent: 8,
  doctor_max_active_override: null, payout_method: 'instapay', payout_handle: '01000000000',
  is_available: true, created_at: '2025-12-01T00:00:00Z',
};

// A scriptable DB: `rows` maps a regex on the SQL to the row(s) to return;
// every safeRun call is recorded so tests can assert the exact write.
function makeDb(rows = [], runResult) {
  const runs = [];
  const match = (sql) => { for (const [re, v] of rows) if (re.test(sql)) return v; return undefined; };
  const helpers = {
    safeGet: async (sql, params, fallback = null) => { const v = match(sql); return v === undefined ? fallback : (typeof v === 'function' ? v(params) : v); },
    safeAll: async (sql, params, fallback = []) => { const v = match(sql); return v === undefined ? fallback : (typeof v === 'function' ? v(params) : v); },
    safeRun: async (sql, params) => {
      runs.push({ sql, params });
      if (typeof runResult === 'function') return runResult(sql, params);
      return runResult || { rowCount: 1, rows: [] };
    },
  };
  return { helpers, runs };
}

async function drive({ method, route, body = {}, params = {}, user = { id: 'doc_1', role: 'doctor' }, db }) {
  db = db || makeDb();
  const router = buildRouter({}, db.helpers);
  const req = { params, body, user, query: {}, headers: {}, ip: '1.2.3.4', requestId: 'req_1', originalUrl: '/api/v1/doctor' + route, method: method.toUpperCase() };
  const res = mockRes();
  await handler(router, method, route)(req, res);
  return { res, runs: db.runs };
}

function reset() {
  for (const k of Object.keys(calls)) calls[k] = [];
  executeResults = [];
  applyShouldThrow = false;
  today = TODAY;
}

const USER_RE = /FROM users WHERE id = \$1 AND role = 'doctor' LIMIT 1/;
const AWAY_LIST_RE = /FROM doctor_away_periods\s+WHERE doctor_id = \$1 AND cancelled_at IS NULL AND to_date >= \$2::date/;
const IS_PAUSED_RE = /SELECT is_paused FROM users/;
const PAUSE_ROW_RE = /SELECT is_paused, pause_reason FROM users/;

// ═══ GET /availability ═════════════════════════════════════════════════════
test('GET /availability: away list, effective cap via capFor, ceiling, editable flags', async () => {
  reset();
  const db = makeDb([
    [USER_RE, { ...DOCTOR, doctor_max_active_override: 2 }],
    [AWAY_LIST_RE, (params) => {
      assert.deepEqual(params, ['doc_1', TODAY]);
      return [
        { id: 'away-1', from_day: '2026-10-01', to_day: '2026-10-07', note: 'Conference' },
        { id: 'away-2', from_day: '2026-11-01', to_day: '2026-11-01', note: null },
      ];
    }],
  ]);
  const { res } = await drive({ method: 'get', route: '/availability', db });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.taking_cases, true);
  assert.equal(d.max_active, 2, 'effective = min(platform 4, override 2)');
  assert.equal(d.max_active_ceiling, 4);
  assert.equal(d.max_active_editable, true);
  assert.equal(d.away_supported, true);
  assert.equal(d.self_pause_supported, true);
  assert.equal(d.currently_held, 2);
  assert.deepEqual(d.away, [
    { id: 'away-1', from: '2026-10-01', to: '2026-10-07', note: 'Conference' },
    { id: 'away-2', from: '2026-11-01', to: '2026-11-01', note: null },
  ]);
  // Existing fields survive.
  assert.deepEqual(d.tiers.map((t) => [t.tier, t.label_hours, t.on]), [
    ['standard', caseLifecycle.SLA_HOURS_BY_TIER.standard, true],
    ['vip', caseLifecycle.SLA_HOURS_BY_TIER.vip, true],
    ['urgent', caseLifecycle.SLA_HOURS_BY_TIER.urgent, false],
  ]);
  assert.equal(d.pause_reason, null);
  assert.equal(d.paused_by_self, false);
});

test('GET /availability: no override → max_active is the platform cap; paused_by_self covers doctor_self AND doctor_away', async () => {
  reset();
  let db = makeDb([[USER_RE, { ...DOCTOR }]]);
  let r = await drive({ method: 'get', route: '/availability', db });
  assert.equal(r.res._json.data.max_active, 4);
  assert.deepEqual(r.res._json.data.away, []);

  for (const reason of ['doctor_self', 'doctor_away']) {
    db = makeDb([[USER_RE, { ...DOCTOR, is_paused: true, pause_reason: reason }]]);
    r = await drive({ method: 'get', route: '/availability', db });
    assert.equal(r.res._json.data.taking_cases, false);
    assert.equal(r.res._json.data.paused_by_self, true, reason);
    assert.equal(r.res._json.data.pause_reason, reason);
  }
  db = makeDb([[USER_RE, { ...DOCTOR, is_paused: true, pause_reason: 'auto:sla_breach_threshold:3_in_30d' }]]);
  r = await drive({ method: 'get', route: '/availability', db });
  assert.equal(r.res._json.data.paused_by_self, false);
});

// ═══ POST /availability/away ═══════════════════════════════════════════════
test('POST /availability/away validates: INVALID_REQUEST, INVALID_RANGE, RANGE_TOO_LONG — nothing written', async () => {
  reset();
  const cases = [
    [{ from: 'x', to: '2026-10-01' }, 'INVALID_REQUEST'],
    [{ to: '2026-10-01' }, 'INVALID_REQUEST'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'INVALID_REQUEST'],        // not a real date
    [{ from: '2026-10-01', to: '2026-10-02', note: 5 }, 'INVALID_REQUEST'],
    [{ from: '2026-10-05', to: '2026-10-01' }, 'INVALID_RANGE'],          // to < from
    [{ from: '2026-09-23', to: '2026-09-25' }, 'INVALID_RANGE'],          // from < today
    [{ from: '2026-10-01', to: '2026-12-31' }, 'RANGE_TOO_LONG'],         // 91 days
  ];
  for (const [body, code] of cases) {
    const r = await drive({ method: 'post', route: '/availability/away', body });
    assert.equal(r.res.statusCode, 400, JSON.stringify(body));
    assert.equal(r.res._code, code, JSON.stringify(body));
    assert.equal(r.runs.length, 0);
  }
  assert.equal(calls.apply.length, 0);
});

test('POST /availability/away inserts an away- row; a future period does NOT run the sweep', async () => {
  reset();
  const db = makeDb(
    [[IS_PAUSED_RE, { is_paused: false }]],
    () => ({ rowCount: 1, rows: [{ id: 'away-abc', from_day: '2026-10-01', to_day: '2026-10-07', note: 'Conference' }] })
  );
  const { res, runs } = await drive({
    method: 'post', route: '/availability/away',
    body: { from: '2026-10-01', to: '2026-10-07', note: '  Conference  ' }, db,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, {
    away: { id: 'away-abc', from: '2026-10-01', to: '2026-10-07', note: 'Conference' },
    taking_cases: true,
  });
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /INSERT INTO doctor_away_periods \(id, doctor_id, from_date, to_date, note\)/);
  assert.match(runs[0].sql, /'away-' \|\| gen_random_uuid\(\)/);
  assert.deepEqual(runs[0].params, ['doc_1', '2026-10-01', '2026-10-07', 'Conference']);
  assert.equal(calls.apply.length, 0, 'today is outside the range: the sweep handles it on the day');
});

test('POST /availability/away with today inside the range runs applyDoctorAwayPeriods before answering; 90-day span allowed; note capped at 120', async () => {
  reset();
  const long = 'n'.repeat(200);
  const db = makeDb(
    [[IS_PAUSED_RE, { is_paused: true }]],   // the sweep just paused them
    () => ({ rowCount: 1, rows: [{ id: 'away-t', from_day: TODAY, to_day: '2026-12-23', note: long.slice(0, 120) }] })
  );
  const { res, runs } = await drive({
    method: 'post', route: '/availability/away', body: { from: TODAY, to: '2026-12-23', note: long }, db,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res._json));
  assert.equal(res._json.data.taking_cases, false);
  assert.equal(runs[0].params[3].length, 120);
  assert.equal(calls.apply.length, 1);
  assert.ok(calls.apply[0] instanceof Date);
});

test('POST /availability/away: a sweep failure after the INSERT is logged, never a 500; a failed INSERT is AWAY_SAVE_FAILED', async () => {
  reset();
  applyShouldThrow = true;
  let db = makeDb(
    [[IS_PAUSED_RE, { is_paused: false }]],
    () => ({ rowCount: 1, rows: [{ id: 'away-t', from_day: TODAY, to_day: TODAY, note: null }] })
  );
  let r = await drive({ method: 'post', route: '/availability/away', body: { from: TODAY, to: TODAY }, db });
  assert.equal(r.res.statusCode, 200);
  assert.equal(calls.log.length, 1);
  assert.equal(calls.log[0].ctx.context, 'api.doctor_me.away_apply');

  reset();
  db = makeDb([], () => { throw new Error('boom'); });
  r = await drive({ method: 'post', route: '/availability/away', body: { from: TODAY, to: TODAY }, db });
  assert.equal(r.res.statusCode, 500); assert.equal(r.res._code, 'AWAY_SAVE_FAILED');
  assert.equal(calls.apply.length, 0);
});

// ═══ DELETE /availability/away/:id ═════════════════════════════════════════
test('DELETE /availability/away/:id cancels ONLY my own uncancelled row, then runs the sweep', async () => {
  reset();
  const db = makeDb([[IS_PAUSED_RE, { is_paused: false }]], { rowCount: 1, rows: [] });
  const { res, runs } = await drive({ method: 'delete', route: '/availability/away/:id', params: { id: 'away-1' }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { ok: true, taking_cases: true });
  assert.equal(runs.length, 1);
  assert.match(runs[0].sql, /UPDATE doctor_away_periods SET cancelled_at = NOW\(\)/);
  assert.match(runs[0].sql, /WHERE id = \$1 AND doctor_id = \$2 AND cancelled_at IS NULL/);
  assert.deepEqual(runs[0].params, ['away-1', 'doc_1']);
  assert.equal(calls.apply.length, 1);
});

test('DELETE /availability/away/:id: not mine / missing / already cancelled → 404 AWAY_NOT_FOUND, no sweep', async () => {
  reset();
  const db = makeDb([], { rowCount: 0, rows: [] });
  const { res } = await drive({ method: 'delete', route: '/availability/away/:id', params: { id: 'away-theirs' }, db });
  assert.equal(res.statusCode, 404); assert.equal(res._code, 'AWAY_NOT_FOUND');
  assert.equal(calls.apply.length, 0);

  const r2 = await drive({ method: 'delete', route: '/availability/away/:id', params: {} });
  assert.equal(r2.res.statusCode, 400); assert.equal(r2.res._code, 'INVALID_REQUEST');
});

// ═══ PUT /availability/taking-cases with a doctor_away pause ═══════════════
test('PUT taking-cases on=true while paused doctor_away: cancels the period holding today FIRST, then lifts that reason only', async () => {
  reset();
  const db = makeDb([[PAUSE_ROW_RE, { is_paused: true, pause_reason: 'doctor_away' }]]);
  const { res, runs } = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, { taking_cases: true });
  assert.equal(runs.length, 2);
  assert.match(runs[0].sql, /UPDATE doctor_away_periods SET cancelled_at = NOW\(\)/);
  assert.match(runs[0].sql, /WHERE doctor_id = \$1 AND cancelled_at IS NULL/);
  assert.match(runs[0].sql, /from_date <= \$2::date AND to_date >= \$2::date/);
  assert.deepEqual(runs[0].params, ['doc_1', TODAY]);
  assert.match(runs[1].sql, /SET is_paused = false, paused_at = NULL, pause_reason = NULL/);
  assert.match(runs[1].sql, /AND pause_reason = \$2/);
  assert.deepEqual(runs[1].params, ['doc_1', 'doctor_away']);
});

test('PUT taking-cases: doctor_self lift is unchanged (no period write); platform pauses still 409; on=false while doctor_away is a no-op', async () => {
  reset();
  let db = makeDb([[PAUSE_ROW_RE, { is_paused: true, pause_reason: 'doctor_self' }]]);
  let r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.runs.length, 1);
  assert.deepEqual(r.runs[0].params, ['doc_1', 'doctor_self']);

  db = makeDb([[PAUSE_ROW_RE, { is_paused: true, pause_reason: 'ops: complaints' }]]);
  r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: true }, db });
  assert.equal(r.res.statusCode, 409); assert.equal(r.res._code, 'PAUSED_BY_PLATFORM');
  assert.equal(r.runs.length, 0);

  db = makeDb([[PAUSE_ROW_RE, { is_paused: true, pause_reason: 'doctor_away' }]]);
  r = await drive({ method: 'put', route: '/availability/taking-cases', body: { on: false }, db });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { taking_cases: false });
  assert.equal(r.runs.length, 0, 'already paused: the away reason is kept so the sweep can lift it');
});

// ═══ PUT /availability/max-active ══════════════════════════════════════════
const CAP_ROW_RE = /SELECT max_active_cases, max_active_cases_urgent, doctor_max_active_override/;

test('PUT /availability/max-active bounds n by the platform ceiling and writes the override', async () => {
  reset();
  const rows = [[CAP_ROW_RE, { max_active_cases: 4, max_active_cases_urgent: 8, doctor_max_active_override: null }]];
  for (const n of [-1, 1.5, '2', 5, undefined, null]) {
    const r = await drive({ method: 'put', route: '/availability/max-active', body: { n }, db: makeDb(rows) });
    assert.equal(r.res.statusCode, 400, String(n)); assert.equal(r.res._code, 'INVALID_CAP', String(n));
    assert.equal(r.runs.length, 0);
  }
  let r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 2 }, db: makeDb(rows) });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { max_active: 2, max_active_ceiling: 4 });
  assert.match(r.runs[0].sql, /UPDATE users SET doctor_max_active_override = \$2 WHERE id = \$1 AND role = 'doctor'/);
  assert.deepEqual(r.runs[0].params, ['doc_1', 2]);

  // n = ceiling is allowed (a no-op lowering, but the doctor's explicit choice).
  r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 4 }, db: makeDb(rows) });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { max_active: 4, max_active_ceiling: 4 });

  // n = 0 clears: NULL written, effective cap back to the platform's.
  r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 0 }, db: makeDb([[CAP_ROW_RE, { max_active_cases: 4, max_active_cases_urgent: 8, doctor_max_active_override: 2 }]]) });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { max_active: 4, max_active_ceiling: 4 });
  assert.deepEqual(r.runs[0].params, ['doc_1', null]);
});

test('PUT /availability/max-active with no platform cap allows 1..20; unknown doctor → 404; failed write → 500', async () => {
  reset();
  const noCap = [[CAP_ROW_RE, { max_active_cases: null, max_active_cases_urgent: null, doctor_max_active_override: null }]];
  let r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 21 }, db: makeDb(noCap) });
  assert.equal(r.res.statusCode, 400); assert.equal(r.res._code, 'INVALID_CAP');
  r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 20 }, db: makeDb(noCap) });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res._json.data, { max_active: 20, max_active_ceiling: 0 });

  r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 1 } });
  assert.equal(r.res.statusCode, 404); assert.equal(r.res._code, 'NOT_FOUND');

  r = await drive({ method: 'put', route: '/availability/max-active', body: { n: 1 }, db: makeDb(noCap, () => { throw new Error('boom'); }) });
  assert.equal(r.res.statusCode, 500); assert.equal(r.res._code, 'AVAILABILITY_SAVE_FAILED');
});

// ═══ GET /profile carries the payout columns ═══════════════════════════════
test('GET /profile exposes payout_method / payout_handle (ops-set, read-only here)', async () => {
  reset();
  let db = makeDb([[USER_RE, { ...DOCTOR }], [/FROM reviews/, { avg_rating: null, count: '0' }]]);
  let r = await drive({ method: 'get', route: '/profile', db });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res._json.data.doctor.payout_method, 'instapay');
  assert.equal(r.res._json.data.doctor.payout_handle, '01000000000');
  db = makeDb([[USER_RE, { ...DOCTOR, payout_method: null, payout_handle: '' }], [/FROM reviews/, { avg_rating: null, count: '0' }]]);
  r = await drive({ method: 'get', route: '/profile', db });
  assert.equal(r.res._json.data.doctor.payout_method, null);
  assert.equal(r.res._json.data.doctor.payout_handle, null);
});

// ═══ capFor with the override (real function, fixture rows) ════════════════
test('capFor: the override only LOWERS the platform cap; alone when there is no platform cap; junk ignored', () => {
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8 }, 'standard'), 5);
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8, doctor_max_active_override: 2 }, 'standard'), 2);
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8, doctor_max_active_override: 9 }, 'standard'), 5, 'cannot raise');
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8, doctor_max_active_override: 2 }, 'vip'), 2);
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8, doctor_max_active_override: 2 }, 'urgent'), 2, 'lowers the urgent cap too');
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 1, doctor_max_active_override: 2 }, 'urgent'), 1);
  assert.equal(capFor({ max_active_cases: null, max_active_cases_urgent: null, doctor_max_active_override: 3 }, 'standard'), 3, 'override alone when no platform cap');
  assert.equal(capFor({ max_active_cases: 0, max_active_cases_urgent: 0, doctor_max_active_override: '3' }, 'urgent'), 3);
  for (const junk of [null, undefined, 0, -1, 'x', NaN, Infinity]) {
    assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 8, doctor_max_active_override: junk }, 'standard'), 5, String(junk));
    assert.equal(capFor({ max_active_cases: null, max_active_cases_urgent: null, doctor_max_active_override: junk }, 'standard'), 0, String(junk));
  }
});

// ═══ applyDoctorAwayPeriods — the sweep's SQL shape ════════════════════════
test('applyDoctorAwayPeriods: two idempotent UPDATEs on the Cairo day; sets only an unpaused doctor, lifts only doctor_away; returns counts', async () => {
  reset();
  // Use the REAL function (the stub is on the module object; grab the saved one).
  const real = saved.applyDoctorAwayPeriods;
  // 2026-06-30T22:30Z is already 2026-07-01 in Cairo (UTC+3 under DST).
  const at = new Date('2026-06-30T22:30:00Z');
  executeResults = [{ rowCount: 2 }, { rowCount: 1 }];
  const out = await real(at);
  assert.deepEqual(out, { paused: 2, lifted: 1 });
  assert.equal(calls.execute.length, 2);

  const [setQ, liftQ] = calls.execute;
  assert.deepEqual(setQ.params, ['2026-07-01', 'doctor_away']);
  assert.deepEqual(liftQ.params, ['2026-07-01', 'doctor_away']);

  assert.match(setQ.sql, /UPDATE users u\s+SET is_paused = true, paused_at = NOW\(\), pause_reason = \$2/);
  assert.match(setQ.sql, /u\.role = 'doctor'/);
  assert.match(setQ.sql, /COALESCE\(u\.is_paused, false\) = false/, 'never overwrites an existing pause of any reason');
  assert.match(setQ.sql, /EXISTS \(SELECT 1 FROM doctor_away_periods p/);
  assert.match(setQ.sql, /p\.cancelled_at IS NULL/);
  assert.match(setQ.sql, /p\.from_date <= \$1::date/);
  assert.match(setQ.sql, /p\.to_date\s+>= \$1::date/);

  assert.match(liftQ.sql, /UPDATE users u\s+SET is_paused = false, paused_at = NULL, pause_reason = NULL/);
  assert.match(liftQ.sql, /u\.is_paused = true/);
  assert.match(liftQ.sql, /u\.pause_reason = \$2/, 'lifts this reason only');
  assert.match(liftQ.sql, /NOT EXISTS \(SELECT 1 FROM doctor_away_periods p/);
  assert.match(liftQ.sql, /p\.cancelled_at IS NULL/);

  // Nothing to do → zero counts, still two statements (idempotent, no state).
  reset();
  executeResults = [{ rowCount: 0 }, { rowCount: 0 }];
  assert.deepEqual(await real(new Date('2026-01-15T12:00:00Z')), { paused: 0, lifted: 0 });
  assert.equal(calls.execute[0].params[0], '2026-01-15');
});

test('cairoDateString: Africa/Cairo calendar day, DST-aware', () => {
  const real = saved.cairoDateString;
  assert.equal(real(new Date('2026-06-30T22:30:00Z')), '2026-07-01');   // UTC+3 in summer
  assert.equal(real(new Date('2026-01-31T21:30:00Z')), '2026-01-31');   // UTC+2 in winter: 23:30 local
  assert.equal(real(new Date('2026-01-31T22:30:00Z')), '2026-02-01');
  assert.equal(pauseMod.DOCTOR_AWAY_REASON, 'doctor_away');
});
