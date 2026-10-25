// tests/core/api-cases-payment-status.test.js
//
// 2026-10-11 — one unpaid case, two names.
//
// GET /api/v1/cases (the list) answered paymentStatus 'unpaid' for an order
// whose payment_status is NULL; GET /api/v1/cases/:id (the detail) answered
// 'pending' for the same row. The list did its mapping in SQL
// (LOWER(COALESCE(o.payment_status, 'unpaid'))), the detail in JS
// (String(status || 'pending').toLowerCase()), and the two had simply been
// written five months apart. A blank payment_status was worse: '' from the
// list — which the app reads as "the server did not say", and badges
// "Submitted · Awaiting assignment" — and 'pending' from the detail, which it
// badges "Awaiting payment".
//
// Both endpoints now pass the stored value through ONE function,
// apiPaymentStatus, and the answer for "nothing stored" is 'unpaid': the
// column's own default (migration 002), the value E2E_CONTRACT §2 names, and
// what the staff endpoints already say.
//
// WHY 'unpaid' IS SAFE FOR INSTALLED APP BUILDS. No build of the patient app
// has ever compared paymentStatus with 'pending' or with 'unpaid'. Every
// consumer asks one of two questions — "is it exactly 'paid'?" and "did the
// server say anything at all?" (undefined / null / '') — and 'pending' and
// 'unpaid' answer both identically. So the helper has one hard rule, pinned
// below: it never returns '', null or undefined.
//
// No database: the router is built in a subprocess with src/pg stubbed (the
// submitted_at probe would otherwise go looking for one), and the two real
// handlers are driven with a fake req/res.

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

console.log('\n💳 GET /cases + GET /cases/:id — one paymentStatus\n');

const ROOT = path.join(__dirname, '..', '..');

// What is stored in orders.payment_status → what both endpoints must answer.
// `undefined` is the column missing from the row altogether.
const CASES = [
  [null, 'unpaid'],
  [undefined, 'unpaid'],
  ['', 'unpaid'],
  ['unpaid', 'unpaid'],
  ['UNPAID', 'unpaid'],
  ['paid', 'paid'],
  ['Paid', 'paid'],
  ['PAID', 'paid'],
  ['captured', 'captured'],
  ['refunded', 'refunded'],
  ['partially_refunded', 'partially_refunded'],
  ['failed', 'failed'],
  // Not a value anything writes, but if it is ever stored it is passed on, not
  // renamed: the helper fills a gap, it does not reinterpret.
  ['pending', 'pending']
];

// ── 1. Both real handlers, same stored value, same answer ──────────────────
try {
  const script = `
    const path = require('path');
    const root = ${JSON.stringify(ROOT)};
    const pg = require(path.join(root, 'src', 'pg'));
    pg.queryOne = async function () { return null; };       // submitted_at probe: "no column"
    pg.queryAll = async function () { return []; };
    pg.execute = async function () { return { rowCount: 0 }; };
    const buildCasesRouter = require(path.join(root, 'src', 'routes', 'api', 'cases'));
    const CASES = ${JSON.stringify(CASES.map(function (c) { return c[0] === undefined ? '__absent__' : c[0]; }))};

    let stored;               // the value "in the database" for this round
    let listSql = '';
    const caseRow = function () {
      return { id: 'ord-1', referenceId: 'TSH-2026-000017', status: 'submitted', paymentClaimPending: false };
    };
    const safeAll = async function (sql) {
      if (/FROM orders_active o/.test(sql)) {
        // The list projects the column itself, under the payload's name.
        listSql = sql;
        const r = caseRow();
        if (stored !== '__absent__') r.paymentStatus = stored;
        return [r];
      }
      return [];              // timeline, files
    };
    const safeGet = async function (sql) {
      if (/COUNT\\(\\*\\)/.test(sql)) return { total: 1 };
      if (/SELECT payment_status as status/.test(sql)) {
        // The detail reads it in a second query, as \`status\`.
        const p = { amount: 750, currency: 'EGP', paymentLink: null };
        if (stored !== '__absent__') p.status = stored;
        return p;
      }
      if (/FROM orders_active o/.test(sql)) return caseRow();
      return null;            // reviews
    };
    const router = buildCasesRouter({}, { safeGet: safeGet, safeAll: safeAll, safeRun: async function () { return { rowCount: 0 }; } });
    const handler = function (p) {
      const layers = router.stack.filter(function (l) { return l.route && l.route.path === p && l.route.methods.get; });
      const stack = layers[layers.length - 1].route.stack;
      return stack[stack.length - 1].handle;
    };
    const call = function (h, req) {
      return new Promise(function (resolve, reject) {
        const res = {
          ok: function (data) { resolve(data); },
          fail: function (m, s, c) { reject(new Error('handler failed: ' + c)); }
        };
        Promise.resolve(h(req, res)).catch(reject);
      });
    };
    (async function () {
      const out = [];
      for (const v of CASES) {
        stored = v;
        const list = await call(handler('/'), { user: { id: 'pat-1' }, query: {}, params: {}, headers: {} });
        const detail = await call(handler('/:id'), { user: { id: 'pat-1' }, query: {}, params: { id: 'ord-1' }, headers: {} });
        out.push({ stored: v, list: list[0].paymentStatus, detail: detail.paymentStatus,
                   listHas: 'paymentStatus' in list[0], detailHas: 'paymentStatus' in detail });
      }
      console.log('RESULT ' + JSON.stringify({ rows: out, listSql: listSql }));
      process.exit(0);
    })().catch(function (e) { console.log('RESULT ' + JSON.stringify({ error: String(e && e.stack || e) })); process.exit(0); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:1/stub' })
  });
  const line = out.split('\n').filter(function (l) { return l.indexOf('RESULT ') === 0; })[0];
  expect(line, 'subprocess produced no result:\n' + out.slice(-800));
  const res = JSON.parse(line.slice(7));
  expect(!res.error, 'subprocess threw: ' + res.error);
  eq(res.rows.length, CASES.length, 'every stored value must be driven through both handlers');

  res.rows.forEach(function (r, i) {
    const label = 'payment_status ' + (CASES[i][0] === undefined ? '(absent)' : JSON.stringify(CASES[i][0]));
    expect(r.listHas && r.detailHas, label + ': both payloads must carry paymentStatus');
    eq(r.list, r.detail, label + ': the list and the detail must say the same thing');
    eq(r.list, CASES[i][1], label + ': list');
    eq(r.detail, CASES[i][1], label + ': detail');
    // The one rule installed app builds depend on (lib/caseDisplay.ts
    // caseDisplayState reads '' / null / undefined as "the server did not say").
    expect(typeof r.list === 'string' && r.list !== '', label + ': the answer is never blank');
  });

  // The mock is only honest if the list hands the helper the STORED value.
  expect(/o\.payment_status as "paymentStatus"/.test(res.listSql),
    'the list must project the stored payment_status for the helper to map — no mapping of its own in SQL');
  expect(!/COALESCE\(o\.payment_status,\s*'(?:unpaid|pending)'\)\)?\s+as "paymentStatus"/.test(res.listSql),
    'the list must not carry a second NULL-mapping in SQL');
  t.pass('list and detail agree for ' + CASES.length + ' stored values; NULL / blank → \'unpaid\'; never blank');
} catch (e) { t.fail('list and detail give one paymentStatus', e); }

// ── 2. One helper, used by both, and nothing else emits the field ──────────
try {
  const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'routes', 'api', 'cases.js'), 'utf8'));
  eq((CODE.match(/function apiPaymentStatus\(/g) || []).length, 1, 'exactly one apiPaymentStatus definition');

  const between = function (a, b) {
    const i = CODE.indexOf(a);
    const j = CODE.indexOf(b, i + 1);
    expect(i !== -1 && j !== -1, 'could not locate ' + a + ' … ' + b);
    return CODE.slice(i, j);
  };
  const list = between("router.get('/', [", "router.get('/summary'");
  const detail = between("router.get('/:id', async", "router.post('/', [");
  expect(/\.paymentStatus = apiPaymentStatus\(/.test(list), 'GET /cases must map paymentStatus through apiPaymentStatus');
  expect(/caseData\.paymentStatus = apiPaymentStatus\(/.test(detail), 'GET /cases/:id must map paymentStatus through apiPaymentStatus');

  // Every write of the field in the file goes through the helper…
  const writes = CODE.match(/\.paymentStatus\s*=[^=][^;\n]*/g) || [];
  eq(writes.length, 2, 'paymentStatus is assigned in exactly two places (list, detail); found ' + JSON.stringify(writes));
  writes.forEach(function (w) {
    expect(/=\s*apiPaymentStatus\(/.test(w), 'paymentStatus assigned without the helper: ' + w);
  });
  // …and the only SQL projection of it is the raw column the helper is fed.
  const projections = CODE.match(/[^\n]* as "paymentStatus"/g) || [];
  eq(projections.length, 1, 'one SQL projection of paymentStatus (the list)');
  expect(/^\s*o\.payment_status as "paymentStatus"$/.test(projections[0]),
    'that projection must be the stored column, unmapped; got ' + projections[0].trim());
  // The two retired spellings of the default.
  expect(!/\|\|\s*'pending'\)\.toLowerCase\(\)/.test(detail), "the detail must not default to 'pending' itself");
  expect(!/PAYMENT_STATUS_SQL/.test(CODE), 'the SQL-side default (PAYMENT_STATUS_SQL) must be gone, not left beside the helper');
  t.pass('one helper (apiPaymentStatus), called by the list and the detail; no other mapping of the field in the file');
} catch (e) { t.fail('one helper for paymentStatus', e); }
