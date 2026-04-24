'use strict';

// VideoConsultAddon
//
// Wraps the existing video_consult lifecycle behind the AddonService
// interface. Phase 2 — dormant behind ADDON_SYSTEM_V2; Phase 3 onward
// dual-writes alongside the bespoke video.js path.

const AddonService = require('./base');
const { resolveAddonPrice } = require('./pricing');
const { queryOne, execute } = require('../../pg');

class VideoConsultAddon extends AddonService {
  static id = 'video_consult';
  static type = 'video_consult';
  static hasLifecycle = true;

  async onPurchase({ order, addonService, currency = 'EGP' }) {
    const resolved = await resolveAddonPrice(VideoConsultAddon.id, currency);
    if (!resolved) throw new Error('video_consult addon is not active');

    // Idempotent UPSERT on (order_id, addon_service_id). If the patient
    // pays twice through the Paymob flow (retry), we keep the first row.
    const row = await queryOne(
      `INSERT INTO order_addons (
         order_id, addon_service_id, status,
         price_at_purchase_egp, price_at_purchase_currency, price_at_purchase_amount,
         doctor_commission_pct_at_purchase,
         metadata_json
       ) VALUES ($1, $2, 'paid', $3, $4, $5, $6, '{}'::jsonb)
       ON CONFLICT (order_id, addon_service_id) DO UPDATE
         SET status = order_addons.status  -- no-op; just returning the row
       RETURNING *`,
      [order.id, VideoConsultAddon.id,
       resolved.baseEgp, resolved.currency, resolved.amount, resolved.commissionPct]
    );
    return row;
  }

  async onFulfill({ order, addon, doctor, payload = {} }) {
    const nextMeta = Object.assign({}, addon.metadata_json || {}, {
      appointment_id:         payload.appointment_id || null,
      twilio_room:            payload.twilio_room || null,
      call_duration_seconds:  Number.isFinite(Number(payload.call_duration_seconds))
                                ? Math.round(Number(payload.call_duration_seconds))
                                : null,
      doctor_id:              doctor ? doctor.id : (payload.doctor_id || null),
      fulfilled_by:           doctor ? doctor.id : (payload.doctor_id || null)
    });

    const row = await queryOne(
      `UPDATE order_addons
          SET status       = 'fulfilled',
              fulfilled_at = NOW(),
              metadata_json = $2::jsonb
        WHERE id = $1
      RETURNING *`,
      [addon.id, JSON.stringify(nextMeta)]
    );
    return row;
  }

  async onComplete({ order, addon, doctorId }) {
    if (addon.status !== 'fulfilled') {
      // Safety: don't pay out on an unfulfilled add-on. The caller should
      // have gated on status already; double-check here.
      return null;
    }
    const gross = Number(addon.price_at_purchase_egp);
    const pct   = Number(addon.doctor_commission_pct_at_purchase);
    const earned = Math.round(gross * pct / 100);
    const row = await queryOne(
      `INSERT INTO addon_earnings
         (order_addon_id, doctor_id, gross_amount_egp, commission_pct, earned_amount_egp, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (order_addon_id) DO UPDATE
         SET status = addon_earnings.status  -- idempotent
       RETURNING *`,
      [addon.id, doctorId, gross, pct, earned]
    );
    // Lock the commission amount on the order_addons row too, so the
    // history is queryable without joining addon_earnings.
    await execute(
      `UPDATE order_addons SET doctor_commission_amount_egp = $1 WHERE id = $2`,
      [earned, addon.id]
    );
    return row;
  }

  async onRefund({ order, addon }) {
    if (addon.status === 'fulfilled') {
      // Don't refund a fulfilled video — the doctor already did the work.
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
    // Audit log via orders event_log if available — but audit.js lives
    // outside this module. Caller logs at the boundary.
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
    return { partial: 'addons/video_card_doctor', locals: { order, addon, isAr } };
  }
}

module.exports = VideoConsultAddon;
