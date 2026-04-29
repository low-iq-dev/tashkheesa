/**
 * Urgency pricing — pure function, no DB calls.
 *
 * Computes the multiplier-applied total + the uplift amount for a given
 * urgency tier, against a service row that may carry per-service overrides.
 * Per docs/PAYOUT_AND_URGENCY_POLICY.md §2 / §8.
 *
 * Defaults:
 *   standard  multiplier 1.00  (no uplift)
 *   vip       multiplier 1.30  (services.vip_multiplier override possible)
 *   urgent    multiplier 1.60  (services.urgent_multiplier override possible)
 *
 * The uplift is the difference between tier-multiplied price and the base
 * (1.0×) price — the 30/70 doctor/platform split applies to this delta.
 */

'use strict';

var URGENCY_TIERS = Object.freeze({
  STANDARD: 'standard',
  VIP: 'vip',
  URGENT: 'urgent'
});

/**
 * @param {Object}   args
 * @param {number}   args.basePrice       EGP, the unmultiplied service price.
 * @param {string}   args.urgencyTier     'standard' | 'vip' | 'urgent'.
 * @param {Object=}  args.servicesRow     Optional service row for overrides.
 *                                        Reads vip_multiplier / urgent_multiplier;
 *                                        falls back to platform defaults if NULL
 *                                        or absent.
 * @returns {{ basePrice:number, multiplier:number,
 *             upliftAmount:number, totalPrice:number }}
 */
function computeOrderPricing(args) {
  var basePrice = Number((args && args.basePrice) || 0);
  var tier = String((args && args.urgencyTier) || 'standard').toLowerCase();
  var row = (args && args.servicesRow) || {};

  var multiplier;
  if (tier === URGENCY_TIERS.VIP) {
    multiplier = _firstNumeric(row.vip_multiplier, 1.30);
  } else if (tier === URGENCY_TIERS.URGENT) {
    multiplier = _firstNumeric(row.urgent_multiplier, 1.60);
  } else {
    multiplier = 1.00;
  }

  // Round to 2dp at every monetary boundary so we never accumulate float
  // drift on chained multiplications. EGP rendering is integer-only on the
  // checkout, but the upstream NUMERIC(10,2) stores cents.
  var totalPrice = _round2(basePrice * multiplier);
  var upliftAmount = _round2(totalPrice - basePrice);

  return {
    basePrice: _round2(basePrice),
    multiplier: multiplier,
    upliftAmount: upliftAmount,
    totalPrice: totalPrice
  };
}

function _firstNumeric() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

function _round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  URGENCY_TIERS: URGENCY_TIERS,
  computeOrderPricing: computeOrderPricing
};
