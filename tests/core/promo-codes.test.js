// tests/core/promo-codes.test.js
//
// SHIFA25 (26 Oct 2026, migration 131) — the hospital OPD poster and leaflets
// advertise 25% off. services/promo_codes.js is the one module that validates,
// applies and redeems a code. No DB, no boot: the service takes injected
// queryOne/execute, the wizard state is an in-memory fake `orders` row, the
// redeem runs against a fake transaction client, and Step 5 is rendered with
// EJS for real.
//
// What each block holds, and how it would fail quietly if it regressed:
//   A. rounding — 750 → 563 / 187. Drift here is a Kashier amount mismatch.
//   B. validation — inactive / not started / expired / exhausted / wrong market.
//   C. the wizard flow on a fake row — apply, apply again (no stacking),
//      lower-case, wrong market, remove, a Step-4 re-price that re-applies,
//      referral refusal, a non-draft refusal. The amount is never posted.
//   D. redeem only on paid — once, idempotent, never aborts the payment txn.
//   E. Step 5 render — struck-through list price, discount line, new total,
//      inline error copy in both languages, ?promo pre-fill.
//   F. wiring — markCasePaid redeems inside its txn; persistTierPricing
//      re-applies; the web route reads no amount from the body.
//   G. doctor payout — the doctor's fee is the list-price fee; a promo cannot
//      shrink it; the breach refund never returns more than was paid.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

function expect(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function code(src) {
  return src.split('\n').filter(function (l) {
    const s = l.trim();
    return !(s.startsWith('//') || s.startsWith('--') || s.startsWith('*') || s.startsWith('/*'));
  }).join('\n');
}
function between(src, a, b) {
  const i = src.indexOf(a);
  expect(i !== -1, 'could not find ' + JSON.stringify(a));
  const j = b ? src.indexOf(b, i + a.length) : -1;
  return j === -1 ? src.slice(i) : src.slice(i, j);
}

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

const promo = require('../../src/services/promo_codes');

// ── A fake store: promo_codes + one orders row ──────────────────────────────
function makeStore() {
  const codes = {
    SHIFA25: { code: 'SHIFA25', percent_off: 25, active: true, starts_at: '2026-10-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, markets: ['EG'] },
    OLD10: { code: 'OLD10', percent_off: 10, active: true, starts_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z', max_uses: null, uses: 0, markets: null },
    OFF10: { code: 'OFF10', percent_off: 10, active: false, starts_at: '2026-01-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, markets: null },
    FULL5: { code: 'FULL5', percent_off: 5, active: true, starts_at: '2026-01-01T00:00:00Z', expires_at: null, max_uses: 3, uses: 3, markets: null },
    ANY10: { code: 'ANY10', percent_off: 10, active: true, starts_at: '2026-01-01T00:00:00Z', expires_at: null, max_uses: null, uses: 0, markets: null }
  };
  const order = {
    id: 'ord-1', patient_id: 'pat-1', status: 'DRAFT', payment_status: 'unpaid',
    price: 750, base_price: 750, urgency_uplift_amount: 0, doctor_fee: 150,
    price_before_discount: null, discount_egp: null, promo_code: null, referral_discount: 0,
    paymob_intention_id: 'int-old', payment_link: 'https://pay/old'
  };
  const writes = [];
  const queryOneFn = async function (sql, params) {
    if (/FROM promo_codes WHERE UPPER\(code\) = \$1/.test(sql)) return codes[params[0]] ? Object.assign({}, codes[params[0]]) : null;
    if (/FROM orders\s+WHERE id = \$1 AND patient_id = \$2/.test(sql)) {
      return (params[0] === order.id && params[1] === order.patient_id) ? Object.assign({}, order) : null;
    }
    if (/FROM orders WHERE id = \$1 AND patient_id = \$2/.test(sql)) {
      return (params[0] === order.id && params[1] === order.patient_id) ? Object.assign({}, order) : null;
    }
    throw new Error('unexpected queryOne: ' + sql);
  };
  const executeFn = async function (sql, params) {
    writes.push({ sql, params });
    const draftOk = String(order.status).toUpperCase() === 'DRAFT' && order.payment_status !== 'paid';
    const mine = params[params.length - 1] === order.patient_id || params[1] === order.patient_id;
    if (/SET price_before_discount = \$1,/.test(sql)) {
      const [list, total, discount, c, id, pid] = params;
      const listNow = order.price_before_discount != null ? order.price_before_discount : order.price;
      if (id !== order.id || pid !== order.patient_id || !draftOk || Number(order.referral_discount) !== 0 || listNow !== list) return { rowCount: 0 };
      Object.assign(order, { price_before_discount: list, price: total, discount_egp: discount, promo_code: c, paymob_intention_id: null, payment_link: null });
      return { rowCount: 1 };
    }
    if (/SET price = price_before_discount,/.test(sql)) {
      if (!mine || !draftOk || order.price_before_discount == null) return { rowCount: 0 };
      Object.assign(order, { price: order.price_before_discount, price_before_discount: null, discount_egp: null, promo_code: null, paymob_intention_id: null, payment_link: null });
      return { rowCount: 1 };
    }
    if (/SET promo_code = NULL, discount_egp = NULL/.test(sql)) {
      if (!mine || !draftOk || !order.promo_code || order.price_before_discount != null) return { rowCount: 0 };
      Object.assign(order, { promo_code: null, discount_egp: null });
      return { rowCount: 1 };
    }
    throw new Error('unexpected execute: ' + sql);
  };
  // What persistTierPricing's UPDATE does to the promo columns: a fresh list
  // price, the old discount figures cleared, the code kept.
  function reprice(listPrice) {
    Object.assign(order, { price: listPrice, price_before_discount: null, discount_egp: null });
  }
  return { codes, order, writes, queryOneFn, executeFn, reprice };
}

(async function run() {
  console.log('\n🎟️  Promo codes — SHIFA25 (migration 131)\n');

  // ── A. Rounding ───────────────────────────────────────────────────────────
  await check('A. applyToEgp rounds to whole EGP, half up: 750 @25% → 563 (discount 187)', () => {
    const r = promo.applyToEgp(750, 25);
    eq(r.total, 563, 'total'); eq(r.discount, 187, 'discount');
    eq(promo.applyToEgp(1600, 25).total, 1200, '1600');
    eq(promo.applyToEgp(975, 25).total, 731, 'VIP 975');      // 731.25
    eq(promo.applyToEgp(1200, 25).total, 900, 'urgent 1200');
    eq(promo.applyToEgp(2402.5, 25).total, 1802, 'fractional list');  // 1801.875
    for (const amt of [750, 975, 1999, 2402.5, 16486]) {
      const x = promo.applyToEgp(amt, 25);
      expect(Math.abs(x.total + x.discount - amt) < 1e-9, 'total + discount must equal the list amount for ' + amt);
      expect(Number.isInteger(x.total), 'total must be whole EGP');
    }
    // Out-of-range percentages never discount.
    eq(promo.applyToEgp(750, 0).total, 750); eq(promo.applyToEgp(750, 100).total, 750); eq(promo.applyToEgp(750, 'x').total, 750);
  });

  await check('A. normaliseCode: case/space-insensitive, refuses junk', () => {
    eq(promo.normaliseCode(' shifa25 '), 'SHIFA25');
    eq(promo.normaliseCode('Shifa 25'), 'SHIFA25');
    eq(promo.normaliseCode('<script>'), null);
    eq(promo.normaliseCode(''), null);
    eq(promo.normaliseCode(null), null);
    eq(promo.normaliseCode('A'.repeat(40)), null);
  });

  // ── B. Validation ─────────────────────────────────────────────────────────
  await check('B. validate: SHIFA25 is valid for the EG market and nowhere else', async () => {
    const s = makeStore();
    const ok = await promo.validate('shifa25', { pricingMarket: 'EG', queryOneFn: s.queryOneFn });
    expect(ok.ok && ok.code === 'SHIFA25' && ok.percentOff === 25, JSON.stringify(ok));
    for (const m of ['US', 'GB', 'AE', 'SA', '', null]) {
      const r = await promo.validate('SHIFA25', { pricingMarket: m, queryOneFn: s.queryOneFn });
      expect(!r.ok && r.reason === 'not_eligible', m + ' → ' + JSON.stringify(r));
      eq(promo.errorCodeFor(r.reason), 'PROMO_NOT_ELIGIBLE');
    }
    // markets NULL = every market
    const any = await promo.validate('ANY10', { pricingMarket: 'GB', queryOneFn: s.queryOneFn });
    expect(any.ok, 'NULL markets must mean all markets');
  });

  await check('B. validate: unknown → PROMO_INVALID; inactive / expired / exhausted / not started → PROMO_EXPIRED', async () => {
    const s = makeStore();
    const now = new Date('2026-10-26T12:00:00Z');
    const r1 = await promo.validate('NOPE', { pricingMarket: 'EG', queryOneFn: s.queryOneFn, now });
    eq(r1.reason, 'invalid'); eq(promo.errorCodeFor(r1.reason), 'PROMO_INVALID');
    eq((await promo.validate('OFF10', { pricingMarket: 'EG', queryOneFn: s.queryOneFn, now })).reason, 'inactive');
    eq((await promo.validate('OLD10', { pricingMarket: 'EG', queryOneFn: s.queryOneFn, now })).reason, 'expired');
    eq((await promo.validate('FULL5', { pricingMarket: 'EG', queryOneFn: s.queryOneFn, now })).reason, 'exhausted');
    s.codes.SHIFA25.starts_at = '2026-11-01T00:00:00Z';
    eq((await promo.validate('SHIFA25', { pricingMarket: 'EG', queryOneFn: s.queryOneFn, now })).reason, 'not_started');
    for (const r of ['inactive', 'expired', 'exhausted', 'not_started']) eq(promo.errorCodeFor(r), 'PROMO_EXPIRED', r);
    // a junk code never reaches the database
    let hit = false;
    const r2 = await promo.validate('<x>', { queryOneFn: async () => { hit = true; return null; } });
    expect(r2.reason === 'invalid' && !hit, 'junk must be refused before any query');
  });

  await check('B. bilingual inline messages exist for every reason', () => {
    for (const r of Object.keys(promo.REASON_CODES)) {
      const en = promo.messageFor(r, 'en'); const ar = promo.messageFor(r, 'ar');
      expect(en && /[a-z]/i.test(en), 'en ' + r);
      expect(ar && /[؀-ۿ]/.test(ar), 'ar ' + r);
    }
  });

  // ── C. Wizard flow on a fake row ──────────────────────────────────────────
  await check('C. apply SHIFA25 to a 750 EGP EG draft → price 563, list 750, discount 187, stale pay link nulled', async () => {
    const s = makeStore();
    const r = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'shifa25', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn });
    expect(r.ok, JSON.stringify(r));
    eq(s.order.price, 563, 'price'); eq(s.order.price_before_discount, 750, 'list'); eq(s.order.discount_egp, 187, 'discount');
    eq(s.order.promo_code, 'SHIFA25'); eq(s.order.payment_link, null, 'link'); eq(s.order.paymob_intention_id, null, 'intention');
    // money columns the doctor is paid from are untouched
    eq(s.order.doctor_fee, 150); eq(s.order.base_price, 750); eq(s.order.urgency_uplift_amount, 0);
    const sum = promo.summaryFor(s.order);
    expect(sum.code === 'SHIFA25' && sum.priceBeforeDiscount === 750 && sum.discountEgp === 187 && sum.price === 563, JSON.stringify(sum));
  });

  await check('C. applying twice (or a different code) never stacks — always from the list price', async () => {
    const s = makeStore();
    const args = { orderId: 'ord-1', patientId: 'pat-1', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn };
    await promo.applyToOrder(Object.assign({ code: 'SHIFA25' }, args));
    await promo.applyToOrder(Object.assign({ code: 'SHIFA25' }, args));
    await promo.applyToOrder(Object.assign({ code: ' Shifa25' }, args));
    eq(s.order.price, 563, 'still 563 after three applies');
    await promo.applyToOrder(Object.assign({ code: 'ANY10' }, args));
    eq(s.order.price, 675, 'a different code replaces: 750 @10% = 675, not 563 @10%');
    eq(s.order.price_before_discount, 750); eq(s.order.promo_code, 'ANY10');
  });

  await check('C. wrong market / expired → refused, price unchanged', async () => {
    const s = makeStore();
    const r = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'SHIFA25', pricingMarket: 'US', queryOneFn: s.queryOneFn, executeFn: s.executeFn });
    expect(!r.ok && r.reason === 'not_eligible', JSON.stringify(r));
    const r2 = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'OLD10', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn });
    expect(!r2.ok && r2.reason === 'expired', JSON.stringify(r2));
    eq(s.order.price, 750); eq(s.order.promo_code, null); eq(s.writes.length, 0, 'no write on a refused code');
  });

  await check('C. remove → back to the list price; removing again is a no-op', async () => {
    const s = makeStore();
    const args = { orderId: 'ord-1', patientId: 'pat-1', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn };
    await promo.applyToOrder(Object.assign({ code: 'SHIFA25' }, args));
    await promo.removeFromOrder(args);
    eq(s.order.price, 750); eq(s.order.price_before_discount, null); eq(s.order.discount_egp, null); eq(s.order.promo_code, null);
    await promo.removeFromOrder(args);
    eq(s.order.price, 750);
  });

  await check('C. Step 4 re-price (standard → VIP 975) keeps the code and re-applies it: 731', async () => {
    const s = makeStore();
    const args = { orderId: 'ord-1', patientId: 'pat-1', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn };
    await promo.applyToOrder(Object.assign({ code: 'SHIFA25' }, args));
    s.reprice(975);
    const r = await promo.reapplyToOrder(args);
    expect(r.ok, JSON.stringify(r));
    eq(s.order.price, 731); eq(s.order.price_before_discount, 975); eq(s.order.discount_egp, 244);
    // and a code that died in between is dropped, never honoured at a stale amount
    s.codes.SHIFA25.active = false;
    s.reprice(750);
    const r2 = await promo.reapplyToOrder(args);
    expect(!r2.ok, 'a deactivated code must not be re-applied');
    eq(s.order.price, 750); eq(s.order.promo_code, null);
  });

  await check('C. no stacking with a referral discount; nothing on a submitted / paid order', async () => {
    const s = makeStore();
    s.order.referral_discount = 75;
    const r = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'SHIFA25', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn });
    expect(!r.ok && r.reason === 'combined', JSON.stringify(r));
    eq(promo.errorCodeFor('combined'), 'PROMO_NOT_ELIGIBLE');
    const s2 = makeStore();
    s2.order.status = 'submitted';
    const r2 = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'SHIFA25', pricingMarket: 'EG', queryOneFn: s2.queryOneFn, executeFn: s2.executeFn });
    expect(!r2.ok && r2.reason === 'not_payable', JSON.stringify(r2));
    const s3 = makeStore();
    const r3 = await promo.applyToOrder({ orderId: 'ord-1', patientId: 'someone-else', code: 'SHIFA25', pricingMarket: 'EG', queryOneFn: s3.queryOneFn, executeFn: s3.executeFn });
    expect(!r3.ok && s3.order.price === 750, 'another patient cannot discount this order');
  });

  // ── D. Redeem only on paid ────────────────────────────────────────────────
  function fakeClient(state) {
    const log = [];
    return {
      log,
      query: async function (sql, params) {
        log.push(sql.replace(/\s+/g, ' ').trim());
        if (state.fail && /UPDATE promo_codes/.test(sql)) throw new Error('relation "promo_codes" does not exist');
        if (/UPDATE orders SET promo_redeemed_at = NOW\(\)/.test(sql)) {
          if (state.order.promo_code && !state.order.promo_redeemed_at) {
            state.order.promo_redeemed_at = 'now';
            return { rows: [{ promo_code: state.order.promo_code }] };
          }
          return { rows: [] };
        }
        if (/UPDATE promo_codes SET uses = uses \+ 1/.test(sql)) { state.uses += 1; return { rows: [] }; }
        return { rows: [] };
      }
    };
  }

  await check('D. redeemForPaidOrder counts the use once — a re-delivered webhook does not count twice', async () => {
    const state = { order: { promo_code: 'SHIFA25', promo_redeemed_at: null }, uses: 0 };
    const c = fakeClient(state);
    const r1 = await promo.redeemForPaidOrder(c, 'ord-1');
    const r2 = await promo.redeemForPaidOrder(c, 'ord-1');
    expect(r1.redeemed && r1.code === 'SHIFA25', JSON.stringify(r1));
    expect(!r2.redeemed, 'second call must not redeem');
    eq(state.uses, 1, 'uses');
    expect(c.log[0] === 'SAVEPOINT promo_redeem', 'runs inside a SAVEPOINT');
  });

  await check('D. no code → nothing counted; a failure rolls back to the savepoint and never throws', async () => {
    const st = { order: { promo_code: null, promo_redeemed_at: null }, uses: 0 };
    const r = await promo.redeemForPaidOrder(fakeClient(st), 'ord-1');
    expect(!r.redeemed && st.uses === 0, JSON.stringify(r));
    const bad = { order: { promo_code: 'SHIFA25', promo_redeemed_at: null }, uses: 0, fail: true };
    const c = fakeClient(bad);
    const origErr = console.error; console.error = function () {};
    let r2;
    try { r2 = await promo.redeemForPaidOrder(c, 'ord-1'); } finally { console.error = origErr; }
    expect(!r2.redeemed, 'failed redeem reports not redeemed');
    expect(c.log.indexOf('ROLLBACK TO SAVEPOINT promo_redeem') !== -1, 'must roll back to the savepoint, not abort the payment txn');
  });

  await check('D. applying a code never counts a use (abandoned drafts do not burn uses)', async () => {
    const s = makeStore();
    await promo.applyToOrder({ orderId: 'ord-1', patientId: 'pat-1', code: 'SHIFA25', pricingMarket: 'EG', queryOneFn: s.queryOneFn, executeFn: s.executeFn });
    expect(!s.writes.some((w) => /promo_codes/.test(w.sql)), 'apply must not touch promo_codes.uses');
    eq(s.codes.SHIFA25.uses, 0);
  });

  // ── E. Step 5 render ──────────────────────────────────────────────────────
  const ejs = require('ejs');
  const VIEW = path.join(ROOT, 'src', 'views', 'patient_new_case.ejs');
  const baseLocals = function (lang, promoLocal, draftOver) {
    return {
      step: 5, lang, isAr: lang === 'ar',
      draft: Object.assign({ id: 'ord-1', urgency_tier: 'standard', base_price: 750, urgency_uplift_amount: 0, price: 563, sla_hours: 48, status: 'DRAFT' }, draftOver || {}),
      user: { id: 'pat-1', role: 'patient', name: 'P' }, files: [], specialties: [], services: [], pricing: null,
      promo: promoLocal,
      tt: function (k, en, ar) { return lang === 'ar' ? ar : en; },
      csrfField: function () { return '<input type="hidden" name="_csrf" value="x">'; },
      cspNonce: 'n', thresholds: {}, step3Defaults: function () { return {}; }
    };
  };
  const render = (locals) => new Promise((resolve, reject) => ejs.renderFile(VIEW, locals, {}, (e, h) => e ? reject(e) : resolve(h)));

  await check('E. applied: list price struck through, discount line, new total, remove button', async () => {
    const html = await render(baseLocals('en', { applied: { code: 'SHIFA25', priceBeforeDiscount: 750, discountEgp: 187, price: 563 }, prefill: '', error: null, flash: 'applied' }));
    expect(/data-promo-original[^>]*>\s*<s>EGP 750<\/s>/.test(html), 'struck-through list price');
    expect(/EGP 563/.test(html), 'new total');
    expect(/SHIFA25<\/span>[\s\S]{0,200}−EGP 187/.test(html), 'discount line');
    expect(/name="action" value="remove"/.test(html), 'remove form');
    const box = between(html, 'data-promo-box', 'action="/patient/new-case/step5"');
    expect(!/name="(price|amount|total|discount)/.test(box), 'the promo forms must never carry an amount');
  });

  await check('E. invalid / wrong-market codes: inline error, field pre-filled, both languages', async () => {
    const en = await render(baseLocals('en', { applied: null, prefill: 'SHIFA25', error: promo.messageFor('not_eligible', 'en'), flash: null }, { price: 750 }));
    expect(/<details open>/.test(en), 'the box opens itself');
    expect(/id="promo_err" role="alert"[^>]*>That code isn’t valid for prices in your country\./.test(en), 'en error');
    expect(/name="promo_code"[\s\S]{0,300}value="SHIFA25"/.test(en), 'prefill');
    expect(!/data-promo-original/.test(en), 'no strike-through without a code');
    const ar = await render(baseLocals('ar', { applied: null, prefill: '', error: promo.messageFor('expired', 'ar'), flash: null }, { price: 750 }));
    expect(/معاك كود خصم؟/.test(ar) && /الكود ده انتهت صلاحيته\./.test(ar), 'ar copy');
  });

  await check('E. no promo local at all (other renders) — Step 5 renders exactly as before', async () => {
    const html = await render(Object.assign(baseLocals('en', null, { price: 750 })));
    expect(/Have a code\?/.test(html) && !/data-promo-original/.test(html) && /EGP 750/.test(html), 'plain render');
  });

  // ── F. Wiring ─────────────────────────────────────────────────────────────
  await check('F. markCasePaid redeems inside the paid transaction (the boundary every paid path shares)', () => {
    const lc = code(read('src/case_lifecycle.js'));
    const fn = between(lc, 'async function markCasePaid(caseId) {', '}); // end withTransaction');
    const tr = fn.indexOf('await transitionCase(caseId, CASE_STATUS.PAID');
    const rd = fn.indexOf("redeemForPaidOrder(client, caseId)");
    expect(tr !== -1 && rd > tr, 'redeem must run after the PAID transition, on the txn client');
    expect(fn.indexOf('if (alreadyProcessed) return existing;') < tr, 'and only on the transition, not on the idempotent replay');
  });

  await check('F. web route: POST /patient/new-case/promo applies/removes server-side and reads no amount', () => {
    const p = code(read('src/routes/patient.js'));
    const route = between(p, "router.post('/patient/new-case/promo'", "\nrouter.");
    expect(/promoCodes\.applyToOrder\(\{/.test(route) && /promoCodes\.removeFromOrder\(/.test(route), 'apply + remove');
    expect(/loadOwnedDraft\(orderId, patientId\)/.test(route), 'ownership');
    expect(/pricingMarketFor\(countryCode\)/.test(route) && /getPricingCountryCode\(req, 'web\.promo'\)/.test(route), 'market from the account-country resolver');
    expect(!/req\.body\.(price|amount|total|discount)/.test(route), 'no amount from the client');
    const ptp = between(p, 'async function persistTierPricing(', '\n}\n');
    expect(/price_before_discount = NULL,\s*discount_egp = NULL,/.test(ptp), 'tier re-price clears the old discount');
    expect(/promoCodes\.reapplyToOrder\(\{/.test(ptp), 'and re-applies the code');
    expect((p.match(/await persistTierPricing\(\{[^}]*countryCode/g) || []).length === 2, 'both tier writers pass the pricing country');
  });

  await check('F. ?promo= pre-fills: remembered on /start and the wizard, forwarded on the /start CTA', () => {
    const sp = code(read('src/routes/static-pages.js'));
    expect(/rememberFromQuery\(req, res\)/.test(between(sp, "router.get('/start'", 'router.get(')), '/start remembers it');
    expect(/__target = '\/patient\/new-case' \+ \(__promoCode \? '\?promo=' \+ encodeURIComponent\(__promoCode\) : ''\)/.test(read('src/views/start.ejs')), '/start CTA forwards it');
    const p = code(read('src/routes/patient.js'));
    expect(/promoCodes\.rememberFromQuery\(req, res\);/.test(between(p, "router.get('/patient/new-case'", 'router.get(')), 'wizard entry remembers it');
    const req = { query: {}, cookies: { tk_promo: 'SHIFA25' } };
    eq(promo.prefillFromRequest(req), 'SHIFA25');
    eq(promo.prefillFromRequest({ query: { promo: 'shifa25' }, cookies: {} }), 'SHIFA25');
    let set = null;
    promo.rememberFromQuery({ query: { promo: 'SHIFA25' } }, { cookie: function (n, v, o) { set = { n, v, o }; } });
    expect(set && set.n === 'tk_promo' && set.v === 'SHIFA25' && set.o.httpOnly === true, 'cookie');
    let none = null;
    promo.rememberFromQuery({ query: { promo: '"><script>' } }, { cookie: function () { none = true; } });
    expect(none === null, 'junk is never stored');
  });

  await check('F. migration 131: idempotent table + columns + SHIFA25 seed (EG only) + orders_active re-sync', () => {
    const sql = read('src/migrations/131_promo_codes.sql');
    expect(/CREATE TABLE IF NOT EXISTS promo_codes/.test(sql), 'table');
    expect(/CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_upper_uniq\s+ON promo_codes \(UPPER\(code\)\)/.test(sql), 'case-insensitive unique');
    expect(/percent_off\s+INTEGER NOT NULL CHECK \(percent_off BETWEEN 1 AND 90\)/.test(sql), 'percent range');
    for (const c of ['promo_code text', 'discount_egp numeric', 'price_before_discount numeric', 'promo_redeemed_at timestamptz']) {
      expect(sql.indexOf('ALTER TABLE orders ADD COLUMN IF NOT EXISTS ' + c) !== -1, c);
    }
    expect(/SELECT 'SHIFA25', 25, true, NOW\(\), NULL, NULL, ARRAY\['EG'\][\s\S]{0,200}WHERE NOT EXISTS \(SELECT 1 FROM promo_codes WHERE UPPER\(code\) = 'SHIFA25'\)/.test(sql), 'seed, re-runnable');
    expect(/CREATE OR REPLACE VIEW public\.orders_active/.test(sql), 'view re-sync');
    expect(!/^[ \t]*BEGIN[ \t]*;/im.test(sql), 'no own transaction — the runner wraps it');
    const files = fs.readdirSync(path.join(ROOT, 'src', 'migrations')).filter((f) => /^131_/.test(f));
    eq(files.length, 1, 'one 131 migration (130 is 130_intl_prices_missing_services)');
  });

  // ── G. Doctor payout ──────────────────────────────────────────────────────
  await check('G. the doctor fee is the list-price fee: 20% of 750 = 150 whether or not SHIFA25 was used', () => {
    const { computeDoctorEarnings } = require('../../src/services/earnings_calc');
    const { egpChargeFromLocal } = require('../../src/fx');
    const fee = egpChargeFromLocal(750, 'EGP').doctorFeeEgp;
    eq(fee, 150, 'list fee');
    // the order after SHIFA25: price 563, but doctor_fee / uplift are the list figures
    const withPromo = { price: 563, price_before_discount: 750, doctor_fee: fee, urgency_uplift_amount: 0 };
    eq(computeDoctorEarnings({ baseDoctorFee: withPromo.doctor_fee, upliftAmount: withPromo.urgency_uplift_amount }).total, 150);
    // VIP: list 975 (750 + 225 uplift) → price 731; doctor 150 + 30% of 225 = 217.5
    const vip = { price: 731, price_before_discount: 975, doctor_fee: 150, urgency_uplift_amount: 225 };
    eq(computeDoctorEarnings({ baseDoctorFee: vip.doctor_fee, upliftAmount: vip.urgency_uplift_amount }).total, 217.5);
  });

  await check('G. no promo write path touches doctor_fee, base_price or urgency_uplift_amount; doctor share never reads price', () => {
    const svc = code(read('src/services/promo_codes.js'));
    const sets = svc.match(/UPDATE orders[\s\S]*?WHERE/g) || [];
    expect(sets.length >= 3, 'found the promo UPDATEs');
    for (const s of sets) expect(!/doctor_fee|base_price|urgency_uplift_amount/.test(s), 'promo UPDATE touches a payout column: ' + s);
    const draft = code(read('src/routes/api/cases_draft.js'));
    expect(/doctor_fee = \$8,/.test(draft) && /intake\.charge\.doctorFeeEgp,/.test(draft), 'API submit: doctor_fee is the list-base fee');
    const ew = code(read('src/services/earnings_writer.js'));
    expect(/const baseDoctorFee = Number\(order\.doctor_fee\) \|\| 0;/.test(ew), 'earnings come from doctor_fee');
    expect(!/baseDoctorFee:\s*Number\(order\.price\)/.test(ew), 'never from price');
  });

  await check('G. SLA-breach refund on a promo order returns only what was paid of the uplift', async () => {
    eq(promo.paidShareOf(225, { promo_code: 'SHIFA25', price: 731, price_before_discount: 975 }), 168.69);
    eq(promo.paidShareOf(225, { promo_code: null, price: 975, price_before_discount: null }), 225);
    eq(promo.paidShareOf(225, null), 225);
    eq(await promo.paidShareEgp('o', 225, { queryOneFn: async () => { throw new Error('down'); } }), 225, 'fails to the old figure');
    const sb = code(read('src/services/sla_breach.js'));
    expect(/var refundOwed = await require\('\.\/promo_codes'\)\.paidShareEgp\(orderId, uplift\);/.test(sb), 'wired');
    expect(/refundId, orderId, refundOwed,/.test(sb), 'the refund row carries the paid share');
  });
})();
