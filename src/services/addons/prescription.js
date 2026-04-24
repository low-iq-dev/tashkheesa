'use strict';

// PrescriptionAddon
//
// Patient-requested digital prescription.
//   - onPurchase: writes order_addons row at status='paid'. Doctor isn't
//     notified yet — they see the prescription card on the case-detail
//     page when they open the case for review.
//   - onFulfill: doctor attached a PDF and/or entered text. Stored in
//     metadata_json as { pdf_storage_key, text_body, attached_at,
//     attached_by }. Transitions status to 'fulfilled'.
//   - onComplete: case is marked complete and addon is fulfilled → insert
//     addon_earnings row at 80% of locked price (per §0 of the design
//     doc: add-ons pay the doctor 80%).
//   - onRefund: case is marked complete without attachment → status =
//     'refunded', refund_pending = true. Kashier refund is manual per
//     TODO.md.

const AddonService = require('./base');
const { resolveAddonPrice } = require('./pricing');
const { queryOne, execute } = require('../../pg');

class PrescriptionAddon extends AddonService {
  static id = 'prescription';
  static type = 'prescription';
  static hasLifecycle = true;

  async onPurchase({ order, addonService, currency = 'EGP' }) {
    const resolved = await resolveAddonPrice(PrescriptionAddon.id, currency);
    if (!resolved) throw new Error('prescription addon is not active');

    const row = await queryOne(
      `INSERT INTO order_addons (
         order_id, addon_service_id, status,
         price_at_purchase_egp, price_at_purchase_currency, price_at_purchase_amount,
         doctor_commission_pct_at_purchase,
         metadata_json
       ) VALUES ($1, $2, 'paid', $3, $4, $5, $6, '{}'::jsonb)
       ON CONFLICT (order_id, addon_service_id) DO UPDATE
         SET status = order_addons.status
       RETURNING *`,
      [order.id, PrescriptionAddon.id,
       resolved.baseEgp, resolved.currency, resolved.amount, resolved.commissionPct]
    );
    return row;
  }

  async onFulfill({ order, addon, doctor, payload = {} }) {
    // A fulfillment requires AT LEAST one of pdf_storage_key or text_body.
    // Caller (the doctor's attach endpoint) is responsible for validating
    // the payload before calling here.
    const pdfKey   = payload.pdf_storage_key ? String(payload.pdf_storage_key) : null;
    const textBody = payload.text_body ? String(payload.text_body) : null;
    if (!pdfKey && !textBody) {
      throw new Error('prescription.onFulfill requires pdf_storage_key or text_body');
    }

    const nextMeta = Object.assign({}, addon.metadata_json || {}, {
      pdf_storage_key: pdfKey,
      text_body:       textBody,
      attached_at:     new Date().toISOString(),
      attached_by:     doctor ? doctor.id : (payload.attached_by || null)
    });

    const row = await queryOne(
      `UPDATE order_addons
          SET status        = 'fulfilled',
              fulfilled_at  = NOW(),
              metadata_json = $2::jsonb
        WHERE id = $1
      RETURNING *`,
      [addon.id, JSON.stringify(nextMeta)]
    );
    return row;
  }

  async onComplete({ order, addon, doctorId }) {
    if (addon.status !== 'fulfilled') {
      // Unfulfilled prescription → caller should route to onRefund instead.
      // Hard-refusing here prevents accidental commission payout.
      return null;
    }
    const gross  = Number(addon.price_at_purchase_egp);
    const pct    = Number(addon.doctor_commission_pct_at_purchase);
    const earned = Math.round(gross * pct / 100);
    const row = await queryOne(
      `INSERT INTO addon_earnings
         (order_addon_id, doctor_id, gross_amount_egp, commission_pct, earned_amount_egp, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (order_addon_id) DO UPDATE
         SET status = addon_earnings.status
       RETURNING *`,
      [addon.id, doctorId, gross, pct, earned]
    );
    await execute(
      `UPDATE order_addons SET doctor_commission_amount_egp = $1 WHERE id = $2`,
      [earned, addon.id]
    );
    return row;
  }

  async onRefund({ order, addon }) {
    if (addon.status === 'fulfilled') {
      // Fulfilled prescriptions aren't refundable through this path. If
      // an admin wants to refund a completed prescription, that's a
      // separate administrative action.
      return null;
    }
    const row = await queryOne(
      `UPDATE order_addons
          SET status         = 'refunded',
              refund_pending = true,
              refunded_at    = NOW()
        WHERE id = $1
      RETURNING *`,
      [addon.id]
    );
    return row;
  }

  renderPatientPrompt(addonService, ctx) {
    const isAr = !!(ctx && ctx.isAr);
    const title = isAr ? addonService.name_ar : addonService.name_en;
    const desc  = isAr ? (addonService.description_ar || '') : (addonService.description_en || '');
    return { partial: 'addons/checkbox_patient', locals: { addon: addonService, title, desc, isAr } };
  }

  renderDoctorPrompt(order, addon, ctx) {
    const isAr = !!(ctx && ctx.isAr);
    return { partial: 'addons/prescription_card_doctor', locals: { order, addon, isAr } };
  }
}

module.exports = PrescriptionAddon;
