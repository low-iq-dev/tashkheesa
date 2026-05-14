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

module.exports = { isEligibleForRefund };
