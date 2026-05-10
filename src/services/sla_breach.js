/**
 * SLA breach refund + earnings recalc.
 *
 * Per docs/PAYOUT_AND_URGENCY_POLICY.md §4.  When a tier-eligible order
 * passes its SLA deadline without completion, the patient gets the
 * full urgency uplift refunded and the doctor's earnings on this case
 * are recalculated as if the case were Standard tier (uplift share = 0).
 *
 * Hook sites:
 *   - src/sla_status.js enforceBreachIfNeeded()  (single-order path)
 *   - src/server.js     SLA sweep cron            (bulk path)
 *
 * Idempotency is critical — both sites may fire for the same order on
 * separate ticks, and the cron may re-run if a worker dies mid-job.
 * Two gates:
 *   1. Existing refunds row WHERE order_id = $ AND reason = 'sla_breach'
 *      → return { skipped: 'already_refunded' }.
 *   2. orders.urgency_uplift_amount <= 0 (already zeroed) → return
 *      { skipped: 'no_uplift_to_refund' }.
 *
 * Paymob actual-money refund is NOT wired here — Ziad's track lands
 * that separately.  This module records the local intent (refunds row)
 * and zeroes the uplift on the order so earnings displays read the
 * standard-tier amount.
 */

'use strict';

var { randomUUID } = require('crypto');
var { queryOne, execute } = require('../pg');
var { logErrorToDb } = require('../logger');

/**
 * @param {string} orderId
 * @returns {Promise<{
 *   refunded?: true, refundId?: string, amount?: number,
 *   skipped?: 'order_not_found' | 'no_uplift_to_refund' | 'already_refunded',
 *   refundId?: string
 * }>}
 */
async function issueBreachRefund(orderId) {
  if (!orderId) return { skipped: 'order_not_found' };

  var order = await queryOne(
    'SELECT id, urgency_uplift_amount, urgency_tier FROM orders_active WHERE id = $1',
    [orderId]
  );
  if (!order) return { skipped: 'order_not_found' };

  var uplift = Number(order.urgency_uplift_amount) || 0;
  if (uplift <= 0) {
    // Either Standard tier (no uplift) or already zeroed by a prior run.
    return { skipped: 'no_uplift_to_refund' };
  }

  var existing = await queryOne(
    "SELECT id FROM refunds WHERE order_id = $1 AND reason = 'sla_breach' LIMIT 1",
    [orderId]
  );
  if (existing && existing.id) {
    return { skipped: 'already_refunded', refundId: existing.id };
  }

  var refundId = randomUUID();
  // Theme 7b Phase 1: explicit status='paid' on insert. Migration 048
  // adds the workflow columns to refunds; system-generated SLA-breach
  // rows are paid-on-write semantically (the urgency uplift is zeroed
  // on the order at the same moment, which is the system's notion of
  // "the refund happened"). New columns paid_at/approved_amount/
  // requested_amount stay NULL on new system rows by design — the
  // patient-initiated workflow populates them; system rows have only
  // ever cared about the (id, order_id, amount_egp, reason, status)
  // identity. Backfill at migration 048 step (b) handles pre-Phase-1
  // rows.
  await execute(
    `INSERT INTO refunds
       (id, order_id, amount_egp, reason, refunded_at, refunded_by, paymob_refund_id, notes, status)
     VALUES ($1, $2, $3, 'sla_breach', NOW(), 'system', NULL, $4, 'paid')`,
    [
      refundId, orderId, uplift,
      'Auto-refund: SLA deadline passed without case completion (tier ' +
        (order.urgency_tier || 'unknown') + ')'
    ]
  );

  // Earnings recalc — zero the uplift on the order so the next read of
  // doctor earnings reflects the standard-tier base only.  The doctor's
  // main-case fee (services.doctor_fee absolute EGP) is unchanged; only
  // the upliftShare component falls to 0.
  await execute(
    'UPDATE orders SET urgency_uplift_amount = 0, updated_at = NOW() WHERE id = $1',
    [orderId]
  );

  // P0-FIN-1 site 3: recompute the doctor_earnings row with
  // upliftAmount=0. No-op + warning if no row exists (legacy / pre-wiring).
  try {
    var { recomputeOnBreach } = require('./earnings_writer');
    var r = await recomputeOnBreach(orderId);
    if (r && r.skipped === 'no_earnings_row') {
      console.warn('[earnings] breach recompute skipped — no earnings row for', orderId);
    }
  } catch (e) {
    logErrorToDb(e, { context: 'sla_breach.recomputeOnBreach', orderId: orderId });
  }

  // TODO(paymob): trigger Paymob actual-money refund of `uplift` against
  // the original payment.  Wired separately on Ziad's payments track.
  // When the call lands, populate refunds.paymob_refund_id with the
  // returned reference.

  return { refunded: true, refundId: refundId, amount: uplift };
}

/**
 * Best-effort wrapper that swallows + logs errors so callers (the SLA
 * sweep cron, the single-order accept-time helper) never fail because
 * the refund hook had a transient DB hiccup.
 */
async function issueBreachRefundSafe(orderId) {
  try {
    return await issueBreachRefund(orderId);
  } catch (err) {
    logErrorToDb(err, { context: 'sla_breach.issueBreachRefund', orderId: orderId });
    return { error: err && err.message };
  }
}

module.exports = {
  issueBreachRefund: issueBreachRefund,
  issueBreachRefundSafe: issueBreachRefundSafe
};
