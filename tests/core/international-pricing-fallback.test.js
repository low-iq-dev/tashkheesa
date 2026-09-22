'use strict';
// tests/core/international-pricing-fallback.test.js
//
// 2026-09-22 — the seven-times under-charge
//
// service_regional_prices holds price rows for nine countries. A country
// without a row fell through to services.base_price, which is the EGYPTIAN
// domestic price in EGP. So every other country on earth was charged Egyptian
// prices: a Neuro Imaging Review is £250 in the GB list and 2,400 EGP at home,
// meaning a patient in Poland would have paid roughly a SEVENTH of the
// intended price. Silently — no error, no warning, nothing in the logs.
//
// Found while answering a genuine enquiry from Poland, two days before paid
// traffic was due to be pointed at the site.
//
// These pin the resolver. The DB half is exercised by the integration tests;
// this file is about the decision table, which is where the money is.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { pricingProxyFor, normaliseCountry, PRICED_MARKETS, EUROPE_TO_GB, REST_OF_WORLD } =
  require('../../src/services/pricing_market');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n💷 an unpriced market is not charged Egyptian prices\n');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

// ── the countries that started this ───────────────────────────────────────

check('Poland resolves to the GB price list, not the Egyptian one', () => (
  pricingProxyFor('PL') === 'GB' ? null : 'got ' + pricingProxyFor('PL')
));

check('every European country in the currency map has a price list', () => {
  const bad = EUROPE_TO_GB.filter((cc) => pricingProxyFor(cc) !== 'GB');
  return bad.length ? 'not proxied: ' + bad.join(', ') : null;
});

check('Europe proxies to GB, not US — display currency is GBP there', () => (
  pricingProxyFor('DE') === 'GB' && pricingProxyFor('FR') === 'GB'
    ? null : 'a European would be quoted a dollar price against a GBP display'
));

// ── the markets that must NOT be redirected ───────────────────────────────

check('Egypt is left alone — the home market prices from base_price', () => (
  pricingProxyFor('EG') === null ? null : 'EG was proxied to ' + pricingProxyFor('EG')
));

check('a country with its own price list is never proxied', () => {
  const bad = PRICED_MARKETS.filter((cc) => pricingProxyFor(cc) !== null);
  return bad.length ? 'proxied despite having rows: ' + bad.join(', ') : null;
});

check('the UK keeps its own list rather than becoming its own proxy', () => (
  pricingProxyFor('GB') === null ? null : 'GB proxied to itself'
));

// ── everywhere else ───────────────────────────────────────────────────────

check('an unlisted country falls to the US list, the international anchor', () => {
  for (const cc of ['NG', 'IN', 'JP', 'BR', 'AU', 'ZA', 'TR']) {
    if (pricingProxyFor(cc) !== REST_OF_WORLD) return cc + ' → ' + pricingProxyFor(cc);
  }
  return null;
});

check('a missing or junk country still resolves, and resolves upward', () => {
  for (const v of [undefined, null, '', '  ']) {
    if (pricingProxyFor(v) !== REST_OF_WORLD) return 'got ' + pricingProxyFor(v) + ' for ' + JSON.stringify(v);
  }
  return null;
});

check('lowercase input is handled — country codes arrive in both cases', () => (
  pricingProxyFor('pl') === 'GB' && pricingProxyFor('eg') === null
    ? null : 'case handling is wrong'
));

// ── dirty country data, which is what production actually holds ───────────
//
// Of 30 patient rows on 22 Sep: 16 'EG', 12 NULL, 2 the string 'Egypt'.
// 'Egypt' uppercases to 'EGYPT', which is not 'EG' — so without normalisation
// an Egyptian patient lands on the rest-of-world list at about four times the
// domestic price. Over-charging a domestic patient is a worse failure than the
// under-charge this module was written to fix, not a smaller one.

check("'Egypt' is Egypt, not the rest of the world", () => (
  pricingProxyFor('Egypt') === null && normaliseCountry('Egypt') === 'EG'
    ? null : 'a real production row would be charged the US list'
));

check('country names and casing are tolerated', () => {
  const cases = [['egypt', 'EG'], [' eg ', 'EG'], ['United Kingdom', 'GB'],
                 ['UK', 'GB'], ['USA', 'US'], ['Poland', 'PL'], ['UAE', 'AE']];
  for (const [input, iso] of cases) {
    if (normaliseCountry(input) !== iso) return input + ' → ' + normaliseCountry(input) + ', expected ' + iso;
  }
  return null;
});

check('a name we do not recognise returns null rather than guessing', () => (
  normaliseCountry('Wakanda') === null && normaliseCountry('E G') === null
    ? null : 'an unknown name was silently resolved to a country'
));

check('an unrecognisable country still prices upward, never Egyptian', () => (
  pricingProxyFor('Wakanda') === REST_OF_WORLD && pricingProxyFor(null) === REST_OF_WORLD
    ? null : 'unknown input falls back to the home price'
));

// ── the wiring ────────────────────────────────────────────────────────────

const intake = fs.readFileSync(
  path.join(__dirname, '../../src/services/case_intake_pricing.js'), 'utf8');

check('case_intake_pricing actually uses the resolver', () => (
  /pricingProxyFor/.test(intake) ? null : 'the resolver is not wired in'
));

check('case_intake_pricing normalises the country at the door', () => (
  /normaliseCountry\(country\)/.test(intake)
    ? null : "a row storing 'Egypt' would miss the home market"
));

check("the country's OWN row still wins — the proxy only runs on a miss", () => (
  /if \(!isHomeMarket && \(!regionalPrice \|\| regionalPrice\.tashkheesa_price == null\)\)/.test(intake)
    ? null : 'the proxy could override a real country price'
));

check('a proxy with no row of its own is logged as an error, not swallowed', () => (
  /UNDER-CHARGES/.test(intake)
    ? null : 'the last-resort EGP fallback is silent again'
));

check('the market that priced the case is returned to the caller', () => (
  /pricingMarket/.test(intake) ? null : 'no way to tell which list was used'
));
