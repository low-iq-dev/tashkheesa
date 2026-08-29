// tests/admin/kpi-payload-parity.test.js
//
// AUDIT 2026-08-29 — the behavioural half of the money + predicate fixes.
//
// The lint files (tests/lint/admin-money-from-real-charge, tests/lint/
// kpi-predicates-shared) pin the SHAPE of the code. This file mounts the real
// router with captured SQL and fixture rows and asserts the NUMBERS and the
// FIELD NAMES the Command app will read.
//
// What is being proven, defect by defect:
//
//   * grandTotal is the amount ACTUALLY charged (price + selected add-ons =
//     services/order_pricing.owedCentsForOrder), not
//     COALESCE(total_price_with_addons, price) on a column nothing writes.
//   * maxRefundable is the server's OWN ceiling
//     (services/refund_eligibility.maxRefundableEgp), which is legitimately
//     SMALLER than grandTotal once a video consultation has been consumed — so
//     the app must cap on it, not on grandTotal.
//   * the GET /cases `unassigned` and `breached` FACETS filter exactly what the
//     lists they open filter (the shared active-status predicate).
//   * the Payments tiles and lists value a refund identically, and the word
//     "pending" names one set only.
//   * GET /manual-queue reports the size of the QUEUE, not the size of the page.
//
// Written in the _testRunner style (not node:test) so tests/run.js counts it.
// Hermetic: stubbed helpers, no database.

'use strict';

const path = require('path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kpi-payload-parity';
process.env.SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'ziad.wahsh@shifaegypt.com';

const jwt = require('jsonwebtoken');
const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');
const { ACTIVE_STATUS_LIST } = require('../../src/routes/api/_assign_helpers');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔢 Command payloads: real charges, one refund ceiling, facets that match their lists\n');

const SUPERADMIN = { id: 'su-1', email: process.env.SUPERADMIN_EMAIL, role: 'superadmin', name: 'Ziad' };

function pass(n) { t.pass(fileTag + ': ' + n); }
function fail(n, m) { t.fail(fileTag + ': ' + n, new Error(m)); }
function eq(name, actual, expected, extra) {
  if (actual === expected) pass(name);
  else fail(name, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + (extra ? ' — ' + extra : ''));
}
function ok(name, cond, msg) { if (cond) pass(name); else fail(name, msg); }

function makeApp(helperOverrides) {
  const helpers = Object.assign({
    safeGet: async () => null,
    safeAll: async () => [],
    safeRun: async () => ({ rowCount: 0 }),
    mustGet: async () => null,
    mustAll: async () => [],
  }, helperOverrides || {});
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const deploy = { gitSha: 'test', startedAt: Date.now(), startedAtIso: new Date().toISOString(), version: '0', mode: 'test' };
  const notifiers = {
    ensureConversation: async () => 'c',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
  const server = app.listen(0);
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

async function get(base, route) {
  const res = await fetch(base + '/api/v1/admin' + route, {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + jwt.sign(SUPERADMIN, process.env.JWT_SECRET, { expiresIn: '15m' }),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The order the whole defect is about: an EGP 1600 case fee with a 250 EGP
// prescription and a 300 EGP video consultation on it. total_price_with_addons
// is NULL, which is what EVERY production row looks like — that is why the old
// COALESCE(total_price_with_addons, price) reported 1600 on a 2150 charge.
const ADDONS = {
  video_consultation: true, video_consultation_price: 300,
  prescription: true, prescription_price: 250,
};
const ORDER_ROW = {
  id: 'ord-1', reference_id: 'TSH-1', status: 'paid', urgency_tier: 'standard',
  payment_status: 'paid', paid_at: null, payment_method: 'card',
  price: 1600, base_price: 1400, urgency_uplift_amount: 200,
  addons_json: JSON.stringify(ADDONS),
  video_consultation_selected: true, video_consultation_price: 300,
  created_at: new Date('2026-08-01T00:00:00Z'), completed_at: null, accepted_at: null,
  deadline_at: null, sla_hours: 48, doctor_id: null, specialty_id: 'sp-1', service_id: 'sv-1',
  patient_name: 'Mona', gender: 'female', date_of_birth: '1990-01-01',
  specialty: 'Cardiology', service: 'Second opinion', sla_mins: null,
};

module.exports = (async function () {
  // ── 1. GET /cases/:id — the real charge and the server's own ceiling ──────
  {
    const app = makeApp({
      mustGet: async (sql) => {
        if (/FROM orders_active o/.test(sql) && /reference_id/.test(sql)) return ORDER_ROW;
        return null; // doctor card + refund row: none
      },
      mustAll: async () => [],
    });
    try {
      const r = await get(app.base, '/cases/ord-1');
      const pay = r.body && r.body.data && r.body.data.payment;
      if (!pay) {
        fail('GET /cases/:id returns a payment block', 'status ' + r.status);
      } else {
        eq('GET /cases/:id grandTotal is price + BOTH add-ons (1600+300+250)',
          pay.grandTotal, 2150,
          'the old COALESCE(total_price_with_addons, price) reported 1600 on a 2150 charge');
        eq('GET /cases/:id price still reports the case fee alone', pay.price, 1600);
        eq('GET /cases/:id maxRefundable equals the full charge while nothing is consumed',
          pay.maxRefundable, 2150);
      }
    } finally { app.server.close(); }
  }

  // ── 2. maxRefundable is SMALLER than grandTotal on a consumed video add-on ─
  //
  // This is the whole reason the app must cap on maxRefundable and not on
  // grandTotal: refund_eligibility deliberately takes a consultation the patient
  // has already claimed OUT of the ceiling. Capping the sheet on grandTotal here
  // would offer a refund services/admin_refund.js then rejects.
  {
    const consumed = Object.assign({}, ORDER_ROW, {
      addons_json: JSON.stringify(Object.assign({}, ADDONS, { video_consultation_consumed_by: 'appt-9' })),
    });
    const app = makeApp({
      mustGet: async (sql) => (/reference_id/.test(sql) && /FROM orders_active o/.test(sql) ? consumed : null),
      mustAll: async () => [],
    });
    try {
      const r = await get(app.base, '/cases/ord-1');
      const pay = r.body && r.body.data && r.body.data.payment;
      eq('a consumed video add-on leaves grandTotal at the full charge', pay && pay.grandTotal, 2150);
      eq('…but drops maxRefundable by the consumed 300', pay && pay.maxRefundable, 1850,
        'this gap is why the refund sheet must cap on maxRefundable, not grandTotal');
    } finally { app.server.close(); }
  }

  // ── 3. GET /cases rows carry the same two figures, and the facets match ───
  {
    const captured = [];
    const app = makeApp({
      mustAll: async (sql) => {
        captured.push(sql);
        if (/sla_mins/.test(sql)) {
          return [Object.assign({}, ORDER_ROW, { doctor_name: null, patient: 'Mona' })];
        }
        return [];
      },
      mustGet: async () => ({ total: 1 }),
    });
    try {
      const r = await get(app.base, '/cases');
      const row = r.body && r.body.data && r.body.data.cases && r.body.data.cases[0];
      eq('GET /cases row grandTotal is the real charge', row && row.grandTotal, 2150);
      eq('GET /cases row exposes maxRefundable', row && row.maxRefundable, 2150);

      const facetSql = captured.find((s) => /AS unassigned/.test(s)) || '';
      const missing = ACTIVE_STATUS_LIST.filter((s) => facetSql.indexOf("'" + s + "'") === -1);
      ok('the `unassigned`/`breached` facets filter the full active-status set',
        facetSql !== '' && missing.length === 0,
        facetSql === ''
          ? 'no facet query was issued'
          : 'the facet SQL omits ' + JSON.stringify(missing) + '. A facet narrower than the list it '
            + 'opens is the badge-says-0-list-shows-2 bug this fix exists for.');
      ok('the `unassigned` facet requires an unassigned, uncompleted case',
        /doctor_id IS NULL/.test(facetSql) && /completed_at IS NULL/.test(facetSql),
        'the facet no longer matches the ?assigned=unassigned&active=1 list predicate');
      ok('the `breached` facet requires a real, elapsed deadline',
        /deadline_at IS NOT NULL/.test(facetSql) && /deadline_at::timestamptz < NOW\(\)/.test(facetSql),
        'the breached facet no longer matches the ?breached=1 list predicate');
    } finally { app.server.close(); }
  }

  // ── 4. GET /refunds — one valuation, and "pending" names one set ──────────
  {
    const captured = [];
    const REFUND = {
      id: 'ref-1', order_id: 'ord-1', amount_egp: '1250.00', requested_amount: '1250.00',
      approved_amount: '400.00', status: 'approved', reason: 'patient_request',
      instapay_handle: null, instapay_reference: null,
      refunded_at: new Date('2026-08-10T12:34:10Z'), reviewed_at: null, paid_at: null,
      patient_name: 'Mona', reference_id: 'TSH-1', service_id: 'sv-1', price: 1600, currency: 'EGP',
    };
    const app = makeApp({
      mustAll: async (sql) => { captured.push(sql); return /r\.status = 'pending'/.test(sql) ? [] : [REFUND]; },
      mustGet: async (sql) => {
        captured.push(sql);
        if (/collected_today/.test(sql)) return { collected_today: 0, collected_mtd: 0 };
        return { refunded_mtd: 400, unsettled_count: 1, unsettled_total: 400 };
      },
    });
    try {
      const r = await get(app.base, '/refunds');
      const d = r.body && r.body.data;
      const row = d && d.queue && d.queue.awaitingPayment && d.queue.awaitingPayment[0];
      eq('a partially approved refund ships settledAmount = approved_amount', row && row.settledAmount, 400,
        'without it the app has to derive `approvedAmount ?? amountEgp` itself — the second copy this fix removes');
      eq('…while amountEgp still records what the patient asked for', row && row.amountEgp, 1250);

      const owed = d && d.kpis && d.kpis.refundsOwed;
      eq('refundsOwed.unsettledCount is the canonical name', owed && owed.unsettledCount, 1);
      eq('refundsOwed.unsettledTotal is the canonical name', owed && owed.unsettledTotal, 400);
      eq('refundsOwed.count is kept as a backwards-compatible alias', owed && owed.count, 1);
      eq('refundsOwed.total is kept as a backwards-compatible alias', owed && owed.total, 400);
      ok('refundsOwed.statuses ships the set the tile counts',
        owed && Array.isArray(owed.statuses) && owed.statuses.join(',') === 'pending,approved,auto_approved',
        'the app would otherwise keep its own copy of which statuses "owed" means');
      eq('counts.pendingRefundRequests names the status-pending set unambiguously',
        d && d.counts && d.counts.pendingRefundRequests, 0);
      eq('counts.pending is kept for the shipped app', d && d.counts && d.counts.pending, 0);

      const tile = captured.find((s) => /refunded_mtd/.test(s)) || '';
      ok('the refund tiles sum COALESCE(approved_amount, amount_egp)',
        /COALESCE\(r\.approved_amount, r\.amount_egp\)/.test(tile),
        'the tile still sums amount_egp — a 1250 request approved at 400 reads as 1250 over a 400 list');
      ok('the refundedMTD tile buckets on the Cairo month',
        /AT TIME ZONE 'UTC' AT TIME ZONE 'Africa\/Cairo'/.test(tile) && /date_trunc\('month'/.test(tile),
        'refunded_at holds UTC digits in a naive column; it needs the two-step conversion');
      const mtdList = captured.find((s) => /'paid','approved','auto_approved'/.test(s) && /ORDER BY r\.refunded_at DESC/.test(s)) || '';
      ok('the refundedMtd LIST buckets on the same Cairo month as its tile',
        /AT TIME ZONE 'UTC' AT TIME ZONE 'Africa\/Cairo'/.test(mtdList),
        'the list and the tile would disagree for the first two hours of every Cairo month');
    } finally { app.server.close(); }
  }

  // ── 5. GET /manual-queue — the size of the QUEUE, not the size of the page ─
  {
    const app = makeApp({
      mustAll: async () => ([
        Object.assign({}, ORDER_ROW, { patient_name: 'Mona', waiting_mins: 90 }),
      ]),
      mustGet: async (sql) => (/AS paid/.test(sql) ? { paid: 300 } : { total: 431 }),
    });
    try {
      const r = await get(app.base, '/manual-queue');
      const c = r.body && r.body.data && r.body.data.counts;
      eq('counts.total is the COUNT(*) over the whole queue, not the page length', c && c.total, 431,
        'the row query is LIMIT 200, so cases.length caps the reported total at 200 forever');
      eq('counts.paid is counted in SQL too', c && c.paid, 300);
      eq('counts.unpaid is derived from the real totals', c && c.unpaid, 131);
      eq('counts.returned reports the size of THIS page', c && c.returned, 1);
      eq('a queued row prices the add-ons in',
        r.body.data.cases[0] && r.body.data.cases[0].grandTotal, 2150);
    } finally { app.server.close(); }
  }

  // ── 6. Doctor load / SLA come from the shared expressions ─────────────────
  {
    const captured = [];
    const app = makeApp({
      mustAll: async (sql) => { captured.push(sql); return []; },
      mustGet: async () => null,
    });
    try {
      await get(app.base, '/doctors');
      const sql = captured.find((s) => /AS load/.test(s)) || '';
      ok('the doctors roster counts load with an INCLUSION list, not an exclusion list',
        sql !== '' && !/NOT IN \('completed'/.test(sql) && ACTIVE_STATUS_LIST.every((s) => sql.indexOf("'" + s + "'") !== -1),
        "load is still computed by excluding statuses — an abandoned 'draft' cart then occupies a slot in a doctor's capacity");
      ok('the SLA denominator excludes refund closures',
        /IN \('completed'\)/.test(sql),
        'services/refund_closure.js stamps completed_at on a REFUNDED order; a bare completed_at '
        + 'denominator counts every refund against the doctor as a missed deadline');
      ok('the SLA numerator and denominator share one predicate',
        (sql.split('completed_at IS NOT NULL AND o.deadline_at IS NOT NULL').length - 1) >= 2,
        'the numerator no longer restates the denominator, so the two can drift apart again');
    } finally { app.server.close(); }
  }
})();
