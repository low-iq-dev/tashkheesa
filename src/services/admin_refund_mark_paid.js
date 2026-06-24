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

// Throw-to-reject: carries an HTTP status + code out of the txn to the route,
// which maps err.http/err.code → res.fail (same as admin_refund_approve.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
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

    // (5) order_events timeline — in-txn (house style, matches admin_refund_approve.js;
    //     same meta keys the web's logOrderEvent uses).
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'superadmin_refund_marked_paid', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), row.order_id,
        JSON.stringify({ refund_id: refundId, amount_egp: finalAmount, instapay_reference: instapayReference, payer_id: actorId }),
        actorId]
    );

    // (6) admin audit into error_logs — in-txn (atomic with the write).
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `marked_paid_refund: ${refundId}`, actorId,
        JSON.stringify({ action: 'marked_paid_refund', target: refundId, instapay_reference: instapayReference, final_amount: finalAmount })]
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
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setRefundPaid };
