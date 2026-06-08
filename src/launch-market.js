'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH MARKET GATE — Egypt only.
//
// ⚠️ KNOWN-BROKEN PRICING: 241 active service_regional_prices rows for GB/US/AE
// have doctor_commission > tashkheesa_price — we would COLLECT LESS THAN WE PAY
// THE DOCTOR. SA has no active priced rows. These markets are DEFERRED, NOT
// cancelled: their pricing data is PRESERVED but made unreachable at checkout.
//
// DO NOT widen LAUNCH_MARKETS to re-enable a market until those rows are
// repriced (collect >= doctor fee). Widening this Set is the ONLY switch needed
// to re-enable a market end-to-end — every country gate in the app reads here.
// See docs/superpowers/specs/2026-06-08-egypt-only-market-gate-design.md.
// ─────────────────────────────────────────────────────────────────────────────
const LAUNCH_MARKETS = new Set(['EG']); // DEFERRED: SA, AE, GB, US, KW, QA, BH, OM

function isLaunchMarket(code) {
  return LAUNCH_MARKETS.has(String(code || '').trim().toUpperCase());
}

// Returns the code if it is a launch market, else falls back to 'EG'.
function coerceCountry(code) {
  const u = String(code || '').trim().toUpperCase();
  return LAUNCH_MARKETS.has(u) ? u : 'EG';
}

module.exports = { LAUNCH_MARKETS, isLaunchMarket, coerceCountry };
