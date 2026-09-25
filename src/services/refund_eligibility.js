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
const { owedCentsForOrder, toCents, parseSelectedAddons } = require('./order_pricing');

// Part B item 8 (2026-09-13) — the statuses that hold the one-open-refund
// slot (migration 107). 'paid' is deliberately NOT here any more: a paid
// PARTIAL refund used to block the remainder forever. What stops a second
// FULL refund now is the ceiling: remainingRefundableEgp below.
const OPEN_REFUND_STATUSES = Object.freeze(['pending', 'auto_approved', 'approved']);

const PRE_DOCTOR_ACCEPT = new Set(['PAID', 'ASSIGNED']);
const REVIEW_REQUIRED = new Set(['IN_REVIEW', 'REJECTED_FILES', 'REASSIGNED']);
const TERMINAL_ALREADY_REFUNDED = new Set(['CANCELLED', 'CANCELED', 'REFUNDED']);
const TERMINAL_NEVER_PAID = new Set(['EXPIRED_UNPAID', 'EXPIRED']);

/**
 * @param {Object} order - Canonical orders / orders_active row.
 * @param {string} [requestingUserId] - The user requesting the refund (the
 *   patient). Reserved for future use (e.g., per-user rate limiting); not
 *   currently consulted by the rules.
 * @param {Function} [exec] - (sql, params) => rows; injectable for tests.
 * @returns {Promise<{ eligible: boolean, reason: string, autoApprove: boolean, remainingEgp?: number }>}
 */
async function isEligibleForRefund(order, requestingUserId, exec) {
  const verdict = await statusVerdict(order);
  if (!verdict.eligible) return verdict;
  // Part B item 8 (2026-09-13) — a status that permits a refund is not enough
  // once partial refunds can be PAID and followed by another: the money left
  // to give back must be > 0. Only orders with an ESTABLISHABLE charge are
  // judged here — an order whose ceiling is 0 (no price recorded) keeps its
  // status verdict, and the request POST refuses it as amount_unavailable
  // with a reconciliation log, which is the honest outcome for a data fault
  // rather than "already refunded". Fail closed on a DB error, like the
  // breach branch below.
  if (!(maxRefundableEgp(order) > 0)) return verdict;
  let remaining;
  try {
    remaining = await remainingRefundableEgp(order, exec);
  } catch (e) {
    return { eligible: false, reason: 'eligibility_check_failed', autoApprove: false };
  }
  if (!(remaining > 0)) {
    return { eligible: false, reason: 'already_refunded_in_full', autoApprove: false, remainingEgp: 0 };
  }
  return Object.assign({}, verdict, { remainingEgp: remaining });
}

async function statusVerdict(order) {
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

// ── AUDIT-2026-08-22 (R5, P1): a CONSUMED video add-on is not refundable ────
//
// readVideoAddonEntitlement (routes/video.js) only checks payment_status='paid'
// — which stays 'paid' right up until a refund is marked paid — so a patient
// could book a video consultation out of their add-on, immediately request the
// auto-approved refund (status PAID / ASSIGNED is pre-doctor-accept and
// auto-approves), and walk away with the WHOLE 1800 EGP invoice back plus a
// live, funded appointment. If the consultation then happened, the platform
// paid the doctor 80% of money it had already returned.
//
// Two repairs were possible: cancel the appointment whenever the order is
// refunded, or take the consumed add-on out of the refund ceiling. This is the
// second, chosen because:
//
//   * It is COMPLETE. Every refund path — this file's callers are the patient
//     request form, services/admin_refund.js, routes/superadmin.js, the Command
//     app and services/refund_closure.js — bounds itself by maxRefundableEgp,
//     so one change closes all of them. The cancel-on-refund approach would
//     have to be wired into each create path separately, and two of those files
//     are outside this change's ownership; a half-wired version leaves the hole
//     open on the paths it misses.
//   * It is HONEST to the patient. They keep the consultation they paid for and
//     get every other piastre back. The alternative takes away a service they
//     have already booked in order to hand back money they would have to spend
//     again on the same thing.
//   * It is SYMMETRIC with the release path. The exclusion is keyed on
//     `video_consultation_consumed_by`, the same marker
//     services/video_addon_entitlement.js clears when a consultation is
//     cancelled, no-showed by the doctor, or auto-cancelled at 48h. The moment
//     the entitlement is handed back, the add-on becomes fully refundable
//     again — no separate bookkeeping.
//
// Note this deliberately does NOT touch owedCentsForOrder: that is the
// intention/webhook charge parity number and must never move.
//
// Residual, documented: a patient whose consultation has already been
// DELIVERED is in the same position — the add-on stays consumed, so it stays
// out of the ceiling. That is the correct answer for a delivered service.
function consumedVideoAddonCents(order) {
  if (!order) return 0;
  let json = order.addons_json;
  if (typeof json === 'string') {
    try { json = JSON.parse(json); } catch (_) { json = null; }
  }
  if (!json || typeof json !== 'object') return 0;
  if (!json.video_consultation_consumed_by) return 0;

  // Price it exactly the way owedCentsForOrder charged it, so the subtraction
  // cannot leave a stray piastre behind (parseSelectedAddons carries the legacy
  // video_consultation_price fallback for rows whose addons_json has the flag
  // but no price).
  const sel = parseSelectedAddons(order);
  if (!sel.video_consultation) return 0;
  return toCents(sel.video_consultation_price);
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

  // …minus a video consultation the patient has already claimed and still
  // holds. See consumedVideoAddonCents above.
  cents -= consumedVideoAddonCents(order);

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

// ── Part B item 8 (2026-09-13): the ceiling AFTER refunds already paid ──────
//
// Migration 083 closed the double-refund hole by letting a PAID refund row
// hold the one-refund-per-order slot forever. That made a paid PARTIAL refund
// (the SLA-breach uplift, a goodwill amount) lock the remainder out on every
// create path. Migration 107 gives the slot back to OPEN rows only, and these
// two helpers carry the invariant that actually matters — the sum of refunds
// never exceeds what was charged — into every create path instead.
//
// Only status='paid' rows count against the ceiling. An open row is a promise,
// not money, and the one-open-refund index guarantees there is at most one;
// a denied or cancelled row returned nothing.

/**
 * EGP already PAID back on an order. Same COALESCE chain as
 * admin_refund_mark_paid / refund_closure, so "the amount" means one thing.
 * @param {string} orderId
 * @param {Function} [exec] (sql, params) => rows. Defaults to the pool.
 */
async function paidRefundedEgp(orderId, exec) {
  if (!orderId) return 0;
  const run = typeof exec === 'function' ? exec : queryAll;
  const rows = await run(
    `SELECT COALESCE(SUM(COALESCE(amount_egp, approved_amount, requested_amount, 0)), 0) AS total
       FROM refunds
      WHERE order_id = $1 AND status = 'paid'`,
    [orderId]
  );
  const total = Number(rows && rows[0] && rows[0].total);
  return Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0;
}

/**
 * The remaining-refundable arithmetic, in cents, in ONE place: what the
 * write path (remainingRefundableEgp below) enforces and what the Command
 * API's batched list read shows must be the same expression, or the app's
 * refund sheet offers amounts the server 409s — the exact slice-0 finding
 * (#10) this exists to close.
 */
function remainingFromCeilingEgp(ceilingEgp, paidEgp) {
  const cents = Math.round((Number(ceilingEgp) || 0) * 100) - Math.round((Number(paidEgp) || 0) * 100);
  return cents > 0 ? cents / 100 : 0;
}

/**
 * paidRefundedEgp for a PAGE of orders in one query — the Command API's case
 * list would otherwise pay one refunds query per row. Same SUM, same COALESCE
 * chain, grouped. Returns a plain object { [orderId]: egp }; ids with no paid
 * refund are simply absent (read them as 0). Throws on a DB error so callers
 * fail closed, like remainingRefundableEgp.
 */
async function paidRefundedEgpByOrders(orderIds, exec) {
  const ids = (orderIds || []).map(String).filter(Boolean);
  if (!ids.length) return {};
  const run = typeof exec === 'function' ? exec : queryAll;
  const rows = await run(
    `SELECT order_id, COALESCE(SUM(COALESCE(amount_egp, approved_amount, requested_amount, 0)), 0) AS total
       FROM refunds
      WHERE order_id = ANY($1::text[]) AND status = 'paid'
      GROUP BY order_id`,
    [ids]
  );
  const out = {};
  (rows || []).forEach((r) => {
    const total = Number(r.total);
    out[String(r.order_id)] = Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0;
  });
  return out;
}

/**
 * What may STILL be refunded on an order: maxRefundableEgp minus everything
 * already paid back, floored at 0. This — not maxRefundableEgp — is the
 * ceiling every create path checks an amount against and the default a form
 * pre-fills. Throws on a DB error so callers fail closed (never open a refund
 * for a ceiling we could not establish).
 */
async function remainingRefundableEgp(order, exec) {
  if (!order || !order.id) return 0;
  const ceiling = maxRefundableEgp(order);
  const paid = await paidRefundedEgp(order.id, exec);
  return remainingFromCeilingEgp(ceiling, paid);
}

module.exports = {
  isEligibleForRefund,
  maxRefundableEgp,
  consumedVideoAddonCents,
  remainingRefundableEgp,
  remainingFromCeilingEgp,
  paidRefundedEgp,
  paidRefundedEgpByOrders,
  OPEN_REFUND_STATUSES
};
