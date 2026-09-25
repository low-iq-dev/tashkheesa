/**
 * Tashkheesa Command — verify a transfer claim (superadmin, money-path WRITE).
 *
 * The Command-app counterpart of the web verify path, which is
 * POST /superadmin/orders/:id/mark-paid followed by
 * manual_payment.confirmPendingClaimForOrder (routes/superadmin.js ~5117).
 * The web path's payment semantics live in TWO places and this service forks
 * neither of them:
 *
 *   * the orders payment-facts UPDATE here is column-for-column the web
 *     route's (payment_status='paid', payment_method, payment_reference,
 *     paid_at COALESCEd in, updated_at) — with the claim's own method and
 *     reference as the defaults, because the claim is exactly what the
 *     operator verified against the statement;
 *   * caseLifecycle.markCasePaid — the canonical payment boundary that
 *     transitions the case, locks sla_hours and fires auto-assign + the
 *     specialty broadcast — is NOT called here. It opens its own transaction
 *     (withTransaction + FOR UPDATE on the same row this txn holds), so
 *     calling it under this lock self-deadlocks — the same reason
 *     POST /cases/:id/assign drops its txn before reassignCase. The ROUTE
 *     calls it strictly after this commit, exactly where the web route calls
 *     it after its own UPDATE.
 *
 * This file deliberately does NOT live in services/manual_payment.js: THE
 * RULE there (pinned by tests/core/manual-payment-claims.test.js source-grep)
 * is that nothing on the CLAIM path ever writes orders.payment_status. This
 * is not the claim path — it is the superadmin resolution path, the "human
 * who has seen the money land" that THE RULE routes all money movement
 * through.
 *
 * ONE transaction (the Command write pattern, same shape as
 * services/admin_refund.js): guards under FOR UPDATE, the orders update, the
 * claim confirmation and BOTH audit rows commit or roll back together.
 * tests/admin/admin_verify_claim.test.js proves the atomicity by fault
 * injection on the audit insert.
 *
 * Idempotent: verifying an already-confirmed claim returns the same facts
 * with alreadyVerified=true and writes nothing (the double-tap case). A
 * rejected claim is a decision already made → 409 CLAIM_ALREADY_DECIDED.
 * A claim on a cancelled / expired / refunded case → 409 ORDER_NOT_PAYABLE.
 * A pending claim on an order that is ALREADY paid (card payment raced the
 * transfer) is refused with 409 ORDER_ALREADY_PAID rather than silently
 * confirmed: money arriving twice is a refund conversation, not a verify.
 */

'use strict';

const { randomUUID } = require('crypto');

// Throw-to-reject: carries an HTTP status + code out of the txn to the route.
function af(msg, http, code) {
  const e = new Error(msg);
  e.http = http;
  e.code = code;
  return e;
}

function toIso(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The claim as the Command API answers it (claimDto + resolution facts). */
function claimResponse(row) {
  return {
    id: String(row.id),
    status: String(row.status),
    method: String(row.method),
    reference: String(row.reference || ''),
    senderName: row.sender_name ? String(row.sender_name) : null,
    submittedAt: toIso(row.updated_at || row.created_at),
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
    createdAt: toIso(row.created_at),
    resolvedAt: toIso(row.resolved_at),
  };
}

/** The order's payment facts as the Command API answers them. */
function orderResponse(row) {
  return {
    id: String(row.id),
    reference: row.reference_id || null,
    paymentStatus: String(row.payment_status || 'unpaid').toLowerCase(),
    paymentMethod: row.payment_method || null,
    paymentReference: row.payment_reference || null,
    paidAt: toIso(row.paid_at),
  };
}

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ claimId: string, actorId: string, method?: string, reference?: string }} opts
 *   method / reference — optional overrides for the payment facts recorded on
 *   the order (the web mark-paid form's two fields). Defaults: the claim's own.
 * @returns {Promise<{ claim, order, patientId, alreadyVerified: boolean }>}
 */
async function verifyPaymentClaim(client, opts) {
  const claimId = String(opts && opts.claimId ? opts.claimId : '').trim();
  const actorId = opts && opts.actorId ? opts.actorId : null;
  const methodOverride = String(opts && opts.method != null ? opts.method : '').trim().slice(0, 80);
  const referenceOverride = String(opts && opts.reference != null ? opts.reference : '').trim().slice(0, 100);
  if (!claimId) throw af('Claim not found', 404, 'CLAIM_NOT_FOUND');

  await client.query('BEGIN');
  try {
    // (1) The claim, unlocked — only to learn its order id. The lock order
    // below is ORDER then CLAIM, matching the web path (its orders UPDATE
    // locks the order row before confirmPendingClaimForOrder touches the
    // claim), so a concurrent web mark-paid cannot deadlock against this.
    const peek = (await client.query(
      `SELECT id, order_id FROM payment_claims WHERE id = $1`,
      [claimId]
    )).rows[0];
    if (!peek) throw af('Claim not found', 404, 'CLAIM_NOT_FOUND');

    // (2) The order, locked. deleted_at IS NULL for the same reason
    // markCasePaid filters it: an auto-expired soft-deleted case must not be
    // marked paid — money that arrives for one is refunded, not applied.
    const order = (await client.query(
      // practice-ok: write path, by id — and the guard below REFUSES the write
      // on a practice case (slice 1 launch-week policy, 409 PRACTICE_CASE).
      `SELECT id, reference_id, patient_id, status, payment_status, payment_method,
              payment_reference, paid_at, is_practice
         FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [peek.order_id]
    )).rows[0];
    if (!order) throw af('Case not found', 404, 'ORDER_NOT_FOUND');
    if (order.is_practice === true) {
      throw af('This is a doctor-training practice case — its payment state is not operable', 409, 'PRACTICE_CASE');
    }
    // 2026-09-26 — a cancelled / expired / refunded case cannot be made paid.
    // The claim stays pending for the operator to reject (with a reason the
    // patient reads) and the money is refunded outside this path.
    if (require('../case_lifecycle').isClosedUnpayable(order.status)) {
      throw af('This case is ' + String(order.status).toLowerCase() + ' — it cannot be marked paid. Reject the claim and refund the transfer.', 409, 'ORDER_NOT_PAYABLE');
    }

    // (3) The claim, locked and re-read under the order lock.
    const claim = (await client.query(
      `SELECT id, order_id, patient_id, method, reference, sender_name, status,
              rejection_reason, created_at, updated_at, resolved_at, resolved_by
         FROM payment_claims WHERE id = $1 FOR UPDATE`,
      [claimId]
    )).rows[0];
    if (!claim) throw af('Claim not found', 404, 'CLAIM_NOT_FOUND');

    // Idempotent replay: the double-tap. Same result, no writes.
    if (String(claim.status) === 'confirmed') {
      await client.query('COMMIT'); // nothing was written; COMMIT == ROLLBACK
      return {
        claim: claimResponse(claim),
        order: orderResponse(order),
        patientId: order.patient_id || claim.patient_id || null,
        alreadyVerified: true,
      };
    }
    if (String(claim.status) === 'rejected') {
      throw af('This claim was already rejected', 409, 'CLAIM_ALREADY_DECIDED');
    }

    // Pending claim on an order that is already paid: the card path (or the
    // web mark-paid without this claim) got there first. Confirming would
    // record a second payment as verified — that is a refund conversation.
    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      throw af('The order is already paid — a second verified transfer is a refund conversation, not a verify', 409, 'ORDER_ALREADY_PAID');
    }

    const nowIso = new Date().toISOString();
    const method = methodOverride || String(claim.method);
    const reference = referenceOverride || String(claim.reference);

    // (4) The orders payment facts — the web mark-paid UPDATE, column for
    // column (routes/superadmin.js ~5141), on the txn client.
    await client.query(
      `UPDATE orders
          SET payment_status = 'paid',
              payment_method = $1,
              payment_reference = $2,
              paid_at = COALESCE(paid_at, $3),
              updated_at = $4
        WHERE id = $5`,
      [method, reference, nowIso, nowIso, order.id]
    );

    // (5) The claim closes as confirmed — the same statement
    // confirmPendingClaimForOrder issues, here atomic with the money facts.
    const confirmed = (await client.query(
      `UPDATE payment_claims
          SET status = 'confirmed', resolved_at = NOW(), resolved_by = $1, updated_at = NOW()
        WHERE id = $2 AND status = 'pending'
        RETURNING id, order_id, patient_id, method, reference, sender_name, status,
                  rejection_reason, created_at, updated_at, resolved_at, resolved_by`,
      [actorId || null, claimId]
    )).rows[0];
    if (!confirmed) throw af('This claim was already decided', 409, 'CLAIM_ALREADY_DECIDED');

    // (6) Audit, on the txn client — atomic with the writes above. The
    // order_events label is VERBATIM the web mark-paid's, so every timeline
    // consumer treats the two surfaces as the same action; meta says which
    // surface and which claim.
    await client.query(
      `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
         VALUES ($1, $2, 'Payment marked as paid (superadmin)', $3, NOW(), $4, 'superadmin')`,
      [randomUUID(), order.id,
        JSON.stringify({
          from: order.payment_status || null,
          to: 'paid',
          payment_method: method,
          payment_reference: reference,
          claim_id: claimId,
          via: 'command_api_claim_verify',
        }),
        actorId]
    );
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(),
        `payment claim ${claimId} verified for order ${order.id} (${method}, ref ${reference})`,
        actorId,
        JSON.stringify({ action: 'payment_claim_verified', caseId: order.id, claimId, method, reference })]
    );

    await client.query('COMMIT');

    return {
      claim: claimResponse(confirmed),
      order: orderResponse(Object.assign({}, order, {
        payment_status: 'paid',
        payment_method: method,
        payment_reference: reference,
        paid_at: order.paid_at || nowIso,
      })),
      patientId: order.patient_id || claim.patient_id || null,
      alreadyVerified: false,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { verifyPaymentClaim };
