// src/geo.js
// IP-based country detection and currency mapping

function detectCountry(req) {
  // Check Cloudflare header first
  var cfCountry = req.headers && req.headers['cf-ipcountry'];
  if (cfCountry) return cfCountry.toUpperCase();

  // Check X-Vercel-IP-Country
  var vercelCountry = req.headers && req.headers['x-vercel-ip-country'];
  if (vercelCountry) return vercelCountry.toUpperCase();

  // Check Render / generic header
  var xCountry = req.headers && req.headers['x-country'];
  if (xCountry) return xCountry.toUpperCase();

  // Fallback: check user profile
  if (req.user && req.user.country) return req.user.country.toUpperCase();

  // Default
  return 'EG';
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
