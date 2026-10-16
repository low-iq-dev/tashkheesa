// tests/core/public-market-prices.test.js
//
// 16 Oct 2026 — a visitor outside Egypt sees their own price list on the
// public pages (the list the checkout charges from), Egypt is unchanged, and
// /uk is an English, GBP landing page that is honest about who the doctors are.
'use strict';
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; }
};
console.log('\n💷  public pages: local price list for foreign visitors, /uk landing\n');

const ROOT = path.join(__dirname, '..', '..');
const pm = require(path.join(ROOT, 'src', 'services', 'public_market'));
const { startPublicSiteApp } = require('../_helpers/public_site_app');

const GB_ROWS = [
  { service_id: 'card_echo', tashkheesa_price: 400, currency: 'GBP' },
  { service_id: 'rad_mri', tashkheesa_price: 250, currency: 'GBP' }
];
const US_ROWS = [
  { service_id: 'card_echo', tashkheesa_price: 350, currency: 'USD' },
  { service_id: 'rad_mri', tashkheesa_price: 200, currency: 'USD' }
];

(async function () {
  // ── pure helpers ──────────────────────────────────────────────────────
  try {
    const want = { EG: 'EG', GB: 'GB', UK: 'GB', FR: 'GB', DE: 'GB', US: 'US', AE: 'AE', JP: 'US', '': 'EG', Egypt: 'EG' };
    for (const k of Object.keys(want)) {
      const got = pm.marketFor(k);
      if (got !== want[k]) throw new Error(k + ' → ' + got + ', want ' + want[k]);
    }
    t.pass('marketFor: Egypt/unknown → EG, UK → GB, Europe → GB, rest of world → US');
  } catch (e) { t.fail('marketFor', e); }

  try {
    const r = (h, extra) => Object.assign({ headers: h || {}, query: {}, cookies: {}, get: (n) => (h || {})[n.toLowerCase()] }, extra || {});
    if (pm.visitorCountry(r({ 'cf-ipcountry': 'GB' })) !== 'GB') throw new Error('header ignored');
    if (pm.visitorCountry(r({ 'cf-ipcountry': 'GB', 'user-agent': 'Googlebot/2.1' })) !== 'EG') throw new Error('crawler must see EG');
    if (pm.visitorCountry(r({ 'cf-ipcountry': 'EG' }, { query: { market: 'gb' } })) !== 'GB') throw new Error('?market= must win');
    if (pm.visitorCountry(r({ 'cf-ipcountry': 'EG' }, { cookies: { mkt: 'GB' } })) !== 'GB') throw new Error('mkt cookie ignored');
    if (pm.visitorCountry(r({ 'cf-ipcountry': 'XX' })) !== 'EG') throw new Error('XX must fall back');
    t.pass('visitorCountry: ?market > cookie > crawler(EG) > header; junk falls back to EG');
  } catch (e) { t.fail('visitorCountry', e); }

  try {
    const svcs = [{ id: 'a', base_price: 1600 }, { id: 'b', base_price: 1600 }, { id: 'c', base_price: 2400 }];
    const pb = pm.priceBook('GB', [{ service_id: 'a', tashkheesa_price: 250, currency: 'GBP' }], svcs);
    if (pb.format(1600, 'a') !== '£250') throw new Error('own row: ' + pb.format(1600, 'a'));
    if (pb.format(1600, 'b') !== '£250') throw new Error('band fallback: ' + pb.format(1600, 'b'));
    if (pb.format(2400, 'c') !== null) throw new Error('no row and no band must be null, never the EGP number as pounds');
    if (pb.minFormatted !== '£250') throw new Error('min: ' + pb.minFormatted);
    const eg = pm.priceBook('EG', [], svcs);
    if (eg.isLocal || eg.format(1600, 'a') !== null) throw new Error('EG must not be local');
    if (pm.formatAmount(449, 'AED') !== 'AED 449' || pm.formatAmount(120, 'USD') !== '$120') throw new Error('formatAmount');
    t.pass('priceBook: own row, then the band, never an EGP figure dressed as pounds');
  } catch (e) { t.fail('priceBook', e); }

  // ── rendered pages ────────────────────────────────────────────────────
  const rows = { GB: GB_ROWS, US: US_ROWS };
  const { fakeSafeAll } = require('../_helpers/public_site_app');
  let app;
  try {
    app = await startPublicSiteApp({
      bookingCtaEnabled: true,
      safeAll: async (sql, params) => {
        if (/FROM service_regional_prices/i.test(String(sql))) return (rows[params && params[0]] || []).slice();
        return fakeSafeAll(sql, params);
      }
    });

    const eg = await app.get('/services', { 'cf-ipcountry': 'EG' });
    if (eg.status !== 200) throw new Error('EG /services ' + eg.status + ' ' + eg.body.slice(0, 300));
    if (!/2,400 <small>EGP<\/small>/.test(eg.body)) throw new Error('Egypt must still see EGP prices');
    if (/£/.test(eg.body)) throw new Error('Egypt must not see pounds');
    if (!/InstaPay/.test(eg.body)) throw new Error('Egypt keeps InstaPay / bank transfer');
    t.pass('/services from Egypt: unchanged (EGP, InstaPay)');

    const gb = await app.get('/services', { 'cf-ipcountry': 'GB' });
    if (!/£400/.test(gb.body) || !/£250/.test(gb.body)) throw new Error('UK visitor must see £ prices');
    if (/2,400 <small>EGP<\/small>/.test(gb.body)) throw new Error('UK visitor still sees EGP on a card');
    if (!/Visa \/ Mastercard/.test(gb.body)) throw new Error('UK visitor must see card payment');
    if (!/Egyptian pounds/.test(gb.body)) throw new Error('the EGP charge must be disclosed');
    t.pass('/services from the UK: £ prices, card payment, EGP charge disclosed');

    const fr = await app.get('/services', { 'cf-ipcountry': 'FR' });
    if (!/£400/.test(fr.body)) throw new Error('France prices from the GB list, like the checkout');
    const us = await app.get('/services', { 'cf-ipcountry': 'US' });
    if (!/\$350/.test(us.body)) throw new Error('US visitor must see $');
    const bot = await app.get('/services', { 'cf-ipcountry': 'US', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    if (/\$350/.test(bot.body) || !/2,400 <small>EGP<\/small>/.test(bot.body)) throw new Error('crawlers must index the EGP page');
    t.pass('/services: Europe → £, US → $, crawlers → EGP');

    const uk = await app.get('/uk', { 'cf-ipcountry': 'EG', cookie: 'lang=ar' });
    if (uk.status !== 200) throw new Error('/uk ' + uk.status + ' ' + uk.body.slice(0, 400));
    if (!/<html[^>]*lang="en"/.test(uk.body)) throw new Error('/uk must render in English even with an ar cookie');
    if (!/£250/.test(uk.body) || !/From <b>£250<\/b>/.test(uk.body)) throw new Error('/uk must quote the GB list');
    if (!/not registered with the UK General Medical Council/.test(uk.body)) throw new Error('GMC disclosure missing');
    if (!/call 999/.test(uk.body)) throw new Error('UK emergency number missing');
    if (/\b123\b/.test(uk.body.replace(/<script[\s\S]*?<\/script>/g, ''))) throw new Error('Egyptian emergency number on /uk');
    if (!/data-funnel="uk_cta"/.test(uk.body)) throw new Error('Start tap not tagged');
    if (!/href="\/register\?next=%2Fpatient%2Fnew-case&amp;lang=en"/.test(uk.body)) throw new Error('Start must go to sign-up in English');
    const sc = String(uk.headers.get('set-cookie') || '');
    if (!/mkt=GB/.test(sc)) throw new Error('/uk must remember the GB market');
    t.pass('/uk: English, £ prices, GMC + 999 disclosure, Start → sign-up, remembers GB');

    const after = await app.get('/services', { 'cf-ipcountry': 'EG', cookie: 'mkt=GB' });
    if (!/£400/.test(after.body)) throw new Error('/services after /uk must stay in pounds');
    t.pass('/services after /uk keeps quoting pounds');

    const ar = await app.get('/ar/uk');
    if (ar.status !== 404) throw new Error('/ar/uk should not exist, got ' + ar.status);
    t.pass('/uk has no Arabic twin');
  } catch (e) { t.fail('rendered pages', e); }
  finally { if (app) await app.close(); }

  try {
    const fd = require(path.join(ROOT, 'src', 'services', 'funnel_digest'));
    const txt = fd.formatDigest({ day: '2026-10-16', uk_view: 40, uk_cta: 4, uk_wa: 1 }, null);
    if (!/UK page \/uk: views 40 · Start 4/.test(txt)) throw new Error('digest line missing: ' + txt);
    const none = fd.formatDigest({ day: '2026-10-16' }, null);
    if (/UK page/.test(none)) throw new Error('UK line should stay hidden with no traffic');
    t.pass('digest: a UK line appears once /uk has traffic');
  } catch (e) { t.fail('digest', e); }
})();

