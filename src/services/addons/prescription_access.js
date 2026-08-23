'use strict';

// AUDIT-2026-08-23 (C4, review round 2) — one answer to "may a prescription be
// written on this case, and what was it priced at".
//
// There are TWO records of a prescription purchase and they do not agree:
//
//   V1 — `orders.addons_json.prescription`. Written unconditionally by the
//        payment callback (routes/payments.js), and it is the figure
//        owedCentsForOrder verifies against what the gateway actually charged.
//        This is the record the patient's money is tied to.
//
//   V2 — a row in `order_addons`. Written by prescription.onPurchase, but ONLY
//        through safeDualWrite, which is a no-op unless ADDON_SYSTEM_V2 is
//        'true' — and which swallows its own errors. order_addons is empty in
//        production today.
//
// A gate that consults only V2 therefore locks out every patient who has
// actually paid, tells the doctor "not purchased", and invites an operator to
// collect the EGP 400 a second time. A gate that consults only V1 misses a
// doctor-requested add-on released by an operator, which exists only in V2.
// Both have to be read, everywhere, which is why this lives in one file
// instead of being inlined at each call site.
//
// Precedence: an explicit V2 terminal state ('cancelled' / 'refunded') wins
// over a V1 purchase flag, because a cancellation is strictly newer
// information than the checkout record it cancels.

const { queryOne } = require('../../pg');
const { parseSelectedAddons } = require('../order_pricing');

const PRESCRIPTION_ADDON_ID = 'prescription';

/**
 * @param {Object} order  an orders / orders_active row (needs id, addons_json,
 *                        and ideally locked_currency)
 * @returns {Promise<{
 *   addon: Object|null,       // the order_addons row, when one exists
 *   status: string|null,      // its status, lowercased
 *   purchasedV1: boolean,     // addons_json says the patient bought it
 *   canWrite: boolean,        // the doctor may write one now
 *   isRequested: boolean,     // doctor asked, awaiting payment
 *   isFulfilled: boolean,
 *   isTerminal: boolean,      // cancelled or refunded
 *   priceEgp: number|null,    // what the patient was actually charged
 *   currency: string
 * }>}
 */
async function resolvePrescriptionAccess(order) {
  const orderId = order && order.id ? order.id : null;
  const sel = parseSelectedAddons(order || {});
  const currency = (order && order.locked_currency) || 'EGP';

  let addon = null;
  if (orderId) {
    try {
      addon = await queryOne(
        `SELECT * FROM order_addons
          WHERE order_id = $1 AND addon_service_id = $2
          LIMIT 1`,
        [orderId, PRESCRIPTION_ADDON_ID]
      );
    } catch (_) {
      addon = null;
    }
  }

  const status = addon ? String(addon.status || '').toLowerCase() : null;
  const isTerminal = status === 'cancelled' || status === 'refunded';
  const isFulfilled = status === 'fulfilled';
  const isRequested = status === 'pending';
  const purchasedV1 = !!sel.prescription;

  // Payable when either record says the money is in, unless V2 has explicitly
  // taken it back.
  const canWrite = !isTerminal && (purchasedV1 || status === 'paid' || isFulfilled);

  let priceEgp = null;
  if (Number(sel.prescription_price) > 0) priceEgp = Number(sel.prescription_price);
  else if (addon && Number(addon.price_at_purchase_egp) > 0) priceEgp = Number(addon.price_at_purchase_egp);

  return {
    addon, status, purchasedV1, canWrite, isRequested, isFulfilled, isTerminal,
    priceEgp, currency
  };
}

/**
 * The price to quote a patient who has NOT yet bought one.
 *
 * Reads service_regional_prices('addon_prescription') — the same table the
 * checkout reads (routes/payments.js buildAddonsJson and the settlement
 * fallback). addon_services.base_price_egp is a DIFFERENT catalogue holding a
 * DIFFERENT number (400 vs the regional row), and quoting from it would tell
 * the patient a price the checkout does not charge and compute the doctor's
 * commission off a figure nobody paid — the same two-catalogue drift FIX 8/9
 * corrected for video_consult.
 */
async function resolvePrescriptionQuote(currency) {
  const cur = String(currency || 'EGP').toUpperCase();
  try {
    const row = await queryOne(
      `SELECT tashkheesa_price FROM service_regional_prices
        WHERE service_id = 'addon_prescription' AND currency = $1 LIMIT 1`,
      [cur]
    );
    const n = row ? Number(row.tashkheesa_price) : 0;
    if (n > 0) return { amount: n, currency: cur };
  } catch (_) { /* fall through to the catalogue */ }

  try {
    const svc = await queryOne(
      `SELECT base_price_egp, doctor_commission_pct FROM addon_services
        WHERE id = $1 AND COALESCE(is_active, true) = true`,
      [PRESCRIPTION_ADDON_ID]
    );
    if (svc && Number(svc.base_price_egp) > 0) {
      return { amount: Number(svc.base_price_egp), currency: 'EGP' };
    }
  } catch (_) { /* no quote */ }

  return null;
}

async function prescriptionCommissionPct() {
  try {
    const svc = await queryOne(
      `SELECT doctor_commission_pct FROM addon_services WHERE id = $1`,
      [PRESCRIPTION_ADDON_ID]
    );
    return svc ? Number(svc.doctor_commission_pct) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  PRESCRIPTION_ADDON_ID,
  resolvePrescriptionAccess,
  resolvePrescriptionQuote,
  prescriptionCommissionPct
};
