'use strict';

// services/refund_closure.js
//
// AUDIT 2026-08-17 — refunding a case did not close the case.
//
// POST /superadmin/refunds/:id/mark-paid updated the `refunds` table, wrote an
// audit event, notified the patient and recomputed the doctor's earnings. It
// never touched `orders`. Approve and deny did not either.
//
// Observed on live production data: order demo-order-in-progress-001 was
// refunded in full (EGP 1250.00, reason='operator_refund', status='paid') and
// still carried status='in_progress', payment_status='paid', completed_at=NULL
// and a deadline_at three months in the past. Consequences, all real:
//
//   * it counted as an active case in every KPI
//   * it occupied one of its doctor's four concurrent case slots
//   * it stayed eligible for reassignment
//   * the patient's payment still read "paid"
//   * it sat in the Command app's "NEEDS ACTION NOW" card permanently, because
//     that query asks only for active + past-deadline and has no concept of a
//     refund
//
// This module is the missing writer.
//
// ─── Partial refunds must NOT close the case ────────────────────────────────
//
// This is the important subtlety. services/sla_breach.js issues an automatic
// refund of the URGENCY UPLIFT ONLY when a case breaches — reason='sla_breach'.
// The patient keeps waiting and the doctor still owes them a report. Closing
// the case on that refund would abandon a patient who has paid for the base
// service and is still owed it.
//
// So closure is decided by ARITHMETIC, not by reason: we close only when the
// total of refunds actually PAID covers what the patient was charged. A
// breach's uplift refund never reaches that threshold; a full operator or
// patient-request refund does. If a breach refund is later topped up to the
// full amount, the sum crosses the line and the case closes then — which is
// the correct behaviour and falls out of the arithmetic for free.

const { queryOne, execute } = require('../pg');
const { logErrorToDb } = require('../logger');
// AUDIT-2026-08-22 (M2): the closure ceiling MUST be the same number
// applyRefundedPaymentStatus uses, and the tolerance MUST be the same constant.
// See the "Ceiling" note above closeOrderIfFullyRefunded.
const { maxRefundableEgp } = require('./refund_eligibility');
const { FULL_REFUND_EPSILON_CENTS } = require('./admin_refund_mark_paid');

// Money in this system is EGP with 2 decimal places. Compare in piastres to
// avoid float drift making a full refund look like it is one hundredth short.
function toPiastres(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// ─── Ceiling: ONE definition, shared with the payment_status writer ─────────
//
// AUDIT-2026-08-22 (M2, P0). This module used `orders.price` as "the amount
// charged". `price` EXCLUDES the add-ons (video consultation, prescription)
// that create-intention priced into the Paymob charge, so the two writers that
// run back to back on the web mark-paid path
// (routes/superadmin.js: applyRefundedPaymentStatus, then this) measured the
// same refund against two different ceilings and disagreed:
//
//   invoice 1800 (1000 case + 800 add-ons), operator refunds 1000
//     applyRefundedPaymentStatus: 1000 < 1800  → partial, order stays 'paid' ✓
//     closeOrderIfFullyRefunded:  1000 >= 1000 → status='REFUNDED',
//                                 payment_status='refunded'                 ✗
//
// The second write force-closed a case the patient is still owed a report on,
// pulled it out of the doctor pool, and erased the whole 1800 from collected
// revenue (every reporting query filters payment_status IN ('paid','captured')).
//
// maxRefundableEgp is the single source of truth for "what the gateway charged"
// (price + the add-ons locked at intention time, with base_price + uplift kept
// only as a legacy reconstruction). FULL_REFUND_EPSILON_CENTS is imported from
// the same module as the other writer so a rounding piastre can never split
// them again.

/**
 * Close an order if the refunds paid against it now cover the amount charged.
 *
 * Idempotent and non-throwing: it is called from the refund mark-paid path,
 * where a failure here must never leave a patient's refund unrecorded. Any
 * problem is logged to error_logs and reported in the return value.
 *
 * @param {string} orderId
 * @param {object} [opts]
 * @param {string} [opts.actorUserId] superadmin who triggered the refund
 * @returns {Promise<{closed: boolean, skipped?: string, refundedTotal?: number, charged?: number}>}
 */
async function closeOrderIfFullyRefunded(orderId, opts) {
  const options = opts || {};
  try {
    if (!orderId) return { closed: false, skipped: 'no_order_id' };

    const order = await queryOne(
      // include-deleted-ok: a targeted read by primary key on the refund path.
      // If an order was soft-deleted while a refund against it was still in
      // flight, we want to close it anyway rather than silently skip it and
      // leave the money state inconsistent — orders_active would hide it.
      // AUDIT-2026-08-22 (M2): projection widened to everything
      // maxRefundableEgp reads — it was `price` alone, which is the case fee
      // WITHOUT add-ons. Same column list as
      // admin_refund_mark_paid.applyRefundedPaymentStatus.
      `SELECT id, status, payment_status, completed_at,
              price, base_price, urgency_uplift_amount, addons_json,
              video_consultation_selected, video_consultation_price
         FROM orders
        WHERE id = $1`,
      // include-deleted-ok: deliberately `orders`, not `orders_active`. If a
      // case was soft-deleted while a refund was in flight we still want to
      // close it out rather than skip it and leave the money state
      // inconsistent — orders_active would hide it. (Marker restored
      // 2026-08-22: the M2 rewrite replaced the original comment block and
      // dropped it, turning tests/lint/orders-table-readers-allowlist red.)
      [orderId]
    );
    if (!order) return { closed: false, skipped: 'order_not_found' };

    // Already terminal — nothing to do. Checked by value rather than via
    // isTerminalStatus so this module stays free of the lifecycle import cycle
    // (case_lifecycle -> services -> case_lifecycle).
    const current = String(order.status || '').toLowerCase();
    if (current === 'refunded' || current === 'cancelled') {
      return { closed: false, skipped: 'already_terminal' };
    }

    // What has actually been paid back. Only status='paid' counts: an
    // approved-but-unpaid refund is a promise, not a repayment, and the money
    // has not left the account yet.
    const totals = await queryOne(
      `SELECT COALESCE(SUM(COALESCE(amount_egp, approved_amount, requested_amount, 0)), 0) AS refunded
         FROM refunds
        WHERE order_id = $1 AND status = 'paid'`,
      [orderId]
    );

    const refundedPt = toPiastres(totals && totals.refunded);
    // AUDIT-2026-08-22 (M2): was toPiastres(order.price) — see the ceiling note
    // above. maxRefundableEgp already rounds to 2dp; toPiastres just converts.
    const chargedPt = toPiastres(maxRefundableEgp(order));

    // A zero or unknown charge cannot be "fully refunded" — refusing to close
    // here is the safe direction: it leaves the case visible rather than
    // silently closing something whose price we could not read. Direction
    // deliberately unchanged by the M2 fix.
    if (chargedPt <= 0) {
      return { closed: false, skipped: 'no_charge_recorded', refundedTotal: refundedPt / 100 };
    }
    // AUDIT-2026-08-22 (M2): the epsilon is the SAME constant
    // applyRefundedPaymentStatus tests with, in the same direction, so the two
    // writers cannot land on opposite sides of a rounding piastre.
    if (refundedPt < chargedPt - FULL_REFUND_EPSILON_CENTS) {
      // The ordinary partial case — an SLA breach uplift refund lands here.
      //
      // ── AUDIT-2026-08-22 (R9, P2): STATE THE CONSEQUENCE ────────────────
      //
      // This branch is correct per the module's intent (a partial refund must
      // not abandon a patient who is still owed a report), but the M2 ceiling
      // change gave it a new and much less obvious failure mode that an
      // operator has to be told about:
      //
      //   Invoice 1800 = 1000 case fee + 800 video add-on. The operator's
      //   intent is "refund the case, the patient is not getting a report".
      //   They refund 1000. 1000 < 1800, so NOTHING closes: the order stays
      //   status='in_progress'/'paid', keeps occupying one of its doctor's
      //   concurrent slots, stays eligible for reassignment, stays in the
      //   Command app's NEEDS ACTION card and in every revenue KPI — with its
      //   entire case fee already returned. That is exactly the live-data
      //   defect at the top of this file, re-created by a correct partial.
      //
      // There is no safe way to infer intent here: the `refunds` table has no
      // line items and no scope column (see the same note in
      // earnings_writer.recomputeOnRefund), so "1000 of 1800" is genuinely
      // ambiguous between "the case fee" and "most of the invoice". Guessing
      // would close cases patients are still owed reports on — strictly worse
      // than leaving them open and visible.
      //
      // Two things narrow it in practice, and both are already in place:
      //   1. maxRefundableEgp now excludes a CONSUMED video add-on
      //      (services/refund_eligibility.js, R5). On the common shape of this
      //      invoice — the patient booked the consultation — the ceiling IS
      //      1000, so the 1000 refund closes the case correctly and this
      //      branch is never reached.
      //   2. Topping the refund up to the full amount closes the case then,
      //      which falls out of the arithmetic for free.
      //
      // HAND-OFF (refunds owner): the real fix is scope on the refund form —
      // an operator marking a refund 'case fee, no report owed' should close
      // the case regardless of arithmetic, and the same flag already has a
      // waiting consumer in recomputeOnRefund's `{ scope: 'addon' }` opt-in.
      // Until then, an operator who has refunded the case fee on a
      // multi-line invoice MUST also close the case by hand.
      return {
        closed: false,
        skipped: 'partial_refund',
        refundedTotal: refundedPt / 100,
        charged: chargedPt / 100
      };
    }

    // Full refund. Close the case.
    //
    // Written as a single guarded UPDATE rather than via case_lifecycle's
    // transitionCase because this runs inside the refund request and must not
    // be able to throw a transition error over money that has already moved.
    // The WHERE clause carries the idempotency: a concurrent second call
    // updates nothing.
    const result = await execute(
      `UPDATE orders
          SET status = 'REFUNDED',
              payment_status = 'refunded',
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
          AND LOWER(COALESCE(status, '')) NOT IN ('refunded', 'cancelled')`,
      [orderId]
    );

    if (!result || result.rowCount === 0) {
      return { closed: false, skipped: 'raced' };
    }

    // Timeline entry, so the patient's case history explains why it ended.
    try {
      await execute(
        `INSERT INTO order_events (order_id, label, at, actor_user_id, actor_role, meta)
         VALUES ($1, 'CASE_REFUNDED_CLOSED', NOW(), $2, 'superadmin', $3)`,
        [
          orderId,
          options.actorUserId || null,
          JSON.stringify({
            refunded_total: refundedPt / 100,
            charged: chargedPt / 100
          })
        ]
      );
    } catch (e) {
      // The close is the load-bearing part; the timeline row is not worth
      // failing it for. Surfaced rather than swallowed.
      logErrorToDb(e, {
        context: 'refund_closure.timeline_event',
        orderId: orderId,
        category: 'refund'
      });
    }

    return {
      closed: true,
      refundedTotal: refundedPt / 100,
      charged: chargedPt / 100
    };
  } catch (err) {
    logErrorToDb(err, {
      context: 'refund_closure.closeOrderIfFullyRefunded',
      orderId: orderId,
      category: 'refund'
    });
    return { closed: false, skipped: 'error' };
  }
}

module.exports = { closeOrderIfFullyRefunded, _toPiastres: toPiastres };
