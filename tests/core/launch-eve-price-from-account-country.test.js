'use strict';
// tests/core/launch-eve-price-from-account-country.test.js
//
// 2026-09-24 (launch eve, T5). The client used to set its own price:
// POST /api/v1/cases priced from body.country. The account's users.country is
// now the pricing country on every case-birth path (app, draft, web funnel);
// the client's country is advisory, a mismatch is logged with both values, and
// a NULL account country falls back to the client's. Hermetic: the pg module
// is replaced with a scripted fake.

const path = require('path');
const fs = require('fs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🌍 cases are priced from the registered country, not the client\'s claim\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PG = require.resolve(path.join(SRC, 'pg.js'));
const PRICING = require.resolve(path.join(SRC, 'services/case_intake_pricing.js'));

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  const realPg = require(PG);
  const savedPricing = require.cache[PRICING];
  let accountCountry = 'GB';
  const regionalQueried = [];
  const fakeQueryOne = async (sql, params) => {
    if (/FROM services sv/.test(sql)) {
      return { id: 'svc-1', specialty_id: 'cardiology', specialty_exists: true, specialty_is_visible: true,
        is_visible: true, coming_soon: false, base_price: 2400, currency: 'EGP' };
    }
    if (/SELECT country FROM users/.test(sql)) return accountCountry === undefined ? null : { country: accountCountry };
    if (/service_regional_prices/.test(sql)) {
      regionalQueried.push(params[1]);
      if (params[1] === 'GB') return { tashkheesa_price: 250, currency: 'GBP' };
      return null;
    }
    return null;
  };
  require.cache[PG].exports = Object.assign({}, realPg, { queryOne: fakeQueryOne });
  delete require.cache[PRICING];

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(require('util').format(...a)); };
  try {
    const pricing = require(PRICING);

    await check('account GB + body EG → priced from the GB list (the client cannot pick the Egyptian price)', async () => {
      accountCountry = 'GB'; warns.length = 0; regionalQueried.length = 0;
      const r = await pricing.resolveAndPriceIntake({
        serviceId: 'svc-1', specialtyId: 'cardiology', country: 'EG', urgencyTier: 'standard', userId: 'pat-gb', context: 'test'
      });
      if (r.displayCountry !== 'GB') throw new Error('displayCountry ' + r.displayCountry);
      if (r.charge.displayCurrency !== 'GBP' || r.charge.displayPrice !== 250) throw new Error('charge ' + JSON.stringify(r.charge));
      if (!(r.charge.egpBase > 2400 * 3)) throw new Error('egpBase ' + r.charge.egpBase + ' looks like the Egyptian price');
      if (!warns.some((w) => /client country EG differs from the account country GB \(user pat-gb/.test(w))) {
        throw new Error('no mismatch warning naming both: ' + JSON.stringify(warns));
      }
    });

    await check('matching countries (\'Egypt\' vs \'EG\') are not a mismatch', async () => {
      warns.length = 0;
      const r = await pricing.resolvePricingCountry({
        userId: 'u', clientCountry: 'EG', queryOneFn: async () => ({ country: 'Egypt' })
      });
      if (r.country !== 'EG' || r.source !== 'account') throw new Error(JSON.stringify(r));
      if (warns.length) throw new Error('warned on a non-mismatch');
    });

    await check('NULL account country → falls back to the client country', async () => {
      const r = await pricing.resolvePricingCountry({ userId: 'u', clientCountry: 'ae', queryOneFn: async () => ({ country: null }) });
      if (r.country !== 'AE' || r.source !== 'client') throw new Error(JSON.stringify(r));
    });

    await check('an unrecognisable account country (EGY) is treated as missing → the client EG, not the proxy list', async () => {
      warns.length = 0;
      const r = await pricing.resolvePricingCountry({ userId: 'u', clientCountry: 'EG', queryOneFn: async () => ({ country: 'EGY' }) });
      if (r.country !== 'EG' || r.source !== 'client') throw new Error(JSON.stringify(r));
      if (!warns.some((w) => /"EGY".*not a recognisable ISO-2 code/.test(w))) throw new Error('no warning: ' + JSON.stringify(warns));
    });

    await check('no clamping: a non-launch-market account country is kept (GB stays GB, never EG)', async () => {
      const r = await pricing.resolvePricingCountry({ userId: 'u', clientCountry: null, queryOneFn: async () => ({ country: 'PL' }) });
      if (r.country !== 'PL') throw new Error(JSON.stringify(r));
    });
  } finally {
    console.warn = origWarn;
    require.cache[PG].exports = realPg;
    if (savedPricing) require.cache[PRICING] = savedPricing; else delete require.cache[PRICING];
  }

  await check('the app (POST /cases) and the draft submit pass the authenticated user', () => {
    if (!/resolveAndPriceIntake\(\{[\s\S]{0,200}userId: req\.user\.id, context: 'api\.cases'/.test(read('src/routes/api/cases.js'))) throw new Error('api/cases.js');
    if (!/resolveAndPriceIntake\(\{[\s\S]{0,200}userId: req\.user\.id, context: 'api\.cases_draft'/.test(read('src/routes/api/cases_draft.js'))) throw new Error('api/cases_draft.js');
  });

  await check('every web-funnel pricing site uses the account-country resolver', () => {
    const src = read('src/routes/patient.js');
    for (const ctx of ['web.wizard', 'web.step4', 'web.urgency_resolve', 'web.new_case']) {
      if (!src.includes("await getPricingCountryCode(req, '" + ctx + "')")) throw new Error(ctx + ' not using getPricingCountryCode');
    }
    if (!/async function getPricingCountryCode[\s\S]{0,900}resolvePricingCountry\(/.test(src)) throw new Error('helper does not delegate to resolvePricingCountry');
  });
})();
