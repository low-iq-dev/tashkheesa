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

// Money in this system is EGP with 2 decimal places. Compare in piastres to
// avoid float drift making a full refund look like it is one hundredth short.
function toPiastres(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

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
      `SELECT id, status, payment_status, price, completed_at
         FROM orders
        WHERE id = $1`,
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
    const chargedPt = toPiastres(order.price);

    // A zero or unknown charge cannot be "fully refunded" — refusing to close
    // here is the safe direction: it leaves the case visible rather than
    // silently closing something whose price we could not read.
    if (chargedPt <= 0) {
      return { closed: false, skipped: 'no_charge_recorded', refundedTotal: refundedPt / 100 };
    }
    if (refundedPt < chargedPt) {
      // The ordinary partial case — an SLA breach uplift refund lands here.
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
