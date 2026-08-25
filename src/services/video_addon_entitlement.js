'use strict';

// services/video_addon_entitlement.js
//
// AUDIT-2026-08-22 (R1 / R2, P0) — giving back a video consultation that was
// funded by the CASE add-on rather than by its own card payment.
//
// ─── The hole this closes ───────────────────────────────────────────────────
//
// POST /portal/video/book (routes/video.js) can fund an appointment out of the
// video-consultation add-on the patient already bought at case checkout. When
// it does, it stamps `video_consultation_consumed_by: <appointmentId>` on
// orders.addons_json and writes the appointment_payments row with
// status='paid', method='order_addon' — a MARKER, not a second charge. There
// is no separate payment behind that row and no Paymob transaction to reverse.
//
// Every terminal path then did the same thing to it that it does to a real
// card payment:
//
//     UPDATE appointment_payments SET status = 'refunded'
//
// and told the patient they had been refunded. For method='order_addon' that
// statement moves no money, writes no `refunds` row, and — critically — leaves
// `video_consultation_consumed_by` set. readVideoAddonEntitlement then returns
// null forever, so the patient is quoted the full add-on price to rebook a
// consultation they already paid for and never received. Net: 800 EGP kept,
// nothing delivered, and a WhatsApp claiming a refund.
//
// ─── Release, not refund ────────────────────────────────────────────────────
//
// Two repairs were possible: write a real `refunds` row, or hand the
// entitlement back. Releasing is the correct one here, and deliberately so:
//
//   * The patient bought ONE consultation and has not had one. Handing the
//     entitlement back restores exactly what they paid for, immediately, with
//     no operator in the loop — refunds on this platform are manual InstaPay
//     (services/admin_refund.js), so the refund route means days of waiting
//     for money they would only spend on the same product again.
//   * A `refunds` row against the case order would also collide with the
//     one-open-refund-per-order slot (migration 083) and distort the closure
//     arithmetic in services/refund_closure.js.
//   * Releasing is idempotent and self-limiting: the UPDATE is keyed on the
//     appointment id, so an entitlement can only ever be released by the
//     appointment that consumed it. A later appointment's terminal transition
//     cannot free a claim that is not its own, and a double-fire of the same
//     path is a no-op.
//
// The patient who genuinely wants their money back still refunds the CASE —
// and services/refund_eligibility.maxRefundableEgp only excludes the add-on
// from the ceiling while it is CONSUMED, so a released entitlement is fully
// refundable again. The two halves are deliberately symmetric.
//
// ─── Why status='released' and not 'refunded' ───────────────────────────────
//
// appointment_payments.status is free TEXT (migration 004). 'refunded' is a
// claim that money went back to the patient, and finance reads it that way
// (superadmin_dashboard's Paymob-today panel, the admin refund totals). No
// money went back, so it must not say so. 'released' keeps every downstream
// `status === 'paid'` money guard behaving exactly as 'refunded' did (the row
// is no longer paid, so no earnings are written against it) while reading
// honestly in reconciliation. refunded_at is deliberately NOT stamped.

const { queryOne, execute } = require('../pg');

const ADDON_PAYMENT_METHOD = 'order_addon';
const RELEASED_STATUS = 'released';

/**
 * Release an add-on-funded video consultation back to the patient.
 *
 * Safe to call on ANY appointment: it resolves the payment row first and
 * returns `{ addonFunded: false }` untouched when the appointment was paid for
 * with a real card payment (the caller then keeps its existing refund path).
 *
 * Non-throwing is NOT promised — callers on a money path should let a failure
 * surface rather than silently continuing to tell the patient they were
 * refunded. Callers on a sweep loop should wrap it so one bad row does not
 * abort the tick.
 *
 * @param {object}  opts
 * @param {string}  opts.appointmentId  the appointment being terminated
 * @param {string} [opts.orderId]       the case order that carries the marker
 * @param {string} [opts.paymentId]     appointments.payment_id, when known
 * @param {string} [opts.reason]        recorded on appointment_payments
 * @returns {Promise<{addonFunded:boolean, released:boolean, paymentClosed:boolean,
 *                    amount:(number|null), currency:(string|null)}>}
 */
async function releaseVideoAddonEntitlement(opts) {
  const o = opts || {};
  const appointmentId = o.appointmentId || null;
  const orderId = o.orderId || null;
  const reason = o.reason || 'Consultation not delivered — add-on entitlement returned to patient';

  const out = {
    addonFunded: false,
    released: false,
    paymentClosed: false,
    amount: null,
    currency: null
  };
  if (!appointmentId) return out;

  // Resolve by payment_id when the caller has it (that is the row every other
  // guard in routes/video.js resolves through), and fall back to the
  // appointment link so a caller that only holds the appointment still works.
  let payment = null;
  if (o.paymentId) {
    payment = await queryOne(
      `SELECT id, method, status, amount, currency
         FROM appointment_payments WHERE id = $1`,
      [o.paymentId]
    );
  }
  if (!payment) {
    payment = await queryOne(
      `SELECT id, method, status, amount, currency
         FROM appointment_payments
        WHERE appointment_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [appointmentId]
    );
  }
  if (!payment) return out;
  if (String(payment.method || '').toLowerCase() !== ADDON_PAYMENT_METHOD) return out;

  out.addonFunded = true;
  out.amount = (payment.amount == null) ? null : Number(payment.amount);
  out.currency = payment.currency || 'EGP';

  // 1. Hand the entitlement back FIRST. Ordering matters: if this succeeds and
  //    step 2 fails, the patient can rebook for free (a stale 'paid' marker row
  //    on a cancelled appointment is inert). The opposite ordering would leave
  //    the entitlement burned with the payment row already closed — the exact
  //    failure this module exists to prevent.
  //
  //    `= $2` is the whole safety property: only the appointment that took the
  //    claim can give it back. Mirrors the conditional UPDATE that claimed it
  //    in POST /portal/video/book. Text-shaped `->>` comparison, never
  //    `::boolean`, so malformed JSON cannot raise here.
  if (orderId) {
    const releaseRes = await execute(
      `UPDATE orders
          SET addons_json = (COALESCE(addons_json, '{}')::jsonb
                               - 'video_consultation_consumed_by'
                               - 'video_consultation_consumed_at')
        WHERE id = $1
          AND (COALESCE(addons_json, '{}')::jsonb ->> 'video_consultation_consumed_by') = $2`,
      [orderId, appointmentId]
    );
    out.released = !!(releaseRes && releaseRes.rowCount > 0);
  }

  // 2. Close the marker row honestly. Guarded on method so this can never
  //    rewrite a real card payment, and on status so a re-run is a no-op.
  const closeRes = await execute(
    `UPDATE appointment_payments
        SET status = $1,
            refund_reason = $2
      WHERE id = $3
        AND method = $4
        AND status <> $1`,
    [RELEASED_STATUS, reason, payment.id, ADDON_PAYMENT_METHOD]
  );
  out.paymentClosed = !!(closeRes && closeRes.rowCount > 0);

  return out;
}

module.exports = {
  releaseVideoAddonEntitlement,
  ADDON_PAYMENT_METHOD,
  RELEASED_STATUS
};
