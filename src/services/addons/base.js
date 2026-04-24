'use strict';

// Base class for every add-on service. Subclasses live alongside this file
// (video_consult.js, prescription.js). See
// docs/architecture/addon_service_abstraction.md §2.2 for the full interface.
//
// Subclasses declare id / type / hasLifecycle as static fields and override
// the five lifecycle hooks + two render hooks. The default implementations
// here all throw so a misconfigured subclass fails loudly at test time.

class AddonService {
  /** @type {string} — matches addon_services.id */
  static id = null;
  /** @type {string} — matches addon_services.type */
  static type = null;
  /** @type {boolean} — mirror of addon_services.has_lifecycle */
  static hasLifecycle = false;

  /**
   * Patient has paid. Insert the order_addons row (or update if already
   * present for this order+service pair) and perform any addon-specific
   * setup that can run without the doctor. Does NOT notify the doctor.
   *
   * Contract:
   *   - Returns the inserted/updated order_addons row.
   *   - Locks price_at_purchase_* and doctor_commission_pct_at_purchase
   *     from the addon_services registry snapshot.
   *   - For has_lifecycle=false addons (SLA), leaves status='fulfilled'
   *     immediately (no doctor step needed).
   *   - For has_lifecycle=true addons (video, prescription), leaves
   *     status='paid' and waits for onFulfill.
   *
   * @param {Object} params
   * @param {Object} params.order         - orders row
   * @param {Object} params.addonService  - addon_services row
   * @param {string} params.currency      - 'EGP' | 'SAR' | ...
   * @param {import('pg').PoolClient} [params.client] - optional transactional client
   * @returns {Promise<Object>} order_addons row
   */
  async onPurchase({ order, addonService, currency, client }) {
    throw new Error(`${this.constructor.name}.onPurchase not implemented`);
  }

  /**
   * Doctor has completed the addon-specific step.
   * For SLA (hasLifecycle=false) this is a no-op — onPurchase already
   * marks status='fulfilled'.
   *
   * @param {Object} params
   * @param {Object} params.order
   * @param {Object} params.addon         - order_addons row
   * @param {Object} params.doctor        - users row (doctor)
   * @param {Object} [params.payload]     - addon-specific attachment data
   *                                         (e.g. { pdf_storage_key, text_body } for prescription;
   *                                         { call_duration_seconds } for video)
   * @returns {Promise<Object>} updated order_addons row
   */
  async onFulfill({ order, addon, doctor, payload, client }) {
    throw new Error(`${this.constructor.name}.onFulfill not implemented`);
  }

  /**
   * Case has been marked complete and addon was fulfilled.
   * Inserts the addon_earnings row. Idempotent — the UNIQUE constraint on
   * addon_earnings(order_addon_id) means calling this twice does not
   * duplicate the payout.
   *
   * For SLA addons, this is a no-op (SLA has commission_pct=0 and no
   * doctor payout event — the addon_earnings row would be meaningless).
   *
   * @param {Object} params
   * @param {Object} params.order
   * @param {Object} params.addon
   * @param {string} params.doctorId
   * @returns {Promise<Object|null>} inserted addon_earnings row, or null if no-op
   */
  async onComplete({ order, addon, doctorId, client }) {
    throw new Error(`${this.constructor.name}.onComplete not implemented`);
  }

  /**
   * Case completed but this addon was NOT fulfilled. Mark for refund.
   *   - order_addons.status         → 'refunded'
   *   - order_addons.refund_pending → true
   *   - order_addons.refunded_at    → NOW()
   * Logs an audit event `addon_refund_queued`.
   * Does NOT call Kashier — refund is manual per TODO.md.
   *
   * For SLA addons, this is a no-op (no doctor step to miss).
   *
   * @param {Object} params
   * @param {Object} params.order
   * @param {Object} params.addon
   * @returns {Promise<Object|null>} updated order_addons row, or null if no-op
   */
  async onRefund({ order, addon, client }) {
    throw new Error(`${this.constructor.name}.onRefund not implemented`);
  }

  /**
   * Return an HTML snippet (or { partial, locals } object) to render on
   * the patient-facing checkout/payment page. Pure function of addon
   * registry state — does not read order or addon-instance state.
   *
   * @param {Object} addonService - addon_services row
   * @param {Object} ctx          - { isAr, currency, ... }
   * @returns {string|{partial: string, locals: Object}}
   */
  renderPatientPrompt(addonService, ctx) {
    throw new Error(`${this.constructor.name}.renderPatientPrompt not implemented`);
  }

  /**
   * Return an HTML snippet (or { partial, locals }) to render on the
   * doctor's case detail page when THIS order has this addon attached.
   * Consumes order + addon instance state.
   *
   * @param {Object} order
   * @param {Object} addon
   * @param {Object} ctx
   */
  renderDoctorPrompt(order, addon, ctx) {
    throw new Error(`${this.constructor.name}.renderDoctorPrompt not implemented`);
  }
}

module.exports = AddonService;
