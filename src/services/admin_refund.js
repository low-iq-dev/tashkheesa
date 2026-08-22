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
const { maxRefundableEgp } = require('./refund_eligibility');

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
    // price / addons_json / video_consultation_* are needed by
    // maxRefundableEgp — the refund ceiling is what the patient was CHARGED
    // (price + add-ons), not base_price + uplift. See check (5) below.
    const order = (await client.query(
      `SELECT id, patient_id, payment_status, base_price, urgency_uplift_amount,
              price, addons_json, video_consultation_selected, video_consultation_price
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
      // AUDIT-2026-08-22 (M7): reason + status projected so the branch below can
      // tell a supersedable SLA-breach obligation from a real prior refund.
      `SELECT id, reason, status FROM refunds WHERE order_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [orderId, BLOCKING_REFUND_STATUSES]
    )).rows[0];
    if (existing) {
      // AUDIT-2026-08-22 (M7): distinguish the blocker that has a supported
      // resolution from the one that does not. An UNPAID system SLA-breach
      // refund is not a real "someone already refunded this" — it is an
      // automatic partial obligation (the urgency uplift) that migration 083's
      // one-open-refund-per-order index turns into a permanent block: a case
      // that breached and then failed outright could never be refunded at all.
      // supersedeBreachRefund below is the supported top-up path; surface a
      // distinct code so the caller can offer it instead of a dead end.
      if (String(existing.reason) === 'sla_breach' && String(existing.status) !== 'paid') {
        throw af(
          'An automatic SLA-breach refund is already open on this case — top it up instead of creating a second refund',
          409, 'REFUND_SUPERSEDE_REQUIRED'
        );
      }
      throw af('A refund already exists for this case', 409, 'REFUND_ALREADY_EXISTS');
    }

    // (4) amount finite & > 0
    if (!Number.isFinite(amount) || amount <= 0) {
      throw af('Refund amount must be greater than zero', 400, 'INVALID_AMOUNT');
    }
    // (5) amount <= everything the patient was charged; epsilon absorbs float drift.
    // AUDIT 2026-08-17: was `base_price + urgency_uplift_amount`, which excluded
    // paid add-ons and evaluated to 0 (→ every refund rejected) for the several
    // order INSERT paths that never write base_price. maxRefundableEgp is the
    // single source of truth and is derived from owedCentsForOrder — the same
    // helper create-intention and the webhook amount check use.
    const maxAmount = maxRefundableEgp(order);
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

// ── AUDIT-2026-08-22 (M7): topping up / superseding an SLA-breach refund ────
//
// services/sla_breach.issueBreachRefund opens an automatic refund of the
// URGENCY UPLIFT ONLY, reason='sla_breach', status='auto_approved'. Migration
// 083's uniq_refunds_open_per_order is UNIQUE on refunds(order_id) WHERE status
// IN ('pending','auto_approved','approved','paid') — one row per order, full
// stop — and every create path (this service, POST /superadmin/refunds/create,
// the patient request, the Command app) refuses when it sees that row. So a
// case that breached its SLA and then failed outright had NO refund path left:
// the patient could be given back the 200 EGP uplift and never the 1000 EGP
// they paid for a report they never received.
//
// There is no second row to be had, so the supported path is to raise the row
// that is already there. Deliberate constraints:
//
//   * ONLY reason='sla_breach'. A patient_request or operator_refund row is a
//     human decision and is edited through approve/deny, not overwritten here.
//   * ONLY while unpaid ('pending' / 'auto_approved' / 'approved'). Once money
//     has actually left via InstaPay, `paid` is terminal in this codebase and
//     the settled tranche must not be rewritten behind the operator's back —
//     that case throws REFUND_ALREADY_PAID and is called out in the handoff.
//   * UP only. The new figure must exceed what the row already promises;
//     reducing a system-approved obligation is an approve-time decision.
//   * reason STAYS 'sla_breach'. It drives
//     earnings_writer.recomputeOnRefund's clawback policy and
//     refund_eligibility's already_refunded_via_breach branch, and the case did
//     breach. Changing it here would silently switch both.
//
// The row keeps its id, so the audit trail (and any operator link to it) is
// continuous; the previous figure is preserved in the notes and in both audit
// rows.
const SUPERSEDABLE_BREACH_STATUSES = ['pending', 'auto_approved', 'approved'];

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ orderId: string, amount: number, instapayHandle?: string, notes?: string, actorId: string }} opts
 * @returns {Promise<{ id, orderId, amountEgp, previousAmountEgp, status, reason, supersededFrom }>}
 */
async function supersedeBreachRefund(client, opts) {
  const orderId = String(opts && opts.orderId ? opts.orderId : '').trim();
  const amount = Number(opts && opts.amount);
  const instapayHandle = String(opts && opts.instapayHandle ? opts.instapayHandle : '').trim();
  const notes = String(opts && opts.notes ? opts.notes : '').trim().slice(0, 1000);
  const actorId = opts && opts.actorId ? opts.actorId : null;

  await client.query('BEGIN');
  try {
    const order = (await client.query(
      `SELECT id, patient_id, payment_status, base_price, urgency_uplift_amount,
              price, addons_json, video_consultation_selected, video_consultation_price
         FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [orderId]
    )).rows[0];
    if (!order) throw af('Case not found', 404, 'ORDER_NOT_FOUND');
    if (String(order.payment_status || '').toLowerCase() !== 'paid') {
      throw af('Order is not paid', 409, 'ORDER_NOT_PAID');
    }

    // The row that holds the unique slot, locked so two operators serialize.
    const breach = (await client.query(
      `SELECT id, status, reason, amount_egp, requested_amount, approved_amount, notes, instapay_handle
         FROM refunds
        WHERE order_id = $1 AND status = ANY($2::text[])
        FOR UPDATE`,
      [orderId, BLOCKING_REFUND_STATUSES]
    )).rows[0];
    if (!breach) throw af('No open refund to supersede on this case', 404, 'NO_REFUND_TO_SUPERSEDE');
    if (String(breach.reason) !== 'sla_breach') {
      throw af('Only an automatic SLA-breach refund can be superseded', 409, 'NOT_A_BREACH_REFUND');
    }
    if (String(breach.status) === 'paid') {
      throw af(
        'That SLA-breach refund has already been paid out — it cannot be topped up in place',
        409, 'REFUND_ALREADY_PAID'
      );
    }
    if (!SUPERSEDABLE_BREACH_STATUSES.includes(String(breach.status))) {
      throw af('Refund is not in a supersedable state', 409, 'NOT_SUPERSEDABLE');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw af('Refund amount must be greater than zero', 400, 'INVALID_AMOUNT');
    }
    const maxAmount = maxRefundableEgp(order);
    if (amount > maxAmount + 0.001) {
      throw af('Refund amount exceeds the case fee', 409, 'AMOUNT_EXCEEDS_MAX');
    }

    // What the row currently promises. Same COALESCE chain the mark-paid and
    // closure sums use, so "the amount" means one thing everywhere.
    const previous = Number(
      breach.amount_egp != null ? breach.amount_egp
        : (breach.approved_amount != null ? breach.approved_amount : breach.requested_amount)
    ) || 0;
    if (amount <= previous + 0.001) {
      throw af(
        'The new amount must be greater than the ' + previous.toFixed(2) +
        ' EGP already open on this case',
        409, 'AMOUNT_NOT_A_TOPUP'
      );
    }

    const supersedeNote = 'Superseded ' + previous.toFixed(2) + ' EGP SLA-breach auto-refund → ' +
      amount.toFixed(2) + ' EGP by operator' + (notes ? ' — ' + notes : '');
    const combinedNotes = String(breach.notes || '').slice(0, 700) + ' | ' + supersedeNote;

    // status → 'approved': an operator has now set and approved this figure, so
    // it is ready for the existing mark-paid action (which accepts
    // 'approved'/'auto_approved'). All three amount columns move together so
    // every reader — the queue, applyRefundedPaymentStatus, refund_closure —
    // sees the same number.
    const upd = await client.query(
      `UPDATE refunds
          SET amount_egp = $2,
              requested_amount = $2,
              approved_amount = $2,
              status = 'approved',
              instapay_handle = COALESCE(NULLIF($3, ''), instapay_handle),
              notes = $4,
              refunded_by = COALESCE($5, refunded_by)
        WHERE id = $1
          AND reason = 'sla_breach'
          AND status = ANY($6::text[])
       RETURNING id, status, amount_egp`,
      [breach.id, amount, instapayHandle, combinedNotes.slice(0, 1000), actorId, SUPERSEDABLE_BREACH_STATUSES]
    );
    if (!upd.rowCount) {
      // Raced with an approve/mark-paid between the lock and the write.
      throw af('Refund changed state — reload and try again', 409, 'NOT_SUPERSEDABLE');
    }

    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'sla_breach_refund_superseded', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), orderId,
        JSON.stringify({
          refund_id: breach.id,
          previous_amount_egp: previous,
          amount_egp: amount,
          previous_status: breach.status,
          operator_user_id: actorId,
          notes_preview: notes.slice(0, 100)
        }),
        actorId]
    );

    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(),
        `sla_breach refund ${breach.id} for order ${orderId} superseded ${previous} → ${amount}`,
        actorId,
        JSON.stringify({
          action: 'refund_breach_superseded', caseId: orderId, refundId: breach.id,
          previousAmountEgp: previous, amountEgp: amount
        })]
    );

    await client.query('COMMIT');

    return {
      id: breach.id,
      orderId,
      amountEgp: amount,
      previousAmountEgp: previous,
      status: 'approved',
      reason: 'sla_breach',
      supersededFrom: breach.status
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = {
  issueRefund,
  supersedeBreachRefund,
  BLOCKING_REFUND_STATUSES,
  SUPERSEDABLE_BREACH_STATUSES
};
