'use strict';

// src/services/public_market.js
//
// Which price list the PUBLIC marketing pages show a visitor (16 Oct 2026).
//
// Until now /services, /start and the homepage quoted every visitor the
// Egyptian price in EGP. The checkout already priced a UK patient from the GB
// list (£150 / £250 / £400 / £600) — so a visitor from London read "1,600 EGP"
// (about £25) on the catalogue and met £250 at the card form. That is the
// worst way round: the page undersold the service and then the price jumped.
//
// The rule here is the CHECKOUT's rule, so the page and the card form agree:
//   - Egypt, or anything we cannot place → the EGP home price (unchanged).
//   - A market with its own list (GB, US, AE, SA, QA, KW, BH, OM) → that list.
//   - Anywhere else → pricing_market.pricingProxyFor (Europe → GB, rest → US).
//
// Where the country comes from, in order:
//   1. ?market=GB on the URL (an ad can pin it), remembered in the `mkt` cookie;
//   2. the `mkt` cookie;
//   3. a crawler → always EG, so search engines index the home-market page;
//   4. the signed-in user's country;
//   5. Cloudflare's cf-ipcountry header (what /register pre-fills from);
//   6. geoip-lite on the client IP;
//   7. EG.
//
// This module only decides what is DISPLAYED. What a patient is charged is
// still decided at checkout by case_intake_pricing.js from their account.

const { pricingProxyFor, normaliseCountry, PRICED_MARKETS } = require('./pricing_market');

let geoip = null;
try { geoip = require('geoip-lite'); } catch (_) { geoip = null; }

const COOKIE = 'mkt';
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|preview|headless|lighthouse|google-inspectiontool/i;
const SYMBOL = { GBP: '£', USD: '$' };

// Emergency numbers we are sure of; anywhere else gets "your local emergency number".
const EMERGENCY = { EG: '123', GB: '999', US: '911', SA: '997', AE: '999', QA: '999', KW: '112', BH: '999', OM: '9999' };

function clientIp(req) {
  const h = (req && req.headers) || {};
  const raw = h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || req.ip || '';
  return String(raw).trim().replace(/^::ffff:/, '');
}

function validCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) && s !== 'XX' && s !== 'T1' ? s : null;
}

/** The visitor's country, best effort (ISO alpha-2). Never throws. */
function visitorCountry(req) {
  try {
    const q = validCode(req.query && req.query.market);
    if (q) return q;
    const c = validCode(req.cookies && req.cookies[COOKIE]);
    if (c) return c;
    const ua = (req.get && req.get('user-agent')) || (req.headers && req.headers['user-agent']) || '';
    if (BOT_UA.test(ua)) return 'EG';
    const u = req.user && normaliseCountry(req.user.country_code || req.user.country);
    if (u) return u;
    const h = req.headers || {};
    const hc = validCode(h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country']);
    if (hc) return hc;
    if (geoip) {
      const g = geoip.lookup(clientIp(req));
      if (g && validCode(g.country)) return g.country;
    }
  } catch (_) { /* fall through */ }
  return 'EG';
}

/** The price list a country is shown: 'EG' or one of PRICED_MARKETS. */
function marketFor(country) {
  const cc = normaliseCountry(country);
  if (!cc || cc === 'EG') return 'EG';
  if (PRICED_MARKETS.indexOf(cc) !== -1) return cc;
  return pricingProxyFor(cc) || 'EG';
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return '';
  const num = n.toLocaleString('en-GB', { maximumFractionDigits: n % 1 ? 2 : 0 });
  const cur = String(currency || 'EGP').toUpperCase();
  return SYMBOL[cur] ? SYMBOL[cur] + num : cur + ' ' + num;
}

/**
 * Express middleware: res.locals.publicMarket = { code, country, emergency }.
 * A ?market= on the URL is remembered for 30 days.
 */
function middleware(req, res, next) {
  try {
    const q = validCode(req.query && req.query.market);
    if (q && res.cookie) res.cookie(COOKIE, q, { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' });
    const country = visitorCountry(req);
    const code = marketFor(country);
    res.locals.publicMarket = { code: code, country: country, emergency: EMERGENCY[country] || null };
  } catch (_) {
    res.locals.publicMarket = { code: 'EG', country: 'EG', emergency: '123' };
  }
  next();
}

/**
 * The SQL that loads one market's price list, for the route's safeAll.
 * Returns rows { service_id, tashkheesa_price, currency }.
 */
const PRICE_LIST_SQL =
  'SELECT service_id, tashkheesa_price, currency FROM service_regional_prices ' +
  " WHERE country_code = $1 AND COALESCE(status, 'active') = 'active' AND tashkheesa_price IS NOT NULL";

/**
 * A price formatter for a template. `priceRows` is the market's price list
 * (empty for EG). money(egp, serviceId) prefers the service's own row, then
 * the band row (the local price other services at the same EGP price carry),
 * and only then the EGP figure — so a missing row can never show a foreign
 * visitor the Egyptian price dressed as theirs.
 */
function priceBook(code, priceRows, services) {
  const byId = {};
  (priceRows || []).forEach(function (r) { if (r && r.service_id) byId[r.service_id] = r; });
  const band = {};
  (services || []).forEach(function (s) {
    const r = s && byId[s.id];
    if (r && s.base_price != null && band[Number(s.base_price)] == null) band[Number(s.base_price)] = r;
  });
  const local = code && code !== 'EG' && Object.keys(byId).length > 0;
  const currency = local ? (priceRows[0].currency || null) : 'EGP';
  function rowFor(egp, sid) { return (sid && byId[sid]) || band[Number(egp)] || null; }
  // The lowest price on the list ("From £95"); null when not local.
  let minLocal = null;
  if (local) {
    (priceRows || []).forEach(function (r) {
      const v = Number(r && r.tashkheesa_price);
      if (v > 0 && (minLocal == null || v < minLocal)) minLocal = v;
    });
  }
  return {
    code: local ? code : 'EG',
    minFormatted: minLocal == null ? null : formatAmount(minLocal, currency),
    isLocal: !!local,
    currency: currency,
    /** number in the visitor's currency, or the EGP number when not local */
    amount: function (egp, sid) {
      if (!local) return Number(egp);
      const r = rowFor(egp, sid);
      return r ? Number(r.tashkheesa_price) : null;
    },
    /** "£150", "$120", "AED 449" — or null when not local / unknown */
    format: function (egp, sid) {
      if (!local) return null;
      const r = rowFor(egp, sid);
      return r ? formatAmount(r.tashkheesa_price, r.currency) : null;
    }
  };
}

module.exports = { middleware, visitorCountry, marketFor, priceBook, formatAmount, PRICE_LIST_SQL, COOKIE, EMERGENCY };
