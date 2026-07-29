'use strict';
/**
 * Money display helpers for the always-charge-EGP / local-price-display model.
 *
 * READ-ONLY over the stored charge: these NEVER change orders.price or
 * orders.currency (both are always EGP). They only decide how to PRESENT a stored
 * order — LOCAL-prominent for an international order (display_price/display_currency),
 * EGP for a domestic (EG) order (display_* NULL → renders exactly as before).
 *
 * Shared by every price surface (pay page, wizard, order review, dashboard,
 * receipt emails) so intl rendering can't drift between views.
 */

const { formatMoney } = require('./formatNumber');

// An order is "international" iff it carries a non-EGP display currency + price.
function isIntlOrder(order) {
  if (!order) return false;
  const dc = order.display_currency ? String(order.display_currency).toUpperCase() : '';
  return !!dc && dc !== 'EGP' && order.display_price != null;
}

// The PROMINENT price to show: LOCAL for intl, EGP for domestic. Never the charge
// authority — it's display only.
function primaryPrice(order) {
  if (isIntlOrder(order)) {
    return { amount: Number(order.display_price), currency: String(order.display_currency).toUpperCase() };
  }
  return { amount: Number(order && order.price) || 0, currency: (order && order.currency) || 'EGP' };
}

// The EGP amount actually charged (orders.price is ALWAYS EGP).
function egpCharge(order) {
  return Number(order && order.price) || 0;
}

// The disclosure line shown UNDER the prominent local price for intl orders.
// Returns null for domestic orders (nothing to disclose). lang: 'ar' | 'en'.
function chargeDisclosure(order, lang) {
  if (!isIntlOrder(order)) return null;
  const egp = formatMoney(egpCharge(order), 'EGP'); // e.g. "EGP 16,486"
  if (String(lang) === 'ar') {
    return 'يُحصَّل المبلغ بالجنيه المصري (≈ ' + egp + ') — يحوّله بنكك عند الدفع.';
  }
  return "You'll be billed in EGP (≈ " + egp + ') — your bank converts at checkout.';
}

module.exports = { isIntlOrder, primaryPrice, egpCharge, chargeDisclosure };
