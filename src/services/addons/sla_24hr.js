'use strict';

// Sla24hrAddon
//
// No lifecycle beyond the purchase. This is a Tashkheesa-only upsell:
//   - no doctor-side step
//   - no doctor payout event
//   - no refund path (the doctor can't "fail to fulfil" an SLA — if the
//     case is late, it's an SLA breach tracked by case_sla_worker.js,
//     handled separately)
//
// onPurchase flips orders.sla_hours and writes an order_addons row
// already at status='fulfilled'. All other hooks are no-ops.

const AddonService = require('./base');
const { resolveAddonPrice } = require('./pricing');
const { queryOne, execute } = require('../../pg');

class Sla24hrAddon extends AddonService {
  static id = 'sla_24hr';
  static type = 'sla_upgrade';
  static hasLifecycle = false;

  async onPurchase({ order, addonService, currency = 'EGP' }) {
    const resolved = await resolveAddonPrice(Sla24hrAddon.id, currency);
    if (!resolved) throw new Error('sla_24hr addon is not active');

    const row = await queryOne(
      `INSERT INTO order_addons (
         order_id, addon_service_id, status,
         price_at_purchase_egp, price_at_purchase_currency, price_at_purchase_amount,
         doctor_commission_pct_at_purchase,
         metadata_json, fulfilled_at
       ) VALUES ($1, $2, 'fulfilled', $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (order_id, addon_service_id) DO UPDATE
         SET status = order_addons.status
       RETURNING *`,
      [order.id, Sla24hrAddon.id,
       resolved.baseEgp, resolved.currency, resolved.amount, resolved.commissionPct,
       JSON.stringify({ new_sla_hours: 24 })]
    );

    // INTENTIONAL ABSTRACTION LEAK.
    //
    // The new add-on abstraction would ideally be the single source of
    // truth for SLA state (read from order_addons.metadata_json). But
    // src/case_sla_worker.js — the worker that fires SLA-breach alerts
    // on a timer — reads directly from orders.sla_hours today. Until
    // that worker is migrated, we MUST keep orders.sla_hours in sync
    // or SLA breach detection silently breaks.
    //
    // We accept this leak knowingly. The follow-up task is tracked in
    // /TODO.md: "Migrate case_sla_worker to read from
    // order_addons.metadata_json instead of orders.sla_hours." Once
    // that ships, this UPDATE can be removed and the abstraction is
    // clean again.
    await execute(
      `UPDATE orders SET sla_hours = 24 WHERE id = $1`,
      [order.id]
    );
    return row;
  }

  async onFulfill(/* params */) {
    // No doctor-side step. onPurchase already set status='fulfilled'.
    return null;
  }

  async onComplete(/* params */) {
    // Zero-commission addon; no doctor payout. Per design-doc §0 this is
    // a Tashkheesa-only fee.
    return null;
  }

  async onRefund(/* params */) {
    // SLA is "fulfilled at purchase". There is no unfulfilled state to
    // refund via this hook. SLA breaches (case took > 24h) are a
    // separate concern handled by case_sla_worker + admin dashboards.
    return null;
  }

  renderPatientPrompt(addonService, ctx) {
    const isAr = !!(ctx && ctx.isAr);
    const title = isAr ? addonService.name_ar : addonService.name_en;
    const desc  = isAr ? (addonService.description_ar || '') : (addonService.description_en || '');
    return { partial: 'addons/checkbox_patient', locals: { addon: addonService, title, desc, isAr } };
  }

  renderDoctorPrompt(order, addon, ctx) {
    const isAr = !!(ctx && ctx.isAr);
    // SLA is a badge on the case, not a prompt — just return a minimal
    // status snippet. The case detail page can omit this if it already
    // shows the SLA deadline elsewhere.
    return {
      partial: 'addons/sla_badge_doctor',
      locals: { order, addon, isAr, label: isAr ? 'أولوية 24 ساعة' : '24-hour priority' }
    };
  }
}

module.exports = Sla24hrAddon;
