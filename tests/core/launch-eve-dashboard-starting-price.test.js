'use strict';
// tests/core/launch-eve-dashboard-starting-price.test.js
//
// 2026-09-24 (launch eve, T3). The patient dashboard's "Starting at" fact
// was hardcoded "EGP 1,200" while the cheapest bookable service costs 1,600.
// It now renders the live catalogue floor (services/site_stats.js), and omits
// the fact entirely rather than invent a number when none is available.

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💷 dashboard "Starting at" is the live catalogue floor\n');

const VIEWS = path.join(__dirname, '../../src/views');
const file = path.join(VIEWS, 'patient_dashboard.ejs');

function render(locals) {
  const isAr = locals.lang === 'ar';
  const tt = (k, en, ar) => (isAr ? (ar || en) : en);
  return ejs.renderFile(file, Object.assign({
    tt, t: (k) => k, isAr, user: { name: 'Test Patient' }, drName: (n) => n,
    formatMoney: (a, c) => c + ' ' + a, publicLinkPrefix: '',
    dashboardState: 'empty', activeOrder: null, reportReadyOrder: null,
    draftOrder: null, activeUnreadMessages: 0, isLimbo: false, cspNonce: ''
  }, locals), { views: [VIEWS] });
}

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => t.pass(name), (e) => t.fail(name, e));
}

(async () => {
  await check('the view no longer hardcodes 1,200', () => {
    const src = fs.readFileSync(file, 'utf8');
    if (/1,200/.test(src)) throw new Error('"1,200" is still in patient_dashboard.ejs');
  });

  await check('renders the live minimum (EN)', async () => {
    const html = await render({ lang: 'en', startingPriceEgp: 1600 });
    if (!html.includes('EGP 1,600')) throw new Error('EGP 1,600 not rendered');
    if (html.includes('1,200')) throw new Error('stale 1,200 rendered');
  });

  await check('renders the live minimum (AR, formatMoney policy: Western digits + EGP)', async () => {
    const html = await render({ lang: 'ar', startingPriceEgp: 1600 });
    if (!html.includes('EGP 1,600')) throw new Error('EGP 1,600 not rendered in AR');
    if (!html.includes('يبدأ من')) throw new Error('AR label missing');
  });

  await check('omits the fact when no price is available rather than inventing one', async () => {
    const html = await render({ lang: 'en', startingPriceEgp: null });
    if (html.includes('Starting at')) throw new Error('"Starting at" rendered with no price');
  });

  await check('the dashboard route reads the price from site_stats.getCatalogueStats', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/patient.js'), 'utf8');
    if (!/getCatalogueStats\(\)[\s\S]{0,200}startingPriceEgp/.test(src)) {
      throw new Error('routes/patient.js does not derive startingPriceEgp from getCatalogueStats');
    }
  });
})();
