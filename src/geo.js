// src/geo.js
// IP-based country detection and currency mapping
const { coerceCountry } = require('./launch-market');

function detectCountry(req) {
  // LAUNCH GATE (src/launch-market.js): detection is clamped to a launch market
  // (EG today) so display/pre-fill currency can't surface a deferred market.
  var raw = (req.headers && (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country']))
         || (req.user && req.user.country) || 'EG';
  return coerceCountry(raw);
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

function countryToCurrency(country) {
  return COUNTRY_CURRENCY_MAP[country] || 'EGP';
}

module.exports = { detectCountry, countryToCurrency, COUNTRY_CURRENCY_MAP };
