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

  // Review round 3 — addons_json is NOT proof of payment on its own.
  //
  // routes/payments.js writes the add-on selection into addons_json at
  // create-intention time, BEFORE the patient pays. A patient who ticks
  // "Digital Prescription", reaches the gateway and abandons leaves
  // {"prescription":true} on the order forever. If ops then marks the case
  // paid by hand — which does not run the webhook's add-on block — the flag is
  // there and no money for the add-on ever arrived. Trusting it alone would
  // tell the doctor "this patient has paid for a prescription" and give away
  // the product.
  //
  // So the V1 flag only counts on an order whose payment actually settled. An
  // order_addons row at 'paid' needs no such check: onPurchase only ever runs
  // from inside the payment callback.
  const paymentStatus = String((order && order.payment_status) || '').toLowerCase();
  const orderIsPaid = paymentStatus === 'paid' || paymentStatus === 'captured';
  const purchasedV1 = !!sel.prescription && orderIsPaid;

  // Payable when either record says the money is in, unless V2 has explicitly
  // taken it back.
  const canWrite = !isTerminal && (purchasedV1 || status === 'paid' || isFulfilled);

  let priceEgp = null;
  if (Number(sel.prescription_price) > 0) priceEgp = Number(sel.prescription_price);
  else if (addon && Number(addon.price_at_purchase_egp) > 0) priceEgp = Number(addon.price_at_purchase_egp);

  return {
    addon, status, purchasedV1, canWrite, isRequested, isFulfilled, isTerminal,
    priceEgp, currency,
    // True when the patient paid at checkout but no order_addons row exists —
    // the state the whole V1/V2 split produces. ensurePrescriptionAddonRow()
    // below is what closes it.
    needsBackfill: purchasedV1 && !addon
  };
}

/**
 * Materialise the order_addons row for a prescription bought at checkout.
 *
 * Review round 3 — without this the doctor delivers the prescription for free.
 *
 * The paywall accepts a V1 purchase (orders.addons_json), but fulfilment and
 * earnings both key off an order_addons row: prescription.onFulfill takes one
 * as an argument, onComplete refuses anything not 'fulfilled', and
 * addon_earnings is the ONLY place add-on revenue is recorded —
 * services/earnings_writer.js explicitly excludes add-ons from doctor_earnings.
 * That row is written solely by prescription.onPurchase through safeDualWrite,
 * which is a no-op when ADDON_SYSTEM_V2 is off. So on the V1-only path the
 * doctor would write the prescription, onFulfill would be skipped for want of
 * a row, and no commission would ever be inserted.
 *
 * Creating it here is bookkeeping, not billing: the money is already
 * collected and the price is the one locked on the order at checkout. Idempotent
 * via the unique index on (order_id, addon_service_id) — DO NOTHING, so it can
 * never downgrade a row a real onPurchase has already written.
 *
 * @returns {Promise<Object|null>} the order_addons row, or null
 */
async function ensurePrescriptionAddonRow(order, access) {
  if (!order || !order.id) return null;
  if (access && access.addon) return access.addon;
  if (access && !access.needsBackfill) return null;

  const sel = parseSelectedAddons(order);
  let amount = Number(sel.prescription_price) || 0;
  let currency = String(order.locked_currency || 'EGP').toUpperCase();
  if (amount <= 0) {
    const quote = await resolvePrescriptionQuote(currency);
    if (!quote) return null;
    amount = quote.amount;
    currency = quote.currency;
  }
  const pct = await prescriptionCommissionPct();
  // price_at_purchase_egp is the commission base in onComplete, so it must be
  // an EGP figure. A non-EGP order keeps its charged amount in
  // price_at_purchase_amount and takes the catalogue's EGP price here.
  let egpAmount = amount;
  if (currency !== 'EGP') {
    const egpQuote = await resolvePrescriptionQuote('EGP');
    egpAmount = egpQuote ? egpQuote.amount : 0;
  }

  try {
    await queryOne(
      `INSERT INTO order_addons (
         order_id, addon_service_id, status,
         price_at_purchase_egp, price_at_purchase_currency, price_at_purchase_amount,
         doctor_commission_pct_at_purchase, metadata_json
       ) VALUES ($1, $2, 'paid', $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (order_id, addon_service_id) DO NOTHING`,
      [
        order.id, PRESCRIPTION_ADDON_ID,
        egpAmount, currency, amount, pct,
        JSON.stringify({ backfilled_from: 'orders.addons_json', backfilled_at: new Date().toISOString() })
      ]
    );
  } catch (_) {
    return null;
  }

  try {
    return await queryOne(
      `SELECT * FROM order_addons WHERE order_id = $1 AND addon_service_id = $2 LIMIT 1`,
      [order.id, PRESCRIPTION_ADDON_ID]
    );
  } catch (_) {
    return null;
  }
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
  ensurePrescriptionAddonRow,
  resolvePrescriptionQuote,
  prescriptionCommissionPct
};
