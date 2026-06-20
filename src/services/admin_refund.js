/**
 * Tashkheesa Command — operator-initiated refund (superadmin, money-path WRITE).
 *
 * Mirrors the validated web-superadmin create
 * (routes/superadmin.js POST /superadmin/refunds/create), wrapped in ONE atomic
 * transaction with both audit rows written on the txn client.
 *
 * Scope (v1, deliberately narrow): records a PENDING refund row — a payout
 * OBLIGATION. Money is returned MANUALLY via InstaPay; completion
 * (approve/mark-paid) stays on the web superadmin. There is NO Paymob refund
 * API (the integration doesn't exist), so this is a pure DB write — fully
 * rollback-able, no external-call reconciliation.
 *
 * v1 touches the orders row NOT AT ALL (no payment_status flip — refund state
 * lives only in the refunds table), does NO earnings clawback (that is
 * mark-paid-only, and earnings have never fired in prod), changes NO
 * case/assignment, and fires NO notification (silent — the
 * patient_refund_opened_by_operator template is the wired follow-up).
 *
 * No-double-refund safety: the order is locked FOR UPDATE, so two operators
 * refunding the same order serialize — the second blocks until the first
 * commits, then check #3 sees the first's row and rejects.
 */

'use strict';

const { randomUUID } = require('crypto');

// Statuses that mean an in-flight or completed refund already exists for the
// order (mirrors routes/superadmin.js:4681).
const BLOCKING_REFUND_STATUSES = ['pending', 'auto_approved', 'approved', 'paid'];

// Throw-to-reject: carries an HTTP status + code out of the txn to the route.
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ orderId: string, amount: number, instapayHandle: string, notes?: string, actorId: string }} opts
 * @returns {Promise<{ id, orderId, amountEgp, status, instapayHandle, reason, createdAt }>}
 */
async function issueRefund(client, opts) {
  const orderId = String(opts && opts.orderId ? opts.orderId : '').trim();
  const amount = Number(opts && opts.amount);
  const instapayHandle = String(opts && opts.instapayHandle ? opts.instapayHandle : '').trim();
  const notes = String(opts && opts.notes ? opts.notes : '').trim().slice(0, 1000);
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    // (1) order exists, not soft-deleted, locked FOR UPDATE
    const order = (await client.query(
      `SELECT id, patient_id, payment_status, base_price, urgency_uplift_amount
         FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [orderId]
    )).rows[0];
    if (!order) throw af('Case not found', 404, 'ORDER_NOT_FOUND');

    // (2) must be paid
    if (String(order.payment_status || '').toLowerCase() !== 'paid') {
      throw af('Order is not paid', 409, 'ORDER_NOT_PAID');
    }

    // (3) no existing in-flight/paid refund — re-checked UNDER the order lock so
    //     two concurrent operators can't both create a refund.
    const existing = (await client.query(
      `SELECT id FROM refunds WHERE order_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [orderId, BLOCKING_REFUND_STATUSES]
    )).rows[0];
    if (existing) throw af('A refund already exists for this case', 409, 'REFUND_ALREADY_EXISTS');

    // (4) amount finite & > 0
    if (!Number.isFinite(amount) || amount <= 0) {
      throw af('Refund amount must be greater than zero', 400, 'INVALID_AMOUNT');
    }
    // (5) amount <= full case fee (base + urgency uplift); epsilon absorbs float drift
    const maxAmount = Number(order.base_price || 0) + Number(order.urgency_uplift_amount || 0);
    if (amount > maxAmount + 0.001) {
      throw af('Refund amount exceeds the case fee', 409, 'AMOUNT_EXCEEDS_MAX');
    }
    // (6) InstaPay handle required (the manual payout target)
    if (instapayHandle.length < 3 || instapayHandle.length > 100) {
      throw af('A valid InstaPay handle is required', 400, 'INSTAPAY_REQUIRED');
    }

    const refundId = randomUUID();
    const combinedNotes = 'Operator-initiated refund (Command app)' + (notes ? ' — ' + notes : '');

    // refunds INSERT — status 'pending'; orders row untouched. amount_egp and
    // requested_amount both = amount; approved_amount stays NULL until web approve.
    const ins = await client.query(
      `INSERT INTO refunds (
         id, order_id, amount_egp, requested_amount, approved_amount,
         reason, patient_reason, instapay_handle, status,
         requested_by, refunded_at, refunded_by, notes
       ) VALUES ($1, $2, $3, $3, NULL,
                 'operator_refund', NULL, $4, 'pending',
                 $5, NOW(), $5, $6)
       RETURNING refunded_at`,
      [refundId, orderId, amount, instapayHandle, actorId, combinedNotes]
    );
    const refundedAt = ins.rows[0] && ins.rows[0].refunded_at;

    // order_events audit — on the txn client (atomic with the refund row)
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'operator_refund_created', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), orderId,
        JSON.stringify({
          refund_id: refundId, amount_egp: amount, instapay_handle: instapayHandle,
          operator_user_id: actorId, notes_preview: notes.slice(0, 100),
        }),
        actorId]
    );

    // admin audit into error_logs — on the txn client
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `operator refund ${refundId} for order ${orderId} amount ${amount}`, actorId,
        JSON.stringify({ action: 'refund_issued', caseId: orderId, refundId, amountEgp: amount, instapayHandle })]
    );

    await client.query('COMMIT');

    return {
      id: refundId,
      orderId,
      amountEgp: amount,
      status: 'pending',
      instapayHandle,
      reason: 'operator_refund',
      createdAt: refundedAt ? new Date(refundedAt).toISOString() : null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { issueRefund, BLOCKING_REFUND_STATUSES };
