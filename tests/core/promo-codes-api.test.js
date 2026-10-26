// tests/core/promo-codes-api.test.js
//
// SHIFA25 in the app API (migration 131): GET /cases/draft/:id/quote?promo=
// and POST /cases/draft/:id/submit { promoCode }. The real router is mounted on
// a throwaway express app with src/pg and the intake pricer faked through
// require.cache — no DB, no boot, no network beyond 127.0.0.1.
//
// Contract (E2E_CONTRACT conventions — additive fields, typed errors):
//   quote  → amount is the DISCOUNTED EGP figure, plus promoCode, discountEgp,
//            amountBeforeDiscount (all null without ?promo=)
//   submit → orders.price is the discounted figure, promo_code /
//            price_before_discount / discount_egp are written, doctor_fee is
//            the LIST-base fee, and nothing the client posts as an amount is
//            read. A code that does not apply is 422 PROMO_INVALID /
//            PROMO_EXPIRED / PROMO_NOT_ELIGIBLE and nothing is written.

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
  console.log('\n🎟️  Promo codes — app API quote / submit\n');

  const state = {
    country: 'EG',
    codes: {
      SHIFA25: { code: 'SHIFA25', percent_off: 25, active: true, starts_at: '2026-10-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, markets: ['EG'] },
      OLD10: { code: 'OLD10', percent_off: 10, active: true, starts_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z', max_uses: null, uses: 0, markets: null }
    },
    updates: [],
    lastPrice: null
  };
  const draft = {
    id: 'ord-1', patient_id: 'pat-1', status: 'DRAFT', payment_status: 'unpaid', draft_step: 3, language: 'en',
    clinical_question: 'Second opinion on my echo please', medical_history: '', current_medications: '',
    specialty_id: 'cardiology', service_id: 'svc-echo', urgency_tier: 'standard', country: 'EG',
    created_at: '2026-10-26T08:00:00Z', updated_at: '2026-10-26T08:00:00Z'
  };

  const fakePg = {
    pool: { query: async () => ({ rows: [] }) },
    queryOne: async function (sql, params) {
      if (/FROM promo_codes WHERE UPPER\(code\) = \$1/.test(sql)) return state.codes[params[0]] || null;
      if (/FROM orders_active\s+WHERE id = \$1 AND patient_id = \$2\s+AND UPPER\(COALESCE\(status, ''\)\) = 'DRAFT'/.test(sql)) {
        return (params[0] === draft.id && params[1] === draft.patient_id) ? Object.assign({}, draft) : null;
      }
      if (/FROM specialty_classifications/.test(sql)) return null;
      if (/FROM orders_active o\s+LEFT JOIN services s/.test(sql)) {
        return { id: draft.id, reference_id: 'TK-0001', status: 'submitted', price: state.lastPrice, display_price: null,
          currency: 'EGP', display_currency: null, sla_hours: 48, deadline_at: null, sla_deadline: null,
          created_at: draft.created_at, serviceName: 'Echocardiogram Review', specialtyName: 'Cardiology' };
      }
      return null;
    },
    queryAll: async function (sql) {
      if (/FROM order_files WHERE order_id = \$1/.test(sql)) return [{ id: 'f1', filename: 'echo.pdf', mime_type: 'application/pdf', url: 'k', ai_quality_status: 'ok' }];
      return [];
    },
    execute: async function (sql, params) {
      if (/UPDATE orders\s+SET reference_id = COALESCE\(reference_id, \$1\)/.test(sql)) {
        state.updates.push({ sql, params });
        state.lastPrice = params[5];
        return { rowCount: 1 };
      }
      return { rowCount: 1 };
    },
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) })
  };

  const TARGETS = {
    pg: R('pg.js'),
    pricing: R('services/case_intake_pricing.js'),
    submittedAt: R('services/orders_submitted_at.js'),
    reference: R('utils/reference.js'),
    imageQuality: R('services/case_image_quality.js'),
    analytics: R('services/analytics.js'),
    logger: R('logger.js'),
    audit: R('audit.js'),
    promo: R('services/promo_codes.js'),
    router: R('routes/api/cases_draft.js')
  };
  const saved = {};
  Object.keys(TARGETS).forEach((k) => { saved[k] = require.cache[TARGETS[k]]; });
  function stub(key, exportsObj) {
    require.cache[TARGETS[key]] = { id: TARGETS[key], filename: TARGETS[key], loaded: true, exports: exportsObj };
  }

  const events = [];
  let server;
  try {
    stub('pg', fakePg);
    // The real pricer module (for IntakeError — failFromError checks
    // instanceof), loaded against the fake pg, with only the pricing call faked.
    delete require.cache[TARGETS.pricing];
    const realPricing = require(TARGETS.pricing);
    stub('pricing', Object.assign({}, realPricing, {
      resolveAndPriceIntake: async function () {
        return {
          service: { id: 'svc-echo', name: 'Echocardiogram Review', name_ar: 'مراجعة إيكو' },
          resolvedSpecialtyId: 'cardiology',
          displayCountry: state.country,
          pricingMarket: state.country,
          charge: { egpBase: 750, doctorFeeEgp: 150, displayPrice: null, displayCurrency: null, isIntl: false },
          pricing: { basePrice: 750, upliftAmount: 0, totalPrice: 750 },
          slaHours: 48, urgencyFlag: false, urgencyTier: 'standard'
        };
      }
    }));
    stub('submittedAt', { hasSubmittedAtColumn: async () => false, submittedAtSetClause: () => '' });
    stub('reference', { generateReferenceId: async () => 'TK-0001', SEQUENCE_NAME: 'x' });
    stub('imageQuality', { scheduleImageQualityChecks: () => {} });
    stub('analytics', { captureFunnel: () => {} });
    stub('logger', { logErrorToDb: (e) => { events.push({ error: e && e.message }); } });
    stub('audit', { logOrderEvent: async (ev) => { events.push(ev); } });
    delete require.cache[TARGETS.promo];
    delete require.cache[TARGETS.router];
    const router = require(TARGETS.router);

    const express = require('express');
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 'pat-1', role: 'patient' };
      res.ok = (data) => res.json({ success: true, data });
      res.fail = (error, status, code) => res.status(status || 400).json({ success: false, error, code });
      next();
    });
    app.use('/api/v1/cases/draft', router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;

    function call(method, p, body) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port, path: p, method,
          headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch (e) { reject(new Error('non-JSON ' + res.statusCode + ': ' + buf.slice(0, 200))); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      });
    }

    await check('quote without ?promo=: list amount, promo fields present and null (additive)', async () => {
      const r = await call('GET', '/api/v1/cases/draft/ord-1/quote');
      eq(r.status, 200); eq(r.body.success, true);
      eq(r.body.data.amount, 750); eq(r.body.data.currency, 'EGP');
      expect('promoCode' in r.body.data && r.body.data.promoCode === null, 'promoCode null');
      expect(r.body.data.discountEgp === null && r.body.data.amountBeforeDiscount === null, 'nulls');
    });

    await check('quote ?promo=shifa25 (EG): amount 563, promoCode SHIFA25, discountEgp 187, amountBeforeDiscount 750', async () => {
      const r = await call('GET', '/api/v1/cases/draft/ord-1/quote?promo=shifa25');
      eq(r.status, 200);
      eq(r.body.data.amount, 563); eq(r.body.data.promoCode, 'SHIFA25');
      eq(r.body.data.discountEgp, 187); eq(r.body.data.amountBeforeDiscount, 750);
    });

    await check('quote errors: unknown → 422 PROMO_INVALID; expired → PROMO_EXPIRED; GB account → PROMO_NOT_ELIGIBLE', async () => {
      const a = await call('GET', '/api/v1/cases/draft/ord-1/quote?promo=NOPE');
      eq(a.status, 422); eq(a.body.success, false); eq(a.body.code, 'PROMO_INVALID');
      expect(typeof a.body.error === 'string' && a.body.error.length > 5, 'error message');
      const b = await call('GET', '/api/v1/cases/draft/ord-1/quote?promo=OLD10');
      eq(b.status, 422); eq(b.body.code, 'PROMO_EXPIRED');
      state.country = 'GB';
      const c = await call('GET', '/api/v1/cases/draft/ord-1/quote?promo=SHIFA25');
      state.country = 'EG';
      eq(c.status, 422); eq(c.body.code, 'PROMO_NOT_ELIGIBLE');
    });

    await check('submit { promoCode }: price 563, list 750, discount 187, doctor_fee 150 (list base), fields in the response', async () => {
      state.updates.length = 0; events.length = 0;
      const r = await call('POST', '/api/v1/cases/draft/ord-1/submit', { promoCode: 'SHIFA25' });
      eq(r.status, 200, JSON.stringify(r.body));
      eq(state.updates.length, 1);
      const p = state.updates[0].params;
      eq(p[5], 563, 'orders.price ($6)');
      eq(p[7], 150, 'orders.doctor_fee ($8) is the list-base fee');
      eq(p[4], 750, 'orders.base_price ($5) untouched by the promo');
      eq(p[16], 'SHIFA25', 'promo_code ($17)'); eq(p[17], 750, 'price_before_discount ($18)'); eq(p[18], 187, 'discount_egp ($19)');
      eq(r.body.data.price, 563); eq(r.body.data.promoCode, 'SHIFA25');
      eq(r.body.data.discountEgp, 187); eq(r.body.data.amountBeforeDiscount, 750);
      expect(events.some((e) => e && e.label === 'promo_code_applied'), 'audit event');
    });

    await check('submit ignores any amount the client posts — the discount cannot be bypassed', async () => {
      state.updates.length = 0;
      const r = await call('POST', '/api/v1/cases/draft/ord-1/submit', { promoCode: 'SHIFA25', price: 1, amount: 1, discountEgp: 749, chargedTotalEgp: 1 });
      eq(r.status, 200);
      eq(state.updates[0].params[5], 563, 'still 563');
    });

    await check('submit without a code: list price, promo columns NULL (a resubmitted draft keeps no stale discount)', async () => {
      state.updates.length = 0;
      const r = await call('POST', '/api/v1/cases/draft/ord-1/submit', {});
      eq(r.status, 200);
      const p = state.updates[0].params;
      eq(p[5], 750); eq(p[16], null); eq(p[17], null); eq(p[18], null);
      eq(r.body.data.promoCode, null);
    });

    await check('submit with a code that does not apply: 422, nothing written', async () => {
      state.updates.length = 0;
      const r = await call('POST', '/api/v1/cases/draft/ord-1/submit', { promoCode: 'OLD10' });
      eq(r.status, 422); eq(r.body.code, 'PROMO_EXPIRED');
      eq(state.updates.length, 0, 'no transition');
    });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Object.keys(TARGETS).forEach((k) => {
      if (saved[k]) require.cache[TARGETS[k]] = saved[k]; else delete require.cache[TARGETS[k]];
    });
  }
})();
