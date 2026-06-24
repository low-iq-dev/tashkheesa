/**
 * Tashkheesa Command — refund DENY (pending → denied) — slice 5, money-path WRITE.
 *
 * The simplest refund-lifecycle action: a pure status flip to 'denied' with a
 * REQUIRED reason. No amount logic, no clawback. Mirrors the web superadmin deny
 * (routes/superadmin.js:4848) but wrapped in ONE atomic transaction with the
 * timeline + audit rows on the txn client — the proven Command pattern (see
 * admin_refund_approve.js, admin_doctor_reject.js). The route hands in an
 * already-connected client (db.connect() on the INJECTED pool) and this service
 * owns BEGIN/COMMIT/ROLLBACK.
 *
 * Does NOT touch approved_amount or amount_egp — a denied refund is excluded from
 * the money KPIs (refundsOwed/refundedMTD) entirely, so amount coherence is
 * irrelevant here (unlike approve, which sets amount_egp = approved_amount).
 *
 * Pure DB write (no payout API). The patient notification is fired POST-COMMIT/
 * off-txn by the route, best-effort, so a notify failure can't roll back the
 * denial. RLS out of scope — the JWT + superadmin gate on the route is the boundary.
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
 * @param {{ refundId: string, denialReason: string, actorId: string }} opts
 * @returns {Promise<{ id, status, denialReason, reviewedAt, orderId }>}
 */
async function setRefundDenial(client, opts) {
  const refundId = String(opts && opts.refundId ? opts.refundId : '').trim();
  const denialReason = String(opts && opts.denialReason ? opts.denialReason : '').trim().slice(0, 1000);
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) lock the refund row; re-read in-txn, never trust the caller. FOR UPDATE
    //     serializes two operators acting on the same refund.
    const r = (await client.query(
      `SELECT id, order_id, status FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId]
    )).rows[0];
    if (!r) throw af('Refund not found', 404, 'REFUND_NOT_FOUND');

    // (2) FROM-state guard — only a pending/auto_approved refund can be denied.
    if (!['pending', 'auto_approved'].includes(String(r.status))) {
      throw af('Refund is not in a deniable state', 409, 'NOT_DENIABLE');
    }

    // (3) the write — status→denied, reason + reviewer stamp. No amount columns.
    const upd = await client.query(
      `UPDATE refunds
          SET status = 'denied',
              denial_reason = $2,
              reviewed_by = $3,
              reviewed_at = NOW()
        WHERE id = $1
       RETURNING id, status, denial_reason, reviewed_at, order_id`,
      [refundId, denialReason, actorId]
    );
    const row = upd.rows[0];

    // (4) order_events timeline — in-txn (house style, matches admin_refund_approve.js;
    //     same label + meta keys the web's logOrderEvent uses).
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'superadmin_refund_denied', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), row.order_id,
        JSON.stringify({ refund_id: refundId, denial_reason: denialReason.slice(0, 200), reviewer_id: actorId }),
        actorId]
    );

    // (5) admin audit into error_logs — in-txn (atomic with the write).
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `denied_refund: ${refundId}`, actorId,
        JSON.stringify({ action: 'denied_refund', target: refundId, denial_reason: denialReason })]
    );

    await client.query('COMMIT');

    return {
      id: row.id,
      status: row.status,
      denialReason: row.denial_reason || null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      orderId: row.order_id,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { setRefundDenial };
