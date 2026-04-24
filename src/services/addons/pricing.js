'use strict';

// Shared pricing resolver for every add-on.
//
// Replaces the scattered per-addon lookups across payments.js, patient.js,
// and video.js with a single source of truth. Reads from the
// `addon_services` registry:
//   - prices_json for a per-currency override, if present
//   - base_price_egp otherwise
//
// Returns the resolved price plus the base EGP amount — callers are
// expected to store all three on the order_addons row at purchase time
// so future FX drift never touches locked-in historical amounts.

const { queryOne } = require('../../pg');

/**
 * @typedef {Object} ResolvedAddonPrice
 * @property {string} addonServiceId
 * @property {string} currency          - the resolved currency, upper-cased
 * @property {number} amount            - amount in that currency (integer whole units)
 * @property {number} baseEgp           - base_price_egp snapshot (integer EGP)
 * @property {number} commissionPct     - doctor_commission_pct at purchase time
 */

/**
 * Resolve the price for an addon in a given currency.
 * Looks up `addon_services` by id, reads prices_json or falls back to
 * base_price_egp. `currency` defaults to EGP. Never throws on unknown
 * currency; falls back to EGP and emits a console.warn for observability.
 *
 * @param {string} addonServiceId
 * @param {string} [currency='EGP']
 * @returns {Promise<ResolvedAddonPrice|null>} null if the addon is not found or inactive
 */
async function resolveAddonPrice(addonServiceId, currency = 'EGP') {
  const row = await queryOne(
    `SELECT id, base_price_egp, prices_json, doctor_commission_pct, is_active
       FROM addon_services
      WHERE id = $1`,
    [addonServiceId]
  );
  if (!row) return null;
  if (!row.is_active) return null;

  const cur = String(currency || 'EGP').toUpperCase();
  const prices = row.prices_json || {};
  let amount;
  let resolvedCurrency = cur;
  if (Object.prototype.hasOwnProperty.call(prices, cur) && Number.isFinite(Number(prices[cur]))) {
    amount = Math.round(Number(prices[cur]));
  } else if (cur === 'EGP') {
    amount = Math.round(Number(row.base_price_egp));
  } else {
    // Unknown currency. Fall back to EGP so the caller still gets a number
    // and can decide how to present it. Not an error — but worth a log.
    console.warn(
      '[addon-pricing] currency ' + cur + ' not in prices_json for ' +
      addonServiceId + '; falling back to EGP=' + row.base_price_egp
    );
    resolvedCurrency = 'EGP';
    amount = Math.round(Number(row.base_price_egp));
  }

  return {
    addonServiceId: row.id,
    currency: resolvedCurrency,
    amount,
    baseEgp: Math.round(Number(row.base_price_egp)),
    commissionPct: Math.round(Number(row.doctor_commission_pct))
  };
}

/**
 * Resolve prices for the full catalogue (active rows only), in a chosen
 * currency. Used by the patient checkout page to render the addon menu.
 * @param {string} [currency='EGP']
 * @returns {Promise<ResolvedAddonPrice[]>}
 */
async function resolveCataloguePrices(currency = 'EGP') {
  const { queryAll } = require('../../pg');
  const rows = await queryAll(
    `SELECT id FROM addon_services WHERE is_active = true ORDER BY sort_order, id`
  );
  const out = [];
  for (const r of rows) {
    const resolved = await resolveAddonPrice(r.id, currency);
    if (resolved) out.push(resolved);
  }
  return out;
}

module.exports = { resolveAddonPrice, resolveCataloguePrices };
