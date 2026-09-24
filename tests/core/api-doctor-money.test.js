// tests/core/api-doctor-money.test.js
//
// /api/v1/doctor/{earnings, earnings/lines, statements, reviews, analytics}
// — the doctor app's money surface (src/routes/api/doctor_money.js).
//
// What these pin:
//   1. Every money figure comes from services/earnings_reader (stubbed here),
//      keyed by req.user.id and nothing else — a doctor id in the query is
//      ignored, and a request with no doctor id never reaches a reader.
//   2. The response shapes the app types against, with the ledger facts the
//      route derives: breakdown passthrough, clawback / reassigned line
//      status, the open/paid statement rule, the zero-filled review
//      distribution, the SLA promise read from case_lifecycle.
//   3. Every error code: INVALID_REQUEST, INVALID_MONTH and the per-route
//      *_UNAVAILABLE 500s when a reader throws.
//
// Hermetic: reader functions are stubbed by assignment on the REAL module
// object (test files share the require cache — never replace the cache
// entry) and restored after; helpers are fakes; no DB, no boot.
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'doctor-money-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const reader = require(path.join(__dirname, '../../src/services/earnings_reader'));
const caseLifecycle = require(path.join(__dirname, '../../src/case_lifecycle'));
const buildRouter = require('../../src/routes/api/doctor_money');

const STUBBED = [
  'getDoctorMonthSummary', 'getDoctorMonthlyStatement', 'getDoctorMonthBreakdown',
  'getMostRecentPaidEarning', 'getDoctorStatementPaidAt', 'getDoctorEarningLines',
];
const real = {};
STUBBED.forEach((k) => { real[k] = reader[k]; });
test.after(() => { STUBBED.forEach((k) => { reader[k] = real[k]; }); });

const CUR = reader.currentCairoMonth();
// The Cairo month before the current one, as 'YYYY-MM'.
const PREV = (() => {
  const [y, m] = CUR.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

// Statement `month` cells arrive as DATE → JS Date at local midnight.
const monthDate = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); };

let calls;
function installStubs(overrides = {}) {
  calls = [];
  const rec = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const defaults = {
    getDoctorMonthSummary: async () => ({ approved: 0, notYetApproved: 2082, total: 2082 }),
    getDoctorMonthlyStatement: async () => ({
      main: [
        { month: monthDate(CUR), case_count: '5', total: 1602, paid_total: 0, pending_total: 1602, reassigned_total: 0, reassigned_count: '1' },
        { month: monthDate(PREV), case_count: '1', total: 500, paid_total: 500, pending_total: 0, reassigned_total: 0, reassigned_count: '0' },
      ],
      addons: [
        { month: monthDate(CUR), total: '480', paid_total: '0', pending_total: '480', reassigned_total: 0 },
      ],
    }),
    getDoctorMonthBreakdown: async (_d, month) => ({
      month,
      breakdown: [
        { key: 'service_fees', count: 3, amount: 1062 },
        { key: 'uplift_share', count: 1, amount: 300 },
        { key: 'video', count: 2, amount: 400 },
        { key: 'prescription', count: 1, amount: 320 },
      ],
    }),
    getMostRecentPaidEarning: async () => ({ id: 'earn-main-6', earnedAmount: 500, paidAt: new Date('2026-09-04T09:31:11.498Z'), orderId: 'o6' }),
    getDoctorStatementPaidAt: async () => ({ [PREV]: new Date('2026-09-04T09:31:11.498Z') }),
    getDoctorEarningLines: async (_d, month) => ({
      month,
      lines: [
        { id: 'earn-main-1', source: 'doctor_earnings', kind: 'report', reference_id: 'TSH-0001', tier: 'urgent', amount: 800, status: 'pending', clawback_reason: null, clawback_applied_at: null, reassignment_reason: null, paid_at: null, completed_at: new Date('2026-09-21T11:31:11Z') },
        { id: 'earn-main-3', source: 'doctor_earnings', kind: 'report', reference_id: 'TSH-0003', tier: 'vip', amount: 62, status: 'pending', clawback_reason: 'patient_or_operator_post_acceptance_scaled_90pct_clawback', clawback_applied_at: new Date('2026-09-23T09:31:11Z'), reassignment_reason: null, paid_at: null, completed_at: new Date('2026-09-19T09:31:11Z') },
        { id: 'earn-main-5', source: 'doctor_earnings', kind: 'report', reference_id: 'TSH-0005', tier: 'standard', amount: 0, status: 'reassigned', clawback_reason: null, clawback_applied_at: null, reassignment_reason: 'sla_breach', paid_at: null, completed_at: new Date('2026-09-19T09:31:11Z') },
        { id: 'earn-main-6', source: 'doctor_earnings', kind: 'report', reference_id: 'TSH-0006', tier: 'standard', amount: 500, status: 'paid', clawback_reason: null, clawback_applied_at: null, reassignment_reason: null, paid_at: new Date('2026-09-04T09:31:11Z'), completed_at: new Date('2026-08-06T09:31:11Z') },
        { id: 'a05f5c6c', source: 'addon_earnings', kind: 'prescription', reference_id: null, tier: null, amount: 320, status: 'pending', clawback_reason: null, clawback_applied_at: null, reassignment_reason: null, paid_at: null, completed_at: new Date('2026-09-22T09:31:11Z') },
      ],
    }),
  };
  STUBBED.forEach((k) => { reader[k] = rec(k, overrides[k] || defaults[k]); });
}

function handler(router, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods.get) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error('GET ' + routePath + ' not registered');
}

function mockRes() {
  return {
    statusCode: 200, _json: null, _code: null, headersSent: false,
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

const DEFAULT_HELPERS = {
  safeGet: async (_sql, _params, fallback = null) => fallback,
  safeAll: async (_sql, _params, fallback = []) => fallback,
};

async function drive(routePath, { user = { id: 'doc_1', role: 'doctor' }, query = {}, helpers = DEFAULT_HELPERS } = {}) {
  const router = buildRouter({}, helpers);
  const req = { params: {}, body: {}, user, query, headers: {} };
  const res = mockRes();
  await handler(router, routePath)(req, res);
  return res;
}

// ─── /earnings ──────────────────────────────────────────────

test('GET /earnings: structured summary, this Cairo month, breakdown sums to month_total', async () => {
  installStubs();
  const res = await drive('/earnings');
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.month, CUR);
  assert.equal(d.month_total, 2082);
  assert.equal(d.reports_total, 1602);
  assert.equal(d.addons_total, 480);
  assert.equal(d.reassigned_total, 0);
  assert.equal(d.reassigned_count, 1);
  assert.deepEqual(d.breakdown.map((b) => b.key), ['service_fees', 'uplift_share', 'video', 'prescription']);
  assert.equal(d.breakdown.reduce((s, b) => s + b.amount, 0), d.month_total);
  assert.deepEqual(d.last_paid, { month: PREV, amount: 500, paid_at: '2026-09-04T09:31:11.498Z' });
  // Every reader call is keyed by the JWT's doctor id.
  assert.ok(calls.length >= 4);
  calls.forEach((c) => assert.equal(c[1], 'doc_1', c[0] + ' keyed by req.user.id'));
  const bd = calls.find((c) => c[0] === 'getDoctorMonthBreakdown');
  assert.equal(bd[2], CUR);
});

test('GET /earnings: no payout yet → last_paid null; a doctor id in the query is ignored', async () => {
  installStubs({ getMostRecentPaidEarning: async () => null });
  const res = await drive('/earnings', { query: { doctor_id: 'doc_other', doctorId: 'doc_other' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res._json.data.last_paid, null);
  calls.forEach((c) => assert.equal(c[1], 'doc_1'));
  assert.ok(!calls.some((c) => c[0] === 'getDoctorStatementPaidAt'), 'no paid-at lookup without a payout');
});

test('GET /earnings: a reader failure is a 500 EARNINGS_UNAVAILABLE, never a hang', async () => {
  installStubs({ getDoctorMonthSummary: async () => { throw new Error('db down'); } });
  const res = await drive('/earnings');
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'EARNINGS_UNAVAILABLE');
  assert.equal(res._json.success, false);
});

// ─── /earnings/lines ────────────────────────────────────────

test('GET /earnings/lines: defaults to the current Cairo month; structured detail; status from row + clawback', async () => {
  installStubs();
  const res = await drive('/earnings/lines');
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.month, CUR);
  const linesCall = calls.find((c) => c[0] === 'getDoctorEarningLines');
  assert.deepEqual([linesCall[1], linesCall[2]], ['doc_1', CUR]);

  const by = {};
  d.lines.forEach((l) => { by[l.id] = l; });
  assert.deepEqual(by['earn-main-1'], {
    id: 'earn-main-1', ref: 'TSH-0001', detail: { kind: 'report', tier: 'urgent' },
    amount: 800, status: 'pending', note: null, at: '2026-09-21T11:31:11.000Z', paid_at: null,
  });
  // Clawback: applied in place by earnings_writer → post-clawback amount, status + reason.
  assert.equal(by['earn-main-3'].status, 'clawback');
  assert.equal(by['earn-main-3'].amount, 62);
  assert.equal(by['earn-main-3'].note, 'patient_or_operator_post_acceptance_scaled_90pct_clawback');
  // Reassigned: 0, with the reason.
  assert.equal(by['earn-main-5'].status, 'reassigned');
  assert.equal(by['earn-main-5'].amount, 0);
  assert.equal(by['earn-main-5'].note, 'sla_breach');
  // Paid.
  assert.equal(by['earn-main-6'].status, 'paid');
  assert.equal(by['earn-main-6'].paid_at, '2026-09-04T09:31:11.000Z');
  // Add-on with no joinable order: 'Add-on', never a patient name.
  assert.equal(by['a05f5c6c'].ref, 'Add-on');
  assert.deepEqual(by['a05f5c6c'].detail, { kind: 'prescription', tier: null });
  // No line carries a sentence or a patient field.
  d.lines.forEach((l) => {
    assert.equal(typeof l.detail, 'object');
    assert.ok(!('patient_name' in l) && !('name' in l));
  });
});

test('GET /earnings/lines?month=YYYY-MM: passes the month through; malformed month is 400 INVALID_MONTH', async () => {
  installStubs();
  const ok = await drive('/earnings/lines', { query: { month: '2026-08' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok._json.data.month, '2026-08');
  assert.equal(calls.find((c) => c[0] === 'getDoctorEarningLines')[2], '2026-08');

  for (const bad of ['2026-13', '2026/08', 'august', '2026-8', '2026-08-01']) {
    installStubs();
    const res = await drive('/earnings/lines', { query: { month: bad } });
    assert.equal(res.statusCode, 400, `month=${bad}`);
    assert.equal(res._code, 'INVALID_MONTH');
    assert.equal(calls.length, 0, 'no reader call on a bad month');
  }
});

test('GET /earnings/lines: reader failure → 500 EARNINGS_UNAVAILABLE', async () => {
  installStubs({ getDoctorEarningLines: async () => { throw new Error('db down'); } });
  const res = await drive('/earnings/lines');
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'EARNINGS_UNAVAILABLE');
});

// ─── /statements ────────────────────────────────────────────

test('GET /statements: one per Cairo month, newest first; paid only when closed and nothing pending; payout nulls', async () => {
  installStubs();
  const res = await drive('/statements');
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.deepEqual(d.payout, { method: null, handle: null });
  assert.equal(d.statements.length, 2);
  assert.deepEqual(d.statements[0], {
    id: 'st_' + CUR.replace('-', '_'), month: CUR, amount: 2082, status: 'open', paid_at: null, reassigned_count: 1,
  });
  assert.deepEqual(d.statements[1], {
    id: 'st_' + PREV.replace('-', '_'), month: PREV, amount: 500, status: 'paid',
    paid_at: '2026-09-04T09:31:11.498Z', reassigned_count: 0,
  });
  calls.forEach((c) => assert.equal(c[1], 'doc_1'));
});

test('GET /statements: a past month with anything still pending is open, and a paid month with a pending add-on is open', async () => {
  installStubs({
    getDoctorMonthlyStatement: async () => ({
      main: [{ month: monthDate(PREV), case_count: '2', total: 900, paid_total: 500, pending_total: 400, reassigned_total: 0, reassigned_count: '0' }],
      addons: [{ month: monthDate(PREV), total: '160', paid_total: '160', pending_total: '0', reassigned_total: 0 }],
    }),
  });
  let res = await drive('/statements');
  assert.equal(res._json.data.statements[0].status, 'open');
  assert.equal(res._json.data.statements[0].amount, 1060);
  assert.equal(res._json.data.statements[0].paid_at, null);

  installStubs({
    getDoctorMonthlyStatement: async () => ({
      main: [{ month: monthDate(PREV), case_count: '1', total: 500, paid_total: 500, pending_total: 0, reassigned_total: 0, reassigned_count: '0' }],
      addons: [{ month: monthDate(PREV), total: '160', paid_total: '0', pending_total: '160', reassigned_total: 0 }],
    }),
  });
  res = await drive('/statements');
  assert.equal(res._json.data.statements[0].status, 'open');
});

test('GET /statements: statement month cells given as strings are bucketed too', async () => {
  installStubs({
    getDoctorMonthlyStatement: async () => ({
      main: [{ month: PREV + '-01', case_count: '1', total: 500, paid_total: 500, pending_total: 0, reassigned_total: 0, reassigned_count: '0' }],
      addons: [],
    }),
  });
  const res = await drive('/statements');
  assert.equal(res._json.data.statements[0].month, PREV);
  assert.equal(res._json.data.statements[0].status, 'paid');
});

test('GET /statements: reader failure → 500 STATEMENTS_UNAVAILABLE', async () => {
  installStubs({ getDoctorMonthlyStatement: async () => { throw new Error('db down'); } });
  const res = await drive('/statements');
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'STATEMENTS_UNAVAILABLE');
});

// ─── /reviews ───────────────────────────────────────────────

test('GET /reviews: visible reviews for this doctor only, distribution zero-filled 5..1, no patient name', async () => {
  installStubs();
  const seen = [];
  const helpers = {
    safeGet: async (sql, params, fallback) => {
      seen.push([sql, params]);
      assert.match(sql, /is_visible = true/);
      assert.deepEqual(params, ['doc_1']);
      return { avg_rating: '4.5', count: '2' };
    },
    safeAll: async (sql, params, fallback) => {
      seen.push([sql, params]);
      assert.match(sql, /is_visible = true/);
      assert.deepEqual(params, ['doc_1']);
      if (/GROUP BY rating/.test(sql)) return [{ rating: 5, n: '1' }, { rating: 4, n: '1' }];
      assert.match(sql, /LIMIT 50/);
      assert.match(sql, /ORDER BY r\.created_at DESC/);
      assert.match(sql, /orders_active/);
      assert.doesNotMatch(sql, /u\.name|patient_name/);
      return [
        { id: 'r1', rating: 5, review_text: 'Great', is_anonymous: false, created_at: new Date('2026-09-23T09:31:11Z'), reference_id: 'TSH-0001' },
        { id: 'r2', rating: 4, review_text: null, is_anonymous: true, created_at: new Date('2026-09-16T09:31:11Z'), reference_id: null },
      ];
    },
  };
  const res = await drive('/reviews', { helpers });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.avg, 4.5);
  assert.equal(d.count, 2);
  assert.deepEqual(d.distribution, [
    { stars: 5, n: 1 }, { stars: 4, n: 1 }, { stars: 3, n: 0 }, { stars: 2, n: 0 }, { stars: 1, n: 0 },
  ]);
  assert.deepEqual(d.reviews, [
    { id: 'r1', stars: 5, text: 'Great', order_reference: 'TSH-0001', created_at: '2026-09-23T09:31:11.000Z', anonymous: false },
    { id: 'r2', stars: 4, text: null, order_reference: null, created_at: '2026-09-16T09:31:11.000Z', anonymous: true },
  ]);
  assert.equal(seen.length, 3);
});

test('GET /reviews: a doctor with no reviews gets zeros, not nulls', async () => {
  installStubs();
  const res = await drive('/reviews');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res._json.data, {
    avg: 0, count: 0,
    distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, n: 0 })),
    reviews: [],
  });
});

test('GET /reviews: helper throwing → 500 REVIEWS_UNAVAILABLE', async () => {
  installStubs();
  const helpers = { safeGet: async () => { throw new Error('boom'); }, safeAll: async () => [] };
  const res = await drive('/reviews', { helpers });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'REVIEWS_UNAVAILABLE');
});

// ─── /analytics ─────────────────────────────────────────────

test('GET /analytics: 90-day figures, practice excluded, SLA promise from case_lifecycle, 6 zero-filled months', async () => {
  installStubs();
  const sqls = [];
  const helpers = {
    safeGet: async (sql, params, fallback) => {
      sqls.push(sql);
      assert.equal(params[0], 'doc_1');
      assert.match(sql, /orders_active/);
      assert.match(sql, /NOT o\.is_practice/);
      assert.doesNotMatch(sql, /\bprice\b/);
      if (/doctor_assignments/.test(sql)) return { offered: '3', accepted: '2' };
      // Completed spellings come from case_lifecycle, bound as a text[].
      assert.deepEqual(params[1], [...new Set(caseLifecycle.dbStatusValuesFor(caseLifecycle.CASE_STATUS.COMPLETED).map((s) => s.toLowerCase()))]);
      return { reports_issued: '4', avg_turnaround_h: '18.4567', deadlines_missed: '1' };
    },
    safeAll: async (sql, params, fallback) => {
      sqls.push(sql);
      assert.equal(params[0], 'doc_1');
      assert.match(sql, /NOT o\.is_practice/);
      if (/to_char/.test(sql)) return [{ label: CUR, n: '3' }, { label: PREV, n: '1' }];
      return [{ tier: 'standard', actual_h: '24.04' }, { tier: 'fast_track', actual_h: '10' }, { tier: 'urgent', actual_h: '2' }];
    },
  };
  const res = await drive('/analytics', { helpers });
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.reports_issued, 4);
  assert.equal(d.acceptance_pct, 66.7);
  assert.equal(d.avg_turnaround_h, 18.5);
  assert.equal(d.deadlines_missed, 1);
  assert.equal(d.monthly.length, 6);
  assert.equal(d.monthly[5].label, CUR);
  assert.equal(d.monthly[5].n, 3);
  assert.equal(d.monthly[4].label, PREV);
  assert.equal(d.monthly[4].n, 1);
  d.monthly.slice(0, 4).forEach((m) => { assert.match(m.label, /^\d{4}-\d{2}$/); assert.equal(m.n, 0); });
  assert.deepEqual(d.turnaround, [
    { tier: 'standard', promised_h: caseLifecycle.SLA_HOURS_BY_TIER.standard, actual_h: 24 },
    { tier: 'vip', promised_h: caseLifecycle.SLA_HOURS_BY_TIER.vip, actual_h: 10 },   // fast_track folded into vip
    { tier: 'urgent', promised_h: caseLifecycle.SLA_HOURS_BY_TIER.urgent, actual_h: 2 },
  ]);
  assert.equal(sqls.length, 4);
});

test('GET /analytics: nothing offered → acceptance 100; no completions → turnaround nulls', async () => {
  installStubs();
  const res = await drive('/analytics');
  assert.equal(res.statusCode, 200);
  const d = res._json.data;
  assert.equal(d.reports_issued, 0);
  assert.equal(d.acceptance_pct, 100);
  assert.equal(d.avg_turnaround_h, null);
  assert.equal(d.deadlines_missed, 0);
  assert.deepEqual(d.turnaround.map((t) => t.actual_h), [null, null, null]);
  assert.deepEqual(d.turnaround.map((t) => t.promised_h), [48, 18, 4]);
});

test('GET /analytics: helper throwing → 500 ANALYTICS_UNAVAILABLE', async () => {
  installStubs();
  const helpers = { safeGet: async () => { throw new Error('boom'); }, safeAll: async () => [] };
  const res = await drive('/analytics', { helpers });
  assert.equal(res.statusCode, 500);
  assert.equal(res._code, 'ANALYTICS_UNAVAILABLE');
});

// ─── Ownership ──────────────────────────────────────────────

test('every route refuses a request with no doctor id (400 INVALID_REQUEST) before touching a reader or the DB', async () => {
  for (const p of ['/earnings', '/earnings/lines', '/statements', '/reviews', '/analytics']) {
    installStubs();
    let touched = 0;
    const helpers = { safeGet: async () => { touched++; return null; }, safeAll: async () => { touched++; return []; } };
    const res = await drive(p, { user: {}, helpers });
    assert.equal(res.statusCode, 400, p);
    assert.equal(res._code, 'INVALID_REQUEST', p);
    assert.equal(calls.length, 0, p + ' reader untouched');
    assert.equal(touched, 0, p + ' db untouched');
  }
});

test('the router is gated by the JWT + doctor-role middleware', () => {
  const router = buildRouter({}, DEFAULT_HELPERS);
  const names = router.stack.filter((l) => !l.route).map((l) => l.name);
  assert.ok(names.length >= 2, 'two guards mounted before any route');
  const firstRoute = router.stack.findIndex((l) => l.route);
  const firstGuard = router.stack.findIndex((l) => !l.route);
  assert.ok(firstGuard < firstRoute, 'guards run before routes');
});
