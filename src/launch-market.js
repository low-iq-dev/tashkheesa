'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// MARKETS — who may sign up, and which nine markets carry their own price list.
//
// 26 Oct 2026 — SIGNUP IS OPEN TO EVERY COUNTRY. Until today POST /register,
// the OTP doors and the app API refused (or clamped to EG) any patient outside
// the nine markets below. The platform had no paid patient yet, and a patient
// in Germany, Libya or Japan simply could not get in. Now:
//
//   - any ISO-3166 alpha-2 country on src/lib/countries.js may sign up
//     (isValidCountry), and users.country / country_code store the patient's
//     REAL country;
//   - what they are quoted and charged is decided by ONE resolver,
//     services/pricing_market.pricingMarketFor (Europe → GB list, non-Gulf
//     Arab → the Egyptian price, everywhere else → US list);
//   - the card is still ALWAYS charged in EGP (src/fx.js), and the doctor fee
//     is 20% of the EGP charge, so the margin is positive in every market.
//
// LAUNCH_MARKETS is now "the markets with their own price list" (EG prices
// from services.base_price, the other eight from service_regional_prices).
// isLaunchMarket still gates the ADMIN pricing-activation screens — a price
// list can only be switched on for one of these — and coerceCountry is kept
// for the few callers that must stay EG-scoped. Neither may be used to decide
// who can sign up or what a patient pays.
// See docs/superpowers/specs/2026-06-08-egypt-only-market-gate-design.md.
// ─────────────────────────────────────────────────────────────────────────────
const { isValidCountry, countryByIso, countryForDial } = require('./lib/countries');

const LAUNCH_MARKETS = new Set(['EG', 'SA', 'AE', 'GB', 'US', 'KW', 'QA', 'BH', 'OM']);

function isLaunchMarket(code) {
  return LAUNCH_MARKETS.has(String(code || '').trim().toUpperCase());
}

// Returns the code if it is a launch market, else falls back to 'EG'.
// NOT for signup or pricing — see the header.
function coerceCountry(code) {
  const u = String(code || '').trim().toUpperCase();
  return LAUNCH_MARKETS.has(u) ? u : 'EG';
}

/**
 * The country to STORE for a patient: the ISO code when it is a real country
 * ('de' → 'DE', 'UK' → 'GB', 'Egypt' → 'EG'), else null. Callers decide their
 * own fallback.
 */
function signupCountry(code) {
  const c = countryByIso(code)
    || countryByIso(require('./services/pricing_market').normaliseCountry(code));
  return c ? c.iso : null;
}

// AUDIT-APP-H10: dialling code → ISO country. Used by the OTP signup paths,
// which have no explicit country field — the verified dialling code is the
// only signal available at account creation. 26 Oct 2026: every country's
// code resolves now (+49 → DE, +962 → JO); shared codes resolve to the main
// country (+1 → US, +7 → RU). Unknown → null so the caller can fall back.
function marketFromDialCode(dialCode) {
  return countryForDial(dialCode);
}

module.exports = { LAUNCH_MARKETS, isLaunchMarket, coerceCountry, isValidCountry, signupCountry, marketFromDialCode };
