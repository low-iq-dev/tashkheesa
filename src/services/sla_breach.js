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
 *   3. AUDIT-2026-08-22 (M7): ANY other refund row already occupying migration
 *      083's uniq_refunds_open_per_order slot → return
 *      { skipped: 'blocked_by_existing_refund' } and escalate loudly. Not an
 *      idempotency gate — the obligation is real and cannot be written, so it
 *      must reach a human rather than be dropped.
 *
 * Paymob actual-money refund is NOT wired here — Ziad's track lands
 * that separately.  This module records the refund as an OWED obligation
 * (refunds row, status='auto_approved' = system-approved, awaiting payout)
 * and zeroes the uplift on the order so earnings displays read the
 * standard-tier amount.  The money is sent out-of-band via InstaPay and an
 * operator marks the row 'paid' afterwards; this module never claims the
 * money has already moved.
 */

'use strict';

var { randomUUID } = require('crypto');
var { queryOne, execute } = require('../pg');
var { logErrorToDb } = require('../logger');

/**
 * AUDIT-2026-08-22 (M7): a breach refund obligation that cannot be written is
 * the one thing this module must never lose. Three channels, all best-effort
 * and independently wrapped, because the caller (the SLA cron) must not die
 * over an alerting failure.
 *
 * @param {string} orderId
 * @param {number} uplift        EGP owed to the patient
 * @param {object} blocking      the refunds row that occupies the unique slot
 */
async function reportBreachRefundBlocked(orderId, uplift, blocking) {
  var detail = {
    amount_owed_egp: uplift,
    blocking_refund_id: blocking && blocking.id,
    blocking_refund_reason: (blocking && blocking.reason) || null,
    blocking_refund_status: (blocking && blocking.status) || null,
    resolution: 'top up or supersede the blocking refund by the uplift ' +
      '(superadmin refund create, or admin_refund.supersedeBreachRefund)'
  };
  try {
    await execute(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
       VALUES ($1, $2, 'sla_breach_refund_blocked', $3, NOW(), NULL, 'system')`,
      [randomUUID(), orderId, JSON.stringify(detail)]
    );
  } catch (e) {
    logErrorToDb(e, { context: 'sla_breach.report_blocked_timeline', orderId: orderId, category: 'refund' });
  }
  try {
    logErrorToDb(
      new Error('SLA-breach refund of EGP ' + uplift + ' could not be recorded for order ' +
        orderId + ' — an existing refund row occupies uniq_refunds_open_per_order'),
      { context: 'sla_breach.refund_blocked', orderId: orderId, category: 'refund' }
    );
  } catch (_) { /* best-effort */ }
  try {
    var { sendCriticalAlert } = require('../critical-alert');
    sendCriticalAlert(
      'SLA-breach refund BLOCKED on order ' + orderId + ': EGP ' + uplift +
      ' is owed to the patient but refund ' + (blocking && blocking.id) +
      ' (' + ((blocking && blocking.reason) || 'unknown') + '/' +
      ((blocking && blocking.status) || 'unknown') + ') already holds the ' +
      'one-open-refund-per-order slot. Top that row up by the uplift.',
      'sla_breach_refund_blocked'
    );
  } catch (_) { /* alerting is optional, never load-bearing */ }
}

/**
 * @param {string} orderId
 * @returns {Promise<{
 *   refunded?: true, refundId?: string, amount?: number,
 *   skipped?: 'order_not_found' | 'not_paid' | 'no_uplift_to_refund'
 *           | 'already_refunded' | 'blocked_by_existing_refund',
 *   refundId?: string, amountOwed?: number
 * }>}
 */
async function issueBreachRefund(orderId) {
  if (!orderId) return { skipped: 'order_not_found' };

  var order = await queryOne(
    'SELECT id, urgency_uplift_amount, urgency_tier, payment_status FROM orders_active WHERE id = $1',
    [orderId]
  );
  if (!order) return { skipped: 'order_not_found' };

  // AUDIT-P0-7 — you cannot refund money you never collected.
  //
  // This checked only `urgency_uplift_amount > 0`, never that the uplift had
  // actually been PAID. The deleted /order/:id/payment guest route let a
  // patient rewrite urgency_tier and urgency_uplift_amount on an already-paid
  // order for free; the retroactive deadline then breached immediately and
  // this function opened a real refund obligation against revenue that was
  // never taken, while clawing back the doctor's uplift share.
  //
  // The route is gone, but the gate belongs here too: this is the function
  // that decides money is owed, and any future write to urgency_uplift_amount
  // would re-open the same hole.
  var paymentStatus = String(order.payment_status || '').toLowerCase();
  if (paymentStatus !== 'paid' && paymentStatus !== 'captured') {
    return { skipped: 'not_paid' };
  }

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

  // ── AUDIT-2026-08-22 (M7): the INSERT below can be REFUSED by the schema ──
  //
  // Migration 083's uniq_refunds_open_per_order is UNIQUE on refunds(order_id)
  // WHERE status IN ('pending','auto_approved','approved','paid') — at most ONE
  // such row per order, whatever its reason. The gate above only looks for a
  // prior 'sla_breach' row, so a case that already carries a patient_request or
  // operator_refund row in any of those statuses (entirely normal: the patient
  // asked for their money back and THEN the deadline passed) sent the INSERT
  // straight into a 23505. issueBreachRefundSafe swallowed it and the uplift
  // obligation vanished with no record anywhere.
  //
  // Checking for it here rather than catching the constraint does two things:
  // it keeps the "no money state was touched" guarantee (the uplift zeroing and
  // the earnings recompute below are AFTER this point and must not run when the
  // obligation could not be recorded), and it lets us say WHICH row blocked it.
  //
  // The obligation is real and must not disappear quietly, so this is loud:
  // a case timeline entry naming the amount owed, an error_logs row, and a
  // page. The operator's supported resolution is to top up the blocking refund
  // by the uplift — services/admin_refund.supersedeBreachRefund and the
  // superadmin create form both expose that path.
  var blocking = await queryOne(
    `SELECT id, reason, status FROM refunds
      WHERE order_id = $1
        AND status IN ('pending','auto_approved','approved','paid')
      LIMIT 1`,
    [orderId]
  );
  if (blocking && blocking.id) {
    await reportBreachRefundBlocked(orderId, uplift, blocking);
    return {
      skipped: 'blocked_by_existing_refund',
      refundId: blocking.id,
      blockingReason: blocking.reason || null,
      blockingStatus: blocking.status || null,
      amountOwed: uplift
    };
  }

  var refundId = randomUUID();
  // B3 fix: an SLA-breach refund is an obligation the SYSTEM has decided is
  // owed (the deadline objectively passed), but NO money has moved yet — there
  // is no Paymob/InstaPay refund API wired (see TODO below). Writing it as
  // 'paid' was a lie: it told the dashboards (and, via copy, the patient) the
  // money was sent when it was not.
  //
  // Correct state = 'auto_approved': the workflow state for "system-approved,
  // awaiting payout". It lands in the superadmin "Awaiting payment" queue
  // (routes/superadmin.js + routes/api/admin.js) and an operator finalizes it
  // via the existing mark-paid action (admin_refund_mark_paid.setRefundPaid)
  // once the InstaPay transfer actually happens — at which point status flips
  // to 'paid', paid_at is set, and instapay_reference records the transfer.
  //
  // We populate requested_amount AND approved_amount = uplift so:
  //   (a) mark-paid can compute finalAmount (it does approved ?? requested;
  //       both NULL would throw NO_AMOUNT and the refund could never be paid),
  //   (b) the refundsOwed / refundedMTD KPIs read the right figure.
  // requested_by='system' attributes the row (the queue LEFT JOINs on it).
  // paid_at stays NULL by design — money has NOT been sent.
  await execute(
    `INSERT INTO refunds
       (id, order_id, amount_egp, reason, refunded_at, refunded_by, requested_by,
        requested_amount, approved_amount, paymob_refund_id, notes, status)
     VALUES ($1, $2, $3, 'sla_breach', NOW(), 'system', 'system',
             $3, $3, NULL, $4, 'auto_approved')`,
    [
      refundId, orderId, uplift,
      'Auto-refund: SLA deadline passed without case completion (tier ' +
        (order.urgency_tier || 'unknown') + '). Awaiting InstaPay payout.'
    ]
  );

  // Earnings recalc — zero the uplift on the order so the next read of
  // doctor earnings reflects the standard-tier base only.  The doctor's
  // main-case fee (services.doctor_fee absolute EGP) is unchanged; only
  // the upliftShare component falls to 0.
  //
  // AUDIT-2026-08-22 (M7): this used to set urgency_uplift_amount = 0 and leave
  // `price` and `base_price` untouched, which BREAKS migration 037's invariant
  //     orders.base_price + orders.urgency_uplift_amount = orders.price
  // on every breached order. Anything reconstructing the case fee from the
  // snapshot columns — refund_eligibility.maxRefundableEgp's legacy branch,
  // earnings_writer.caseFeeCollectedEgp, notification_worker's receipt lines —
  // then reads base_price and is short by the uplift.
  //
  // The uplift is MOVED into base_price rather than deducted from `price`.
  // `price` is what the gateway actually charged: it is the refund ceiling and
  // the collected-revenue figure, and the refund of the uplift is already
  // recorded as its own row in `refunds`, so reducing `price` here would
  // subtract the same money twice. Moving it keeps base_price + uplift exactly
  // equal to whatever it equalled before, so an order that satisfied the
  // invariant still satisfies it.
  //
  // `AND urgency_uplift_amount > 0` makes the write idempotent — a second run
  // cannot fold the uplift into base_price twice.
  await execute(
    `UPDATE orders
        SET base_price = COALESCE(base_price, 0) + urgency_uplift_amount,
            urgency_uplift_amount = 0,
            updated_at = NOW()
      WHERE id = $1
        AND urgency_uplift_amount > 0`,
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
    // AUDIT-2026-08-22 (M7): a 23505 here is NOT a transient hiccup — it is
    // migration 083's uniq_refunds_open_per_order refusing to record a refund
    // the system has already decided the patient is owed. The pre-check added
    // to issueBreachRefund should now catch that case before the INSERT, so
    // reaching here means either a race (two SLA workers on the same order) or
    // a refund row created between the check and the write. Either way the
    // obligation has been DROPPED, and the old generic logErrorToDb — one
    // error_logs row, no page, no case timeline entry — is not enough for lost
    // money. Escalate on the same three channels as the pre-check.
    var code = err && (err.code || (err.original && err.original.code));
    if (String(code) === '23505') {
      try {
        var blocking = await queryOne(
          `SELECT id, reason, status FROM refunds
            WHERE order_id = $1
              AND status IN ('pending','auto_approved','approved','paid')
            LIMIT 1`,
          [orderId]
        );
        var owed = await queryOne(
          'SELECT urgency_uplift_amount FROM orders_active WHERE id = $1',
          [orderId]
        );
        await reportBreachRefundBlocked(
          orderId,
          Number(owed && owed.urgency_uplift_amount) || 0,
          blocking || { id: null, reason: null, status: null }
        );
      } catch (reportErr) {
        logErrorToDb(reportErr, {
          context: 'sla_breach.issueBreachRefund.report_23505',
          orderId: orderId,
          category: 'refund'
        });
      }
      return { error: err && err.message, skipped: 'blocked_by_existing_refund' };
    }
    logErrorToDb(err, { context: 'sla_breach.issueBreachRefund', orderId: orderId, category: 'refund' });
    return { error: err && err.message };
  }
}

module.exports = {
  issueBreachRefund: issueBreachRefund,
  issueBreachRefundSafe: issueBreachRefundSafe
};
