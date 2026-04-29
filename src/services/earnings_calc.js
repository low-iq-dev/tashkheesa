/**
 * Earnings calc — pure function, no DB calls.
 *
 * Computes the doctor's per-component share for a single order, per
 * docs/PAYOUT_AND_URGENCY_POLICY.md §1.
 *
 * Important contract decision (PR brief, Phase 2 step 2.2):
 *   The base-price doctor share is the absolute services.doctor_fee EGP
 *   amount, NOT base_price × 0.20.  The 20% rule is enforced at the
 *   spreadsheet/catalog level (docs/pricing/tashkheesa_pricing_v2.xlsx);
 *   at runtime we trust the catalog and read the absolute fee directly.
 *
 *   This means: if the catalog data is wrong, this function will compute
 *   wrong earnings — but the function itself is correct.  See the test
 *   file's NOTE comment for the explicit assumption.
 *
 * Uplift portion uses the percentage split from the order/service row
 * (default 30% to doctor, 70% to platform — services.urgency_uplift_doctor_pct
 * may override per-service, see migration 027).
 *
 * Add-on shares use the locked-at-purchase commission percentage stored on
 * each order_addons row at the moment of payment — historical contracts.
 */

'use strict';

/**
 * @param {Object}   args
 * @param {number}   args.baseDoctorFee     EGP, absolute from services.doctor_fee.
 * @param {number}   args.upliftAmount      EGP, the uplift portion (totalPrice - basePrice).
 *                                          Pass 0 for standard tier or post-breach refund.
 * @param {number=}  args.upliftDoctorPct   integer 0-100, default 30. Overrides via
 *                                          services.urgency_uplift_doctor_pct.
 * @param {Array=}   args.addons            optional [{ id?, addon_service_id?,
 *                                          price_at_purchase_egp,
 *                                          doctor_commission_pct_at_purchase }, ...]
 * @returns {{ baseShare:number, upliftShare:number,
 *             addonShares:Array<{addon_id?:string, share:number}>, total:number }}
 */
function computeDoctorEarnings(args) {
  var a = args || {};
  var baseDoctorFee = _round2(_num(a.baseDoctorFee, 0));
  var upliftAmount = _num(a.upliftAmount, 0);
  var upliftPct = _num(a.upliftDoctorPct, 30);
  var addons = Array.isArray(a.addons) ? a.addons : [];

  var baseShare = baseDoctorFee;
  var upliftShare = _round2(upliftAmount * (upliftPct / 100));

  var addonShares = addons.map(function(addon) {
    var price = _num(addon && addon.price_at_purchase_egp, 0);
    var pct = _num(addon && addon.doctor_commission_pct_at_purchase, 0);
    return {
      addon_id: (addon && (addon.id || addon.addon_service_id)) || null,
      share: _round2(price * (pct / 100))
    };
  });

  var addonTotal = addonShares.reduce(function(sum, x) { return sum + x.share; }, 0);
  var total = _round2(baseShare + upliftShare + addonTotal);

  return {
    baseShare: baseShare,
    upliftShare: upliftShare,
    addonShares: addonShares,
    total: total
  };
}

function _num(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  var n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { computeDoctorEarnings: computeDoctorEarnings };
