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
  }

  // AUDIT (2026-08-17, regression F8) — the price fallback used to be NESTED
  // inside the flag fallback above, so it only fired for an order whose
  // addons_json carried NO video flag at all. The pre-fix write path produced
  // `{"video_consultation": true}` with NO video_consultation_price key, which
  // takes the json branch (flag true, price 0) and then skipped the fallback
  // entirely — parsing as "selected, worth nothing". Those are exactly the rows
  // this whole helper was written to rescue: their refund ceiling
  // (refund_eligibility.maxRefundableEgp) came out short by the add-on value,
  // and so did every ratio computed against it. The fallback is therefore
  // keyed on the PRICE being missing, independent of where the flag came from.
  if (sel.video_consultation && !sel.video_consultation_price) {
    sel.video_consultation_price = Number(order.video_consultation_price) || 0;
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

// ─── AUDIT-ADDONS-IN-ADMIN (2026-08-29) — the SQL mirror of owedCentsForOrder ─
//
// WHY THIS EXISTS. Every admin/Command money surface derived its "grand total"
// from `orders.total_price_with_addons`:
//
//     COALESCE(o.total_price_with_addons, o.price)
//
// That column is READ in 35 places across src/ and WRITTEN in none — there is no
// INSERT or UPDATE that sets it anywhere in the codebase, and it is NULL on
// every row in production. So the expression collapsed to `o.price` and the
// add-ons were invisible: the case detail showed EGP 1600 on an order the
// patient was charged 1600 + a 300 EGP prescription for, and the refund sheet —
// which caps on that number — refused to return what was actually taken.
//
// The real charge is owedCentsForOrder() above, the number routes/payments.js
// asks Paymob for and the number the webhook verifies. This is that function
// transcribed into SQL, for the places that must AGGREGATE it (the collected
// today/MTD tiles, the refund-rate denominator) and cannot call into JS.
//
// KEEP THE TWO IN LOCKSTEP. Same inputs, same order, same fallbacks:
//   price + (video ? video_price : 0) + (prescription ? prescription_price : 0)
// including the legacy fallbacks parseSelectedAddons carries — the flag from
// orders.video_consultation_selected when addons_json does not set it, and the
// price from orders.video_consultation_price when addons_json has the flag but
// no price (the pre-fix writer produced exactly that shape).
//
// EVERY read is defensive because addons_json is a TEXT column with no CHECK:
//   * `IS JSON OBJECT` (PG16+) gates the ::jsonb cast, so ONE malformed legacy
//     row cannot make the cast throw and take the whole money screen down with
//     it — the same failure mode the /errors endpoint documents for its
//     `context` column.
//   * booleans are compared as TEXT rather than cast, and numbers are matched
//     against a numeric regex before casting, so a hand-edited value degrades
//     to "not selected" / 0 instead of raising.
// Rounding is per line (ROUND(...,2) on each component, then sum), matching
// toCents()'s per-line rounding, so the two cannot differ by a piastre.
//
// @param {string} p column prefix — 'o.' when the query aliases the table, ''
//                   when it does not. NEVER user input; callers pass a literal.
function chargedEgpSql(p) {
  const c = p || '';
  const J = `(CASE WHEN ${c}addons_json IS JSON OBJECT THEN ${c}addons_json::jsonb ELSE '{}'::jsonb END)`;
  const flag = (key) => `COALESCE(LOWER(${J} ->> '${key}') IN ('true','t','1'), false)`;
  const num = (key) => `(CASE WHEN (${J} ->> '${key}') ~ '^-?[0-9]+(\\.[0-9]+)?$'`
    + ` THEN (${J} ->> '${key}')::numeric ELSE 0 END)`;
  // Legacy fallbacks, mirroring parseSelectedAddons: the flag can come from the
  // dedicated column, and the price falls back whenever addons_json carries no
  // usable price for a selected video add-on.
  const videoSelected = `(${flag('video_consultation')} OR COALESCE(${c}video_consultation_selected, false))`;
  const videoPrice = `COALESCE(NULLIF(${num('video_consultation_price')}, 0),`
    + ` COALESCE(${c}video_consultation_price, 0)::numeric)`;
  return `(ROUND(COALESCE(${c}price, 0)::numeric, 2)`
    + ` + CASE WHEN ${videoSelected} THEN ROUND(${videoPrice}, 2) ELSE 0 END`
    + ` + CASE WHEN ${flag('prescription')} THEN ROUND(${num('prescription_price')}, 2) ELSE 0 END)`;
}

// The EGP a patient was charged for one order row — owedCentsForOrder in the
// currency unit the admin payloads speak. Single place to round, so a row and
// the tile above it can never differ by a piastre.
function chargedEgpForOrder(order) {
  return Math.round(owedCentsForOrder(order)) / 100;
}

module.exports = {
  toCents,
  parseSelectedAddons,
  owedCentsForOrder,
  chargedEgpForOrder,
  chargedEgpSql,
};
