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
  // NOTE (round 4): orders.locked_currency has no live writer — migration 080
  // records its only one as a retired 410 route, and payments.js reads
  // orders.currency instead. Checkout is EGP-only today so this always
  // resolves to EGP; kept reading locked_currency because that is the column
  // order_addons.price_at_purchase_currency is meant to mirror, and the
  // EGP/foreign split below is what will matter the day non-EGP charging is
  // switched on. Falls back to orders.currency so it is not simply dead.
  const currency = String((order && (order.locked_currency || order.currency)) || 'EGP').toUpperCase();

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

  // Review round 4 — addons_json is a basket, not a receipt, and
  // payment_status is not enough to turn it into one.
  //
  // routes/payments.js writes the add-on selection into addons_json at
  // create-intention time, BEFORE the patient pays. A patient who ticks
  // "Digital Prescription", reaches the gateway and abandons leaves
  // {"prescription":true} on the order forever.
  //
  // Round 3 tried to fix that by also requiring payment_status='paid'. That
  // does not work, and fails in the direction that costs money: with Paymob
  // not accepting the live credentials, POST /admin/orders/:id/mark-paid is
  // the ONLY payment path in use, and it flips payment_status with no
  // reference to addons_json or to how much was actually collected. So an
  // operator taking the base fee by bank transfer would silently unlock a
  // prescription nobody paid for — and completion would then mint an
  // addon_earnings row, creating a real payout liability against zero revenue.
  //
  // The only durable, gateway-independent evidence that the ADD-ON itself was
  // paid for is the 'Prescription add-on selected' order_event. That line is
  // written exclusively inside the payment callback's add-on block
  // (routes/payments.js), i.e. after the charged amount has been verified
  // against owedCentsForOrder, and unlike the order_addons row it is written
  // unconditionally rather than through the ADDON_SYSTEM_V2-gated
  // safeDualWrite. Requiring it is the same posture routes/video.js takes on
  // its own add-on ledger: fail safe means do not pay.
  const paymentStatus = String((order && order.payment_status) || '').toLowerCase();
  const orderIsPaid = paymentStatus === 'paid' || paymentStatus === 'captured';

  let settledV1 = false;
  if (orderId && sel.prescription && orderIsPaid) {
    try {
      const ev = await queryOne(
        `SELECT 1 AS ok FROM order_events
          WHERE order_id = $1 AND label = 'Prescription add-on selected'
          LIMIT 1`,
        [orderId]
      );
      settledV1 = !!ev;
    } catch (_) {
      // Fail closed. An unreadable audit log must not be read as a receipt.
      settledV1 = false;
    }
  }
  const purchasedV1 = settledV1;

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
  // Review round 4: these guards used to be `access &&`-conditional, so
  // calling with a null access skipped both and inserted a PAID add-on on an
  // order that had bought nothing. The function is exported; it must be safe
  // for any caller, not only the one that happens to pass a real access.
  if (!access) return null;
  if (access.addon) return access.addon;
  if (!access.needsBackfill) return null;

  const sel = parseSelectedAddons(order);
  let amount = Number(sel.prescription_price) || 0;
  let currency = String(order.locked_currency || order.currency || 'EGP').toUpperCase();
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
