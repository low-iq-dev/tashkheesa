/**
 * Refund eligibility — single source of truth for "can this case be
 * patient-refunded?" decisions.
 *
 * Theme 7b Phase 1 (2026-05-10).
 *
 * Used by:
 *   - The patient case page route handler (to decide whether to render
 *     the "Request refund" CTA).
 *   - The patient API endpoint POST /portal/patient/orders/:id/request-refund
 *     (to gate the create + decide whether to write status='pending'
 *     vs status='auto_approved').
 *   - The superadmin queue (defensive: highlight rows where autoApprove
 *     was true but the patient still got status='pending').
 *
 * Policy (per Ziad's Theme 7b §3-H + OQ-4 answer):
 *   - Unpaid case (payment_status NOT IN ('paid','captured')): not eligible.
 *   - Pre-doctor-accept (status PAID or ASSIGNED): eligible + auto-approve.
 *     Case never received service.
 *   - Mid-flight (status IN_REVIEW, REJECTED_FILES, REASSIGNED): eligible,
 *     review-required. Superadmin negotiates case-by-case.
 *   - COMPLETED: not eligible. Case fulfilled.
 *   - CANCELLED / REFUNDED: not eligible. Already refunded or no money to
 *     return.
 *   - EXPIRED_UNPAID / EXPIRED: not eligible. No money was ever taken.
 *   - SLA_BREACH (or legacy 'breached') with an existing refunds row whose
 *     reason='sla_breach': not eligible. The system already auto-refunded
 *     the urgency uplift via services/sla_breach.issueBreachRefund.
 *   - SLA_BREACH with no existing system refund (rare — Standard tier with
 *     no uplift to refund, or pre-Theme-7b drift): eligible, review-required.
 *   - REJECTED: not eligible.
 *   - Unknown status: fail-closed (not eligible).
 */

'use strict';

const { queryAll } = require('../pg');
const { owedCentsForOrder } = require('./order_pricing');

const PRE_DOCTOR_ACCEPT = new Set(['PAID', 'ASSIGNED']);
const REVIEW_REQUIRED = new Set(['IN_REVIEW', 'REJECTED_FILES', 'REASSIGNED']);
const TERMINAL_ALREADY_REFUNDED = new Set(['CANCELLED', 'CANCELED', 'REFUNDED']);
const TERMINAL_NEVER_PAID = new Set(['EXPIRED_UNPAID', 'EXPIRED']);

/**
 * @param {Object} order - Canonical orders / orders_active row.
 * @param {string} [requestingUserId] - The user requesting the refund (the
 *   patient). Reserved for future use (e.g., per-user rate limiting); not
 *   currently consulted by the rules.
 * @returns {Promise<{ eligible: boolean, reason: string, autoApprove: boolean }>}
 */
async function isEligibleForRefund(order, requestingUserId) {
  if (!order || !order.id) {
    return { eligible: false, reason: 'order_not_found', autoApprove: false };
  }

  // Must be paid to be refundable.
  const ps = String(order.payment_status || '').toLowerCase();
  if (ps !== 'paid' && ps !== 'captured') {
    return { eligible: false, reason: 'not_paid', autoApprove: false };
  }

  // Normalize status (canonical UPPER_CASE; legacy lowercase also supported).
  const status = String(order.status || '').toUpperCase();

  if (PRE_DOCTOR_ACCEPT.has(status)) {
    return { eligible: true, reason: 'pre_doctor_accept', autoApprove: true };
  }
  if (REVIEW_REQUIRED.has(status)) {
    return { eligible: true, reason: 'post_in_review_review_required', autoApprove: false };
  }
  if (status === 'COMPLETED') {
    return { eligible: false, reason: 'case_completed', autoApprove: false };
  }
  if (TERMINAL_ALREADY_REFUNDED.has(status)) {
    return { eligible: false, reason: 'already_refunded', autoApprove: false };
  }
  if (TERMINAL_NEVER_PAID.has(status)) {
    return { eligible: false, reason: 'expired_unpaid', autoApprove: false };
  }
  if (status === 'REJECTED') {
    return { eligible: false, reason: 'order_rejected', autoApprove: false };
  }
  if (status === 'SLA_BREACH' || status === 'BREACHED') {
    // Theme 14 — patient overrode the AI specialty recommendation under the
    // SLA-disclaimer modal at Step 3. The modal copy explicitly states
    // Tashkheesa carries no responsibility for delays from manual specialty
    // changes — SLA-breach refund eligibility is waived for this order
    // regardless of the breach state below. The flag is set by the Step 3
    // POST handler when patients submit with override=1.
    if (order.no_sla_refund_eligibility === true) {
      return { eligible: false, reason: 'patient_override_sla_waiver', autoApprove: false };
    }
    // Was the system already refunded? If so, the patient can't request
    // another refund of the same case.
    let existing = [];
    try {
      existing = await queryAll(
        "SELECT id FROM refunds WHERE order_id = $1 AND reason = 'sla_breach' LIMIT 1",
        [order.id]
      );
    } catch (e) {
      // Fail-closed on DB error — better to deny than to allow a duplicate
      // refund. The route handler logs the error separately.
      return { eligible: false, reason: 'eligibility_check_failed', autoApprove: false };
    }
    if (existing && existing.length > 0) {
      return { eligible: false, reason: 'already_refunded_via_breach', autoApprove: false };
    }
    // SLA breach on a Standard-tier case (no uplift refund issued) — patient
    // can still request a refund, but superadmin reviews.
    return { eligible: true, reason: 'sla_breach_no_system_refund', autoApprove: false };
  }
  // Unknown / drift status — fail-closed.
  return { eligible: false, reason: 'unknown_status', autoApprove: false };
}

/**
 * The maximum EGP that may be refunded for an order — i.e. everything the
 * patient was actually charged.
 *
 * AUDIT (2026-08-17): the two refund-ceiling call sites
 * (services/admin_refund.js and routes/superadmin.js) both computed
 *   base_price + urgency_uplift_amount
 * which is wrong twice over:
 *   1. It excludes the add-ons (video consultation, prescription) that
 *      create-intention priced into the Paymob charge — see
 *      services/order_pricing.owedCentsForOrder, the single source of truth
 *      for "what Paymob was asked to charge" and "what the webhook verified".
 *   2. Several INSERT paths never write orders.base_price, so those orders
 *      evaluated to a ceiling of 0 and were PERMANENTLY UNREFUNDABLE.
 *
 * Canonical invariant (migration 037_orders_base_price.sql §"Per
 * docs/PAYOUT_AND_URGENCY_POLICY.md §2"):
 *
 *     orders.base_price + orders.urgency_uplift_amount = orders.price
 *
 * so `orders.price` ALREADY contains the urgency uplift. Adding the uplift on
 * top of `price` would let an operator refund more than was collected, so the
 * primary path here is owedCentsForOrder(order) = price + selected add-ons —
 * literally the number the gateway charged. The base_price + uplift sum is used
 * only as a reconstruction fallback for legacy rows that carry no `price`.
 *
 * @param {Object} order - orders / orders_active row. Must include at least
 *   price, base_price, urgency_uplift_amount, addons_json and (for the legacy
 *   fallback) video_consultation_selected / video_consultation_price.
 * @returns {number} EGP, rounded to 2dp. 0 only when the order really has no
 *   money attached to it.
 */
function maxRefundableEgp(order) {
  if (!order) return 0;

  // price + every add-on locked on the order at intention time.
  let cents = owedCentsForOrder(order);

  const price = Number(order.price);
  if (!Number.isFinite(price) || price <= 0) {
    // Legacy / partial row with no canonical price: rebuild the main fee from
    // the snapshot columns. Safe to ADD here (rather than replace) because
    // owedCentsForOrder contributed 0 for the missing price and only the
    // add-on lines above.
    const base = Number(order.base_price) || 0;
    const uplift = Number(order.urgency_uplift_amount) || 0;
    cents += Math.round((base + uplift) * 100);
  }

  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.round(cents) / 100;
}

module.exports = { isEligibleForRefund, maxRefundableEgp };
