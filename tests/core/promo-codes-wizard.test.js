// tests/core/promo-codes-wizard.test.js
//
// SHIFA25 on the web wizard (migration 131): the real routes/patient.js router
// on a throwaway express app, src/pg faked through require.cache with one
// in-memory DRAFT order. Drives POST /patient/new-case/promo the way the Step 5
// form does — apply, apply again, remove, a wrong code, a wrong market — and
// checks the order row and the redirect the page re-renders from.
//
// No DB, no boot, no network beyond 127.0.0.1.

'use strict';

const path = require('path');
const http = require('http');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error((m || 'mismatch') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const SRC = path.join(__dirname, '..', '..', 'src');
const R = (rel) => require.resolve(path.join(SRC, rel));

module.exports = (async function run() {
  console.log('\n🎟️  Promo codes — web wizard Step 5 apply / remove\n');

  const state = { accountCountry: 'EG' };
  const codes = {
    SHIFA25: { code: 'SHIFA25', percent_off: 25, active: true, starts_at: '2026-10-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, markets: ['EG'] }
  };
  const order = {
    id: 'ord-w1', patient_id: 'pat-w1', status: 'DRAFT', payment_status: 'unpaid', draft_step: 4,
    reference_id: 'TK-W1', service_id: 'svc-echo', specialty_id: 'cardiology', urgency_tier: 'standard', sla_hours: 48,
    base_price: 750, urgency_uplift_amount: 0, price: 750, doctor_fee: 150, urgency_flag: false,
    display_price: null, display_currency: null,
    price_before_discount: null, discount_egp: null, promo_code: null, referral_discount: 0,
    paymob_intention_id: null, payment_link: null
  };
  const promoWrites = [];

  const fakePg = {
    pool: { query: async () => ({ rows: [] }), on: () => {} },
    queryOne: async function (sql, params) {
      if (/SELECT country FROM users WHERE id = \$1/.test(sql)) return { country: state.accountCountry };
      if (/FROM promo_codes WHERE UPPER\(code\) = \$1/.test(sql)) return codes[params[0]] ? Object.assign({}, codes[params[0]]) : null;
      if (/FROM orders_active o[\s\S]*WHERE o\.id = \$1 AND o\.patient_id = \$2/.test(sql)) {
        return (params[0] === order.id && params[1] === order.patient_id) ? Object.assign({}, order) : null;
      }
      if (/FROM orders\s+WHERE id = \$1 AND patient_id = \$2 AND deleted_at IS NULL/.test(sql) ||
          /FROM orders WHERE id = \$1 AND patient_id = \$2 AND deleted_at IS NULL/.test(sql)) {
        return (params[0] === order.id && params[1] === order.patient_id) ? Object.assign({}, order) : null;
      }
      return null;
    },
    queryAll: async () => [],
    execute: async function (sql, params) {
      if (/SET price_before_discount = \$1,/.test(sql)) {
        promoWrites.push(params);
        const [list, total, discount, c, id, pid] = params;
        const listNow = order.price_before_discount != null ? order.price_before_discount : order.price;
        if (id !== order.id || pid !== order.patient_id || order.status !== 'DRAFT' || listNow !== list) return { rowCount: 0 };
        Object.assign(order, { price_before_discount: list, price: total, discount_egp: discount, promo_code: c });
        return { rowCount: 1 };
      }
      if (/SET price = price_before_discount,/.test(sql)) {
        if (order.price_before_discount == null) return { rowCount: 0 };
        Object.assign(order, { price: order.price_before_discount, price_before_discount: null, discount_egp: null, promo_code: null });
        return { rowCount: 1 };
      }
      if (/SET promo_code = NULL, discount_egp = NULL/.test(sql)) return { rowCount: 0 };
      return { rowCount: 0 };
    },
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) })
  };

  const TARGETS = {
    pg: R('pg.js'),
    audit: R('audit.js'),
    promo: R('services/promo_codes.js'),
    pricing: R('services/case_intake_pricing.js'),
    patient: R('routes/patient.js')
  };
  const saved = {};
  Object.keys(TARGETS).forEach((k) => { saved[k] = require.cache[TARGETS[k]]; });
  const stub = (k, ex) => { require.cache[TARGETS[k]] = { id: TARGETS[k], filename: TARGETS[k], loaded: true, exports: ex }; };

  const audit = [];
  let server;
  try {
    stub('pg', fakePg);
    stub('audit', { logOrderEvent: async (ev) => { audit.push(ev); } });
    delete require.cache[TARGETS.promo];
    delete require.cache[TARGETS.pricing];
    delete require.cache[TARGETS.patient];
    const router = require(TARGETS.patient);

    const express = require('express');
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { req.user = { id: 'pat-w1', role: 'patient' }; req.cookies = {}; next(); });
    app.use(router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;

    function post(p, form) {
      return new Promise((resolve, reject) => {
        const data = new URLSearchParams(form).toString();
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '' }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }
    const STEP5 = '/patient/new-case?step=5&id=ord-w1';

    await check('apply "shifa25" on Step 5 → order 563 (list 750, −187), back to Step 5 with promo_ok=applied', async () => {
      const r = await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: 'shifa25' });
      eq(r.status, 302); eq(r.location, STEP5 + '&promo_ok=applied');
      eq(order.price, 563); eq(order.price_before_discount, 750); eq(order.discount_egp, 187); eq(order.promo_code, 'SHIFA25');
      eq(order.doctor_fee, 150, 'doctor fee untouched');
      expect(audit.some((e) => e.label === 'promo_code_applied' && e.orderId === 'ord-w1'), 'order event');
    });

    await check('apply again (double submit / refresh) → still 563, never 422', async () => {
      const r = await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: 'SHIFA25' });
      eq(r.location, STEP5 + '&promo_ok=applied');
      eq(order.price, 563);
      eq(promoWrites[promoWrites.length - 1][0], 750, 'recomputed from the list price');
    });

    await check('a posted amount is ignored — the form has no say in the price', async () => {
      await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: 'SHIFA25', price: '1', amount: '1', discount: '749' });
      eq(order.price, 563);
    });

    await check('remove → back to 750, promo_ok=removed', async () => {
      const r = await post('/patient/new-case/promo', { id: 'ord-w1', action: 'remove' });
      eq(r.location, STEP5 + '&promo_ok=removed');
      eq(order.price, 750); eq(order.promo_code, null); eq(order.price_before_discount, null);
    });

    await check('unknown code → promo_err=invalid with the code echoed for the field; price unchanged', async () => {
      const r = await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: 'nope' });
      eq(r.location, STEP5 + '&promo_err=invalid&promo_code=NOPE');
      eq(order.price, 750);
      const junk = await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: '"><script>' });
      eq(junk.location, STEP5 + '&promo_err=invalid', 'junk is not echoed');
    });

    await check('a GB account (priced from the GB list) → promo_err=not_eligible; price unchanged', async () => {
      state.accountCountry = 'GB';
      const r = await post('/patient/new-case/promo', { id: 'ord-w1', promo_code: 'SHIFA25' });
      state.accountCountry = 'EG';
      eq(r.location, STEP5 + '&promo_err=not_eligible&promo_code=SHIFA25');
      eq(order.price, 750);
    });

    await check("someone else's order id → dashboard, nothing written", async () => {
      const before = promoWrites.length;
      const r = await post('/patient/new-case/promo', { id: 'ord-other', promo_code: 'SHIFA25' });
      eq(r.location, '/dashboard');
      eq(promoWrites.length, before);
    });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Object.keys(TARGETS).forEach((k) => {
      if (saved[k]) require.cache[TARGETS[k]] = saved[k]; else delete require.cache[TARGETS[k]];
    });
  }
})();
