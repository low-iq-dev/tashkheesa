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
 * RATES_TO_EGP: 1 unit of <currency> = N EGP.
 *
 * ⚠️ RATES ARE MANUALLY MAINTAINED — as of 2026-07-29. UPDATE MONTHLY:
 *    stale rates mischarge international cards. When you update them, only NEW
 *    orders are affected — existing orders keep their locked-in orders.price.
 *
 * Country → currency mapping is owned by ../country-currency.js (the canonical
 * map, also used by routes/patient.js). We import getCurrencyForCountry from
 * there rather than re-declaring a third copy (geo.js has a duplicate map; do
 * not add a fourth).
 */

const { getCurrencyForCountry } = require('./country-currency');

// 1 unit of the key currency = this many EGP. EGP is the identity lane.
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

/**
 * True if we can charge this currency (i.e. we hold an EGP rate for it).
 * @param {string} currency
 */
function hasRate(currency) {
  const ccy = String(currency || '').trim().toUpperCase();
  return ccy === 'EGP' || Object.prototype.hasOwnProperty.call(RATES_TO_EGP, ccy);
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
  const rate = RATES_TO_EGP[ccy];
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
  toEgp,
  toEgpForCountry,
  hasRate,
  DOCTOR_SPLIT_PCT,
  egpChargeFromLocal,
};
