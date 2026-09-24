'use strict';
/**
 * FX — foreign-currency → EGP conversion for the always-charge-EGP model.
 *
 * The platform ALWAYS charges in EGP (Paymob is EGP-only; see paymob.js EGP
 * guard + payments.js currency check). For an international order we DISPLAY the
 * patient's local price but CHARGE the EGP-equivalent, converted exactly ONCE at
 * order creation and locked into orders.price. There is no live FX at checkout,
 * so the amount_mismatch verifier — which trusts orders.price blindly — can never
 * drift against what Paymob actually charged.
 *
 * Rates: 1 unit of <currency> = N EGP.
 *
 * LIVE SINCE LAUNCH EVE (2026-09-24). Rates come from the fx_rates table
 * (migration 118), refreshed daily by the 'fx-rates-pull' pg-boss job
 * (services/fx_rates_job.js ← open.er-api.com, free and keyless). This module
 * keeps an in-memory copy so toEgp stays synchronous; the copy is reloaded
 * from the table at boot, every RATES_TTL_MS, and after each pull, so every
 * web instance converges on the job's rates within minutes. RATES_TO_EGP
 * below is now only the FALLBACK — used when the table is empty or unreadable
 * (and per currency, for any currency the table lacks). Only NEW orders are
 * affected by a rate change; existing orders keep their locked-in price.
 *
 * Country → currency mapping is owned by ../country-currency.js (the canonical
 * map, also used by routes/patient.js). We import getCurrencyForCountry from
 * there rather than re-declaring a third copy (geo.js has a duplicate map; do
 * not add a fourth).
 */

const { getCurrencyForCountry } = require('./country-currency');

// FALLBACK table (was the only table until 2026-09-24; seeded into fx_rates by
// migration 118). 1 unit of the key currency = this many EGP.
const RATES_TO_EGP = Object.freeze({
  EGP: 1,
  USD: 50.5,
  GBP: 68.7,
  AED: 13.75,
  SAR: 13.47,
  QAR: 13.87,
  KWD: 165.8,
  BHD: 134.3,
  OMR: 131.3,
});

// The market currencies the job pulls — the fallback table minus the identity.
const MARKET_CURRENCIES = Object.freeze(Object.keys(RATES_TO_EGP).filter((c) => c !== 'EGP'));

const RATES_TTL_MS = 10 * 60 * 1000;

// The live copy toEgp reads. Starts as the fallback so a request served before
// the first DB load prices exactly as the code always has.
let _live = {
  rates: Object.assign({}, RATES_TO_EGP),
  source: 'fallback',          // 'db' | 'fallback'
  freshestFetchedAt: null,     // Date of the newest DB row, when source = 'db'
  loadedAt: 0
};

function _rateFor(ccy) {
  return Object.prototype.hasOwnProperty.call(_live.rates, ccy) ? _live.rates[ccy] : undefined;
}

/**
 * Reload the live copy from fx_rates. Never throws: on a failed or empty read
 * it keeps whatever it had (the last good DB load, or the fallback table).
 *
 * @param {{ queryAllFn?: Function }} [opts] — injectable for tests
 * @returns {Promise<{ source: string, freshestFetchedAt: (Date|null) }>}
 */
async function refreshRatesFromDb(opts) {
  try {
    const queryAll = (opts && opts.queryAllFn) || require('./pg').queryAll;
    const rows = await queryAll(
      "SELECT base, rate, fetched_at FROM fx_rates WHERE quote = 'EGP'"
    );
    const next = Object.assign({}, RATES_TO_EGP);
    let freshest = null;
    let used = 0;
    for (const r of rows || []) {
      const ccy = String(r.base || '').trim().toUpperCase();
      const rate = Number(r.rate);
      if (!ccy || ccy === 'EGP' || !Number.isFinite(rate) || rate <= 0) continue;
      next[ccy] = rate;
      used++;
      const at = r.fetched_at ? new Date(r.fetched_at) : null;
      if (at && !Number.isNaN(at.getTime()) && (!freshest || at > freshest)) freshest = at;
    }
    if (used > 0) {
      _live = { rates: next, source: 'db', freshestFetchedAt: freshest, loadedAt: Date.now() };
    } else {
      // Empty table: the hardcoded rates, exactly as before migration 118.
      _live = Object.assign({}, _live, { loadedAt: Date.now() });
    }
  } catch (e) {
    // Keep the last good copy; retry after the TTL rather than on every call.
    _live = Object.assign({}, _live, { loadedAt: Date.now() });
    console.warn('[fx] rate reload failed — keeping the ' + _live.source + ' rates:', e && e.message);
  }
  return { source: _live.source, freshestFetchedAt: _live.freshestFetchedAt };
}

/** Reload if the live copy is older than RATES_TTL_MS. Cheap when fresh. */
async function ensureFreshRates(opts) {
  if (Date.now() - _live.loadedAt < RATES_TTL_MS) return;
  await refreshRatesFromDb(opts);
}

/** Where the current rates came from, for health checks and tests. */
function ratesStatus() {
  return { source: _live.source, freshestFetchedAt: _live.freshestFetchedAt, rates: Object.assign({}, _live.rates) };
}

/**
 * True if we can charge this currency (i.e. we hold an EGP rate for it).
 * @param {string} currency
 */
function hasRate(currency) {
  const ccy = String(currency || '').trim().toUpperCase();
  return ccy === 'EGP' || _rateFor(ccy) !== undefined;
}

/**
 * Convert a local-currency amount to EGP.
 *
 *   - EGP is the identity lane: returned AS-IS (unrounded) so an EG order's
 *     price/fee is byte-identical to today.
 *   - Any other supported currency: localAmount * rate, rounded to an INTEGER
 *     EGP amount (we charge whole EGP; no fractional piastres on the card).
 *   - An unknown currency THROWS — we must NEVER silently charge a foreign
 *     number as EGP (that would over/under-charge by the FX factor).
 *
 * @param {number} localAmount   amount in `currency`
 * @param {string} currency      ISO code (case-insensitive), e.g. 'AED'
 * @returns {number} EGP amount (identity for EGP; integer for converted)
 */
function toEgp(localAmount, currency) {
  const amt = Number(localAmount);
  if (!Number.isFinite(amt)) {
    throw new Error('fx.toEgp: localAmount must be a finite number (got ' + localAmount + ')');
  }
  const ccy = String(currency || '').trim().toUpperCase();
  if (ccy === 'EGP') return amt;               // identity — already EGP, no rounding
  const rate = _rateFor(ccy);
  if (!rate) {
    throw new Error(
      'fx.toEgp: no EGP rate for currency "' + ccy + '" — refusing to charge a foreign amount as EGP'
    );
  }
  return Math.round(amt * rate);
}

/**
 * Convenience: EGP rate for a country code (via the canonical currency map).
 * Throws (through toEgp) if the resolved currency is unsupported.
 * @param {number} localAmount
 * @param {string} countryCode  e.g. 'AE'
 */
function toEgpForCountry(localAmount, countryCode) {
  return toEgp(localAmount, getCurrencyForCountry(String(countryCode || '').toUpperCase()));
}

// Flat doctor split — 20% of the EGP charge for ALL services (repriced
// 2026-07-29 to a uniform 20%; no per-service ratio). See docs/PAYOUT_AND_URGENCY_POLICY.
const DOCTOR_SPLIT_PCT = 0.20;

/**
 * SINGLE SOURCE OF TRUTH for turning a LOCAL catalog price into the EGP charge
 * base + the display fields + the doctor fee, used at EVERY order-creation write
 * site so the always-charge-EGP invariant can never drift between them.
 *
 * CORE INVARIANT: the charge is ALWAYS EGP. `egpBase` is the EGP amount that
 * flows into orders.price (via +uplift where applicable); orders.currency stays
 * 'EGP'. `displayPrice`/`displayCurrency` are the LOCAL figures FOR SHOW ONLY and
 * are NULL for domestic (EGP) orders so EG rendering falls back to price/'EGP'
 * and stays byte-identical.
 *
 * @param {number} localBase       local-currency catalog base price
 * @param {string} localCurrency   ISO code of the local price (e.g. 'AED', 'EGP')
 * @returns {{ egpBase:number, doctorFeeEgp:number, displayPrice:(number|null), displayCurrency:(string|null), isIntl:boolean }}
 */
function egpChargeFromLocal(localBase, localCurrency) {
  const ccy = String(localCurrency || 'EGP').trim().toUpperCase();
  const egpBase = toEgp(localBase, ccy);          // identity for EGP; converted+rounded otherwise
  const isIntl = ccy !== 'EGP';
  return {
    egpBase: egpBase,
    doctorFeeEgp: Math.round(egpBase * DOCTOR_SPLIT_PCT),
    displayPrice: isIntl ? Number(localBase) : null,
    displayCurrency: isIntl ? ccy : null,
    isIntl: isIntl,
  };
}

module.exports = {
  RATES_TO_EGP,
  MARKET_CURRENCIES,
  RATES_TTL_MS,
  refreshRatesFromDb,
  ensureFreshRates,
  ratesStatus,
  toEgp,
  toEgpForCountry,
  hasRate,
  DOCTOR_SPLIT_PCT,
  egpChargeFromLocal,
};
