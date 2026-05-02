/**
 * Wizard pricing — pure helper that builds the rich `pricing` object
 * the patient new-case wizard renders at Steps 4 + 5.
 *
 * Policy: docs/PAYOUT_AND_URGENCY_POLICY.md §2 + §6.
 *
 * For each of the three tiers (standard / vip / urgent) the helper
 * computes the multiplier-applied total + uplift portion in BOTH:
 *   - the patient's local currency (catalog row in their region)
 *   - EGP secondary lane (the canonical Egypt-region price)
 *
 * Math is delegated to `computeOrderPricing` (urgency_pricing.js)
 * so per-service multiplier overrides (services.vip_multiplier /
 * services.urgent_multiplier) are honored in one place.
 *
 * No DB calls. No I/O. Trivially testable.
 */

'use strict';

const { computeOrderPricing } = require('./urgency_pricing');

const TIERS = ['standard', 'vip', 'urgent'];

/**
 * @param {Object} args
 * @param {string} args.serviceName       Display name for Step 4 + Step 5
 * @param {number} args.localBase         Patient's local-currency catalog price
 * @param {number} args.egpBase           EGP catalog price (the secondary lane)
 * @param {string} args.localCurrency     ISO currency code (e.g., 'EGP', 'SAR')
 * @param {number=} args.vipMultiplier    services.vip_multiplier override
 * @param {number=} args.urgentMultiplier services.urgent_multiplier override
 * @returns {{
 *   serviceName: string,
 *   localCurrency: string,
 *   showSecondary: boolean,
 *   base: { local: number, egp: number },
 *   tiers: Object<string, { multiplier: number,
 *     total: { local: number, egp: number },
 *     uplift: { local: number, egp: number } }>
 * }}
 */
function buildWizardPricing(args) {
  const a = args || {};
  const serviceName = String(a.serviceName || '');
  const localBase = Number(a.localBase) || 0;
  const egpBase = Number(a.egpBase) || 0;
  const localCurrency = String(a.localCurrency || 'EGP').toUpperCase();
  const servicesRow = {
    vip_multiplier: a.vipMultiplier,
    urgent_multiplier: a.urgentMultiplier
  };

  const tiers = {};
  TIERS.forEach(function (tier) {
    const localR = computeOrderPricing({ basePrice: localBase, urgencyTier: tier, servicesRow });
    const egpR = computeOrderPricing({ basePrice: egpBase, urgencyTier: tier, servicesRow });
    tiers[tier] = {
      multiplier: localR.multiplier,
      total: { local: localR.totalPrice, egp: egpR.totalPrice },
      uplift: { local: localR.upliftAmount, egp: egpR.upliftAmount }
    };
  });

  return {
    serviceName: serviceName,
    localCurrency: localCurrency,
    showSecondary: localCurrency !== 'EGP',
    base: { local: localBase, egp: egpBase },
    tiers: tiers
  };
}

module.exports = { buildWizardPricing, TIERS };
