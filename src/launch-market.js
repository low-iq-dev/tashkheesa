'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH MARKET GATE — 9 markets live (Egypt + GCC + GB/US).
//
// RESOLVED 2026-07-29: the old negative-margin block (241 GB/US/AE rows where
// doctor_commission > tashkheesa_price) no longer applies. Under the ALWAYS-
// CHARGE-EGP model the card is ALWAYS charged in EGP (the local price is
// converted to EGP once at order creation via src/fx.js), and the doctor fee is a
// flat 20% OF THE EGP CHARGE (NOT the local doctor_commission column), so the
// platform margin is structurally positive (80%) in every market. The 8
// international markets were repriced 2026-07-29.
//
// coerceCountry still clamps to EG for callers that must stay EG-scoped; the
// pricing DISPLAY country is resolved separately (patient.js getDisplayCountryCode /
// the write sites' local lookup) so the real market drives display_price while
// the charge stays EGP. Widening this Set opens the isLaunchMarket signup /
// pricing-activation gates for the 9 markets.
// See docs/superpowers/specs/2026-06-08-egypt-only-market-gate-design.md.
// ─────────────────────────────────────────────────────────────────────────────
const LAUNCH_MARKETS = new Set(['EG', 'SA', 'AE', 'GB', 'US', 'KW', 'QA', 'BH', 'OM']);

function isLaunchMarket(code) {
  return LAUNCH_MARKETS.has(String(code || '').trim().toUpperCase());
}

// Returns the code if it is a launch market, else falls back to 'EG'.
function coerceCountry(code) {
  const u = String(code || '').trim().toUpperCase();
  return LAUNCH_MARKETS.has(u) ? u : 'EG';
}

module.exports = { LAUNCH_MARKETS, isLaunchMarket, coerceCountry };
