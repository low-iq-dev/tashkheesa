// src/geo.js
// IP-based country detection and currency mapping
const { signupCountry } = require('./launch-market');
const { pricingMarketFor } = require('./services/pricing_market');

function detectCountry(req) {
  // 26 Oct 2026 — the visitor's REAL country (any ISO code we know), used to
  // pre-select the signup country. It used to be clamped to the nine launch
  // markets, so a German visitor's form opened on "Egypt". Unknown → EG.
  var raw = (req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']))
         || (req.user && (req.user.country_code || req.user.country)) || 'EG';
  return signupCountry(raw) || 'EG';
}

var COUNTRY_CURRENCY_MAP = {
  EG: 'EGP',
  SA: 'SAR',
  AE: 'AED',
  KW: 'KWD',
  BH: 'BHD',
  QA: 'QAR',
  OM: 'OMR',
  GB: 'GBP',
  US: 'USD'
};

// The currency of the price list `country` is quoted from (pricingMarketFor):
// DE → GBP, LY → EGP, JP → USD.
function countryToCurrency(country) {
  return COUNTRY_CURRENCY_MAP[country] || COUNTRY_CURRENCY_MAP[pricingMarketFor(country)] || 'EGP';
}

module.exports = { detectCountry, countryToCurrency, COUNTRY_CURRENCY_MAP };
