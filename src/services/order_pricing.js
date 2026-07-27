'use strict';

// Single source of truth for the patient-charged amount, in integer cents,
// INCLUDING selected add-ons.
//
// Two call sites must agree on this number byte-for-byte:
//   1. Paymob intention creation (routes/payments.js create-intention) — what
//      we ask Paymob to charge.
//   2. The Paymob webhook (routes/payments.js /callback) — verifying what
//      Paymob actually charged before marking the order paid (audit B5).
//
// Both route through owedCentsForOrder() so they can never drift. Prices are
// always sourced from what was persisted on the order at intention time —
// NEVER from the client. Per-line rounding (round each component to cents,
// then sum) avoids float drift and keeps intention/webhook identical.

// Convert a currency amount (e.g. 350 or 349.5) to integer cents.
function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

// Parse the persisted add-on selection from orders.addons_json (a TEXT column
// holding JSON) with a fallback to the legacy video_consultation_* columns.
// Returns booleans + the price locked at selection time (never client-supplied).
function parseSelectedAddons(order) {
  const sel = {
    video_consultation: false,
    prescription: false,
    video_consultation_price: 0,
    prescription_price: 0
  };
  if (!order) return sel;

  let json = order.addons_json;
  if (typeof json === 'string') {
    try { json = JSON.parse(json); } catch (_) { json = null; }
  }
  if (json && typeof json === 'object') {
    sel.video_consultation = !!json.video_consultation;
    sel.prescription = !!json.prescription;
    sel.video_consultation_price = Number(json.video_consultation_price) || 0;
    sel.prescription_price = Number(json.prescription_price) || 0;
  }

  // Legacy fallback: orders created before addons_json carried the selection
  // still have the video flag/price on dedicated columns.
  if (!sel.video_consultation && order.video_consultation_selected) {
    sel.video_consultation = true;
    if (!sel.video_consultation_price) {
      sel.video_consultation_price = Number(order.video_consultation_price) || 0;
    }
  }
  return sel;
}

// The amount owed for an order, in integer cents = base price + each selected
// add-on's locked price. This is exactly what Paymob must charge.
function owedCentsForOrder(order) {
  let cents = toCents(order && order.price);
  const sel = parseSelectedAddons(order);
  if (sel.video_consultation) cents += toCents(sel.video_consultation_price);
  if (sel.prescription) cents += toCents(sel.prescription_price);
  return cents;
}

module.exports = { toCents, parseSelectedAddons, owedCentsForOrder };
