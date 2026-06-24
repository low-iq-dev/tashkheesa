/**
 * Tashkheesa Command — refund APPROVE (pending → approved) — slice 4, money-path WRITE.
 *
 * Mirrors the web superadmin approve (routes/superadmin.js:4777) but wrapped in
 * ONE atomic transaction with the timeline + audit rows written on the txn
 * client — the proven Command pattern (see services/admin_refund.js issueRefund).
 * The route hands in an already-connected client (db.connect() on the INJECTED
 * pool) and this service owns BEGIN/COMMIT/ROLLBACK.
 *
 * Supports PARTIAL approval: the operator-supplied approved_amount must be > 0
 * and <= requested_amount (epsilon absorbs float drift; no upgrades).
 *
 * amount_egp COHERENCE (deliberate divergence from the web): this also sets
 * amount_egp = approved_amount at approve time. The web leaves amount_egp stale
 * (= the original requested figure) until mark-paid, but the Command money KPIs
 * SUM amount_egp (refundsOwed / refundedMTD), so leaving it stale would make the
 * 'refunds owed' tile sum the requested figure for approved-but-unpaid rows.
 * Setting amount_egp = approved_amount here keeps those tiles honest.
 *
 * Pure DB write — there is NO Paymob/InstaPay payout API (money is returned
 * manually), so this is fully rollback-able with no external reconciliation. The
 * patient notification is fired POST-COMMIT/off-txn by the route, best-effort,
 * so a notify failure can't roll back the approval.
 *
 * RLS out of scope — the portal connects as the bypass role; the JWT +
 * superadmin gate on the route is the security boundary.
 */

'use strict';

const { randomUUID } = require('crypto');

// Throw-to-reject: carries an HTTP status + code out of the txn to the route,
// which maps err.http/err.code → res.fail (same as admin_refund.js).
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ refundId: string, approvedAmount: number, notes?: string, actorId: string }} opts
 * @returns {Promise<{ id, status, approvedAmount, amountEgp, requestedAmount, reviewedAt, orderId }>}
 */
async function setRefundApproval(client, opts) {
  const refundId = String(opts && opts.refundId ? opts.refundId : '').trim();
  const approvedAmount = Number(opts && opts.approvedAmount);
  const notes = String(opts && opts.notes ? opts.notes : '').trim().slice(0, 1000);
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) lock the refund row; re-read in-txn, never trust the caller. FOR UPDATE
    //     serializes two operators acting on the same refund.
    const r = (await client.query(
      `SELECT id, order_id, status, requested_amount FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId]
    )).rows[0];
    if (!r) throw af('Refund not found', 404, 'REFUND_NOT_FOUND');

    // (2) FROM-state guard — only a pending/auto_approved refund can be approved.
    if (!['pending', 'auto_approved'].includes(String(r.status))) {
      throw af('Refund is not in an approvable state', 409, 'NOT_APPROVABLE');
    }

    // (3) amount: finite & > 0
    if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
      throw af('Approved amount must be greater than zero', 400, 'INVALID_AMOUNT');
    }
    // (4) partial allowed, upgrades rejected: approved <= requested (+epsilon)
    const requestedAmount = Number(r.requested_amount || 0);
    if (approvedAmount > requestedAmount + 0.001) {
      throw af('Approved amount exceeds the requested amount', 409, 'AMOUNT_EXCEEDS_REQUESTED');
    }

    // (5) the write — status→approved, approved_amount AND amount_egp = approved
    //     (coherence, see header), reviewer stamp, notes COALESCE (keep existing
    //     when the new note is blank).
    const upd = await client.query(
      `UPDATE refunds
          SET status = 'approved',
              approved_amount = $2,
              amount_egp = $2,
              reviewed_by = $3,
              reviewed_at = NOW(),
              notes = COALESCE(NULLIF($4, ''), notes)
        WHERE id = $1
       RETURNING id, status, approved_amount, amount_egp, requested_amount, reviewed_at, order_id`,
      [refundId, approvedAmount, actorId, notes]
    );
    const row = upd.rows[0];

    // (6) order_events timeline — in-txn (house style, matches issueRefund;
    //     same label + meta keys the web's logOrderEvent uses).
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'superadmin_refund_approved', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), row.order_id,
        JSON.stringify({ refund_id: refundId, approved_amount_egp: approvedAmount, reviewer_id: actorId }),
        actorId]
    );

    // (7) admin audit into error_logs — in-txn (atomic with the write).
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `approved_refund: ${refundId}`, actorId,
        JSON.stringify({ action: 'approved_refund', target: refundId, approved_amount: approvedAmount, requested_amount: requestedAmount })]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      status: row.status,
      approvedAmount: row.approved_amount == null ? null : Number(row.approved_amount),
      amountEgp: row.amount_egp == null ? null : Number(row.amount_egp),
      requestedAmount: row.requested_amount == null ? null : Number(row.requested_amount),
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      orderId: row.order_id,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setRefundApproval };
