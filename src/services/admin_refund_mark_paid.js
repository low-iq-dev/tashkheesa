/**
 * Tashkheesa Command — refund MARK-PAID (approved → paid) — slice 6, money-path WRITE.
 *
 * RECORDS-ONLY: records that an InstaPay transfer happened out-of-band. Makes NO
 * payout API call (there is no Paymob/InstaPay refund API in the codebase);
 * instapay_reference is operator-supplied text. Mirrors the web superadmin
 * mark-paid (routes/superadmin.js:4907) but wrapped in ONE atomic transaction
 * with the timeline + audit rows on the txn client — the proven Command pattern
 * (see admin_refund_approve.js). The route hands in an already-connected client
 * (db.connect() on the INJECTED pool); this service owns BEGIN/COMMIT/ROLLBACK.
 *
 * amount_egp finalization (mirrors the web): finalAmount = approved_amount ??
 * requested_amount. The UPDATE sets amount_egp = finalAmount AND
 * approved_amount = COALESCE(approved_amount, finalAmount) — so the
 * auto_approved → paid direct path (approved_amount was NULL) backfills it and
 * both agree. For the normal approved → paid path slice 4 already set
 * amount_egp = approved_amount, so finalAmount == amount_egp == approved_amount.
 *
 * The doctor-earnings CLAWBACK (recomputeOnRefund) is fired POST-COMMIT/off-txn
 * by the route (DB-only, idempotency-guarded) — NOT here — so a clawback failure
 * can't roll back the committed paid status. This service must NEVER call it.
 *
 * RLS out of scope — the JWT + superadmin gate on the route is the boundary.
 */

'use strict';

const { randomUUID } = require('crypto');
const { maxRefundableEgp } = require('./refund_eligibility');

// Throw-to-reject: carries an HTTP status + code out of the txn to the route,
// which maps err.http/err.code → res.fail (same as admin_refund_approve.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

// ── Refund → orders.payment_status, ONE implementation for BOTH mark-paid
//    sites (this service and the web route at routes/superadmin.js) ─────────
//
// AUDIT (2026-08-17, regression F1). Two problems with the first cut:
//
//   1. It flipped payment_status to 'refunded' on ANY refund, including a
//      partial one. Everything downstream that asks "is this order paid?"
//      does so with a `!= 'paid'` blacklist rather than a whitelist, so a
//      50-EGP goodwill refund on a 2000-EGP case:
//        * made case_lifecycle's unpaid-case sweep treat the order as unpaid
//          and, at the 48h hard stop, SOFT-DELETE it out of orders_active
//          while telling the patient their "unpaid case" was deleted;
//        * pulled the case out of the doctor pool;
//        * removed the WHOLE order value from collected revenue
//          (every reporting query filters payment_status IN ('paid','captured'));
//        * hid the order from the refund queue.
//      The refunded FACT is what closes the double-refund loop, and that fact
//      is only true for a genuinely FULL refund. A partial refund must leave
//      the order 'paid'.
//   2. It existed twice, and differently: in-txn with updated_at here,
//      best-effort without it there, and neither checked rowCount.
//
// "Full" = the total of every PAID refund on the order has reached the refund
// ceiling (services/refund_eligibility.maxRefundableEgp = price + the add-ons
// locked at intention time — literally what Paymob charged), within one cent.
// Summing the paid rows rather than looking at just this one also covers the
// legacy multi-partial case, where two partials add up to the whole charge.
//
// `exec` is any (sql, params) => Promise<pg.Result>: pass `client.query` bound
// to a txn client to run in-transaction, or pg.execute for the pool. Both call
// sites therefore get identical semantics, identical rounding and an identical
// rowCount check.
//
// Returns a describable outcome — it never throws and never rolls a caller
// back. The refund itself is already paid from the patient's point of view, so
// a failure to close this loop is a reconciliation item (logged by the caller),
// not a reason to fail the operator's action. Migration 082's
// uniq_refunds_open_per_order is the independent backstop against the second
// refund request this column is guarding.
const FULL_REFUND_EPSILON_CENTS = 1;

async function applyRefundedPaymentStatus(exec, orderId) {
  if (typeof exec !== 'function' || !orderId) {
    return { flipped: false, reason: 'missing_args' };
  }

  // include-deleted-ok: the order this refund belongs to may ALREADY have been
  // soft-deleted (that is precisely the bug this guard exists to stop
  // repeating), and we must still read and correct its payment state.
  const ordRes = await exec(
    `SELECT id, payment_status, price, base_price, urgency_uplift_amount,
            addons_json, video_consultation_selected, video_consultation_price
       FROM orders -- include-deleted-ok: see the comment above this query
      WHERE id = $1`,
    [orderId]
  );
  const order = (ordRes && ordRes.rows) ? ordRes.rows[0] : null;
  if (!order) return { flipped: false, reason: 'order_not_found' };

  if (String(order.payment_status || '').toLowerCase() === 'refunded') {
    return { flipped: false, reason: 'already_refunded' };
  }

  const ceilingEgp = maxRefundableEgp(order);
  const ceilingCents = Math.round(Number(ceilingEgp) * 100);

  // amount_egp is the settled figure; the COALESCE chain covers legacy paid
  // rows written before slice 4 kept amount_egp in step with approved_amount.
  const sumRes = await exec(
    `SELECT COALESCE(SUM(COALESCE(amount_egp, approved_amount, requested_amount, 0)), 0) AS total
       FROM refunds
      WHERE order_id = $1 AND status = 'paid'`,
    [orderId]
  );
  const refundedEgp = Number((sumRes && sumRes.rows && sumRes.rows[0] && sumRes.rows[0].total) || 0);
  const refundedCents = Math.round(refundedEgp * 100);

  if (!Number.isFinite(ceilingCents) || ceilingCents <= 0) {
    // No establishable charge on the order — we cannot prove the refund is
    // full, so we leave payment_status alone rather than guess. Failing this
    // way keeps the case alive; the opposite failure deletes it.
    return { flipped: false, reason: 'no_refundable_total', refundedEgp, ceilingEgp };
  }
  if (refundedCents < ceilingCents - FULL_REFUND_EPSILON_CENTS) {
    return { flipped: false, reason: 'partial_refund', refundedEgp, ceilingEgp };
  }

  const upd = await exec(
    `UPDATE orders
        SET payment_status = 'refunded', updated_at = NOW()
      WHERE id = $1
        AND LOWER(COALESCE(payment_status, '')) <> 'refunded'`,
    [orderId]
  );
  if (!upd || !upd.rowCount) {
    // Raced with another writer, or the row vanished between the two
    // statements. Report it so the caller can log/alert; do not throw.
    return { flipped: false, reason: 'update_no_rows', refundedEgp, ceilingEgp };
  }
  return { flipped: true, reason: 'full_refund', refundedEgp, ceilingEgp };
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ refundId: string, instapayReference: string, actorId: string }} opts
 * @returns {Promise<{ id, status, instapayReference, paidAt, amountEgp, approvedAmount, orderId, finalAmount, reason }>}
 */
async function setRefundPaid(client, opts) {
  const refundId = String(opts && opts.refundId ? opts.refundId : '').trim();
  const instapayReference = String(opts && opts.instapayReference ? opts.instapayReference : '').trim().slice(0, 100);
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) lock the refund row; re-read in-txn, never trust the caller.
    const r = (await client.query(
      `SELECT id, order_id, status, approved_amount, requested_amount, reason FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId]
    )).rows[0];
    if (!r) throw af('Refund not found', 404, 'REFUND_NOT_FOUND');

    // (2) FROM-state guard — only an approved/auto_approved refund can be paid.
    //     'paid' is terminal (no re-pay); 'pending' can't skip approval.
    if (!['approved', 'auto_approved'].includes(String(r.status))) {
      throw af('Refund is not in a payable state', 409, 'NOT_PAYABLE');
    }

    // (3) the amount actually paid out — approved if set, else the requested
    //     figure (the auto_approved → paid direct path). Defend the null/null case.
    const finalAmount = r.approved_amount != null ? Number(r.approved_amount)
      : (r.requested_amount != null ? Number(r.requested_amount) : null);
    if (finalAmount == null || !Number.isFinite(finalAmount)) {
      throw af('No amount to pay', 409, 'NO_AMOUNT');
    }

    // (4) the write — status→paid, reference + paid_at, amount_egp = finalAmount,
    //     and backfill approved_amount so both agree.
    const upd = await client.query(
      `UPDATE refunds
          SET status = 'paid',
              instapay_reference = $2,
              paid_at = NOW(),
              amount_egp = $3,
              approved_amount = COALESCE(approved_amount, $3)
        WHERE id = $1
       RETURNING id, status, instapay_reference, paid_at, amount_egp, approved_amount, order_id`,
      [refundId, instapayReference, finalAmount]
    );
    const row = upd.rows[0];

    // (4b) Close the order's payment state. AUDIT-P0: without this the order
    // stays payment_status='paid' after the money has been sent back, so
    // refund_eligibility keeps returning {eligible:true, autoApprove:true} and
    // the patient can request a second full refund. Migration 082 widens the
    // partial unique index to cover 'paid' as the backstop; this is the
    // eligibility half. In-txn is correct here because this service owns
    // BEGIN/COMMIT — the web route does the same write post-UPDATE.
    //
    // ONLY on a genuinely full refund — see applyRefundedPaymentStatus above
    // for why a partial refund must leave the order 'paid'. The refunds UPDATE
    // ran first, so the sum inside the helper already includes THIS refund.
    const paymentStatusOutcome = await applyRefundedPaymentStatus(
      (sql, params) => client.query(sql, params),
      row.order_id
    );

    // (5) order_events timeline — in-txn (house style, matches admin_refund_approve.js;
    //     same meta keys the web's logOrderEvent uses). The payment_status
    //     outcome rides along so "why is this order still 'paid'?" is answerable
    //     from the case timeline alone.
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'superadmin_refund_marked_paid', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), row.order_id,
        JSON.stringify({
          refund_id: refundId,
          amount_egp: finalAmount,
          instapay_reference: instapayReference,
          payer_id: actorId,
          order_payment_status: paymentStatusOutcome.flipped ? 'refunded' : 'unchanged',
          order_payment_status_reason: paymentStatusOutcome.reason,
          total_refunded_egp: paymentStatusOutcome.refundedEgp != null ? paymentStatusOutcome.refundedEgp : null,
          refund_ceiling_egp: paymentStatusOutcome.ceilingEgp != null ? paymentStatusOutcome.ceilingEgp : null
        }),
        actorId]
    );

    // (6) admin audit into error_logs — in-txn (atomic with the write).
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `marked_paid_refund: ${refundId}`, actorId,
        JSON.stringify({
          action: 'marked_paid_refund',
          target: refundId,
          instapay_reference: instapayReference,
          final_amount: finalAmount,
          order_payment_status_flipped: !!paymentStatusOutcome.flipped,
          order_payment_status_reason: paymentStatusOutcome.reason
        })]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      status: row.status,
      instapayReference: row.instapay_reference || null,
      paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
      amountEgp: row.amount_egp == null ? null : Number(row.amount_egp),
      approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
      orderId: row.order_id,
      finalAmount,
      reason: r.reason || null,
      // Exposed so the route can report / alert on a payment_status flip that
      // did not happen. `false` with reason 'partial_refund' is the normal,
      // correct outcome for a partial refund — not an error.
      orderPaymentStatusFlipped: !!paymentStatusOutcome.flipped,
      orderPaymentStatusReason: paymentStatusOutcome.reason,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

// AUDIT-2026-08-22 (M2): FULL_REFUND_EPSILON_CENTS is exported so
// services/refund_closure.js can apply the IDENTICAL tolerance. The two used to
// be independent — different ceiling, no tolerance — so on the web mark-paid
// path (routes/superadmin.js) they could reach opposite conclusions about the
// same refund and one of them would be wrong by a rounding piastre.
module.exports = { setRefundPaid, applyRefundedPaymentStatus, FULL_REFUND_EPSILON_CENTS };
