'use strict';

// src/services/pricing_market.js
//
// Which market's PRICE LIST a country is charged from.
//
// THE BUG THIS EXISTS TO FIX (2026-09-22)
// ---------------------------------------
// service_regional_prices holds a price row per country, for nine countries:
// AE, BH, EG, GB, KW, OM, QA, SA, US. case_intake_pricing.js looked a country
// up in that table and, on a miss, fell through to services.base_price — the
// EGYPTIAN domestic price, in EGP.
//
// So any country without a row was charged the Egyptian price. A patient in
// Poland enquiring about a Neuro Imaging Review would have paid 2,400 EGP,
// about £35. The same service to a patient in the UK is £250. Seven times
// under, silently: no error, no warning, no log line. Every European country
// except the UK sat in that hole, and so did every country outside the nine.
//
// This was found on 22 September while answering a real enquiry from Poland,
// two days before paid traffic was due to be pointed at the site.
//
// WHY A PROXY MAP RATHER THAN MORE ROWS
// -------------------------------------
// The alternative was 177 services × every country we might serve, which is
// thousands of rows to hand-maintain and get wrong. A country instead resolves
// to the market whose price list it should be charged from, and the existing
// nine price lists do the work.
//
// A country listed here is NOT prevented from getting its own rows later: the
// lookup in case_intake_pricing.js tries the real country FIRST and only falls
// back to the proxy. Adding a PL row to service_regional_prices immediately
// overrides this map, with no code change. That is the intended path for a
// genuine European tier priced below the UK.
//
// WHY EUROPE PROXIES TO GB AND NOT TO US
// --------------------------------------
// country-currency.js already displays GBP across Europe, so a European
// patient sees a GBP figure either way, and a GBP price list already exists
// for all 177 services. Proxying to US would quote a European a dollar price
// against a GBP display currency.
//
// It is worth being straight about what this is: Europe is charged the UK
// price. That is a Western price rather than a European one, and it is the
// defensible number available today — not a considered European band. Lowering
// it is a data decision (add country rows), not a code one.
//
// WHY THE DEFAULT IS US AND NOT AED
// ---------------------------------
// country-currency.js sets DEFAULT_CURRENCY = 'AED', which means an unmapped
// country DISPLAYS in dirhams. That is a separate default from this one and it
// is not obviously right either, but changing it moves prices for every Arab
// market that currently relies on it. The rest-of-world PRICE list is USD
// here: the widest-accepted currency, a rate we hold, and the list that is
// meant to be the international anchor.
//
// PRICING A MARKET TOO HIGH LOSES A SALE. PRICING IT AT A SEVENTH LOSES MONEY
// ON EVERY SALE, and looks like demand while it does so. When a country has no
// price of its own, this errs upward on purpose.

// The markets that actually have a price list in service_regional_prices.
// EG is deliberately absent: the home market prices from services.base_price
// and never from this table (see case_intake_pricing.js).
const PRICED_MARKETS = Object.freeze(['AE', 'BH', 'GB', 'KW', 'OM', 'QA', 'SA', 'US']);

const HOME_MARKET = 'EG';

// Europe → the GB price list. These are exactly the countries
// country-currency.js already displays in GBP, so display and charge agree.
const EUROPE_TO_GB = Object.freeze([
  'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'AT', 'CH',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
  'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'LU', 'MT', 'CY', 'IS'
]);

const REST_OF_WORLD = 'US';

const PROXY = Object.freeze(
  EUROPE_TO_GB.reduce(function (acc, cc) { acc[cc] = 'GB'; return acc; }, {})
);

// users.country is NOT clean. Checked in production 22 Sep: of 30 patient
// rows, 16 hold 'EG', 12 hold NULL and 2 hold the string 'Egypt'.
//
// That last one is why this map exists, and it is not a cosmetic concern. With
// a naive uppercase comparison 'Egypt' is not 'EG', so it would miss the home
// market, miss every priced market, and land on the rest-of-world proxy — the
// US list. A Neuro Imaging Review is 200 USD there against 2,400 EGP at home,
// so an Egyptian patient whose row says 'Egypt' would be charged roughly FOUR
// TIMES the domestic price. Over-charging a domestic patient is a refund and a
// lost customer; it is a worse failure than the under-charge this module was
// written to fix, not a smaller one.
//
// Kept deliberately short: the full names actually seen or plausibly typed,
// plus the two abbreviations that are not ISO codes ('UK' for GB, 'UAE' for
// AE). routes/patient.js already special-cases 'UK' the same way.
const NAME_TO_ISO = Object.freeze({
  EGYPT: 'EG',
  'UNITED KINGDOM': 'GB', UK: 'GB', BRITAIN: 'GB', 'GREAT BRITAIN': 'GB',
  'UNITED STATES': 'US', USA: 'US', 'UNITED STATES OF AMERICA': 'US',
  'UNITED ARAB EMIRATES': 'AE', UAE: 'AE',
  'SAUDI ARABIA': 'SA', KSA: 'SA',
  KUWAIT: 'KW', BAHRAIN: 'BH', QATAR: 'QA', OMAN: 'OM',
  POLAND: 'PL', GERMANY: 'DE', FRANCE: 'FR', ITALY: 'IT', SPAIN: 'ES',
  NETHERLANDS: 'NL', BELGIUM: 'BE', IRELAND: 'IE', SWITZERLAND: 'CH',
  SWEDEN: 'SE', NORWAY: 'NO', DENMARK: 'DK', FINLAND: 'FI', AUSTRIA: 'AT',
  PORTUGAL: 'PT', GREECE: 'GR', CZECHIA: 'CZ', 'CZECH REPUBLIC': 'CZ'
});

/**
 * Best-effort ISO-3166-1 alpha-2 from whatever is actually stored.
 * Returns null when it cannot tell, which the caller must treat as unknown
 * rather than as any particular country.
 *
 * @param {string} country
 * @returns {string|null}
 */
function normaliseCountry(country) {
  const raw = String(country == null ? '' : country).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (/^[A-Z]{2}$/.test(raw)) return NAME_TO_ISO[raw] || raw;
  return NAME_TO_ISO[raw] || null;
}

/**
 * The market whose price list `country` should be charged from.
 *
 * Returns null for the home market and for any country that has its own price
 * list — in both cases the caller's normal lookup is already correct and must
 * not be second-guessed here.
 *
 * @param {string} country ISO-3166-1 alpha-2, or a country name we recognise
 * @returns {string|null} a market code to fall back to, or null
 */
function pricingProxyFor(country) {
  const cc = normaliseCountry(country);

  // Unrecognisable, empty or null. Still resolves upward rather than to the
  // Egyptian price — that is the whole point of this module — but a caller
  // that wants to shout about it can ask normaliseCountry() itself, which is
  // why the two functions are separate and both exported.
  if (!cc) return REST_OF_WORLD;

  if (cc === HOME_MARKET) return null;
  if (PRICED_MARKETS.indexOf(cc) !== -1) return null;
  return PROXY[cc] || REST_OF_WORLD;
}

module.exports = {
  pricingProxyFor,
  normaliseCountry,
  PRICED_MARKETS,
  EUROPE_TO_GB,
  REST_OF_WORLD,
  HOME_MARKET
};
