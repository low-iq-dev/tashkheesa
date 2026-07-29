'use strict';
/**
 * paymob_intention — mint (at most once) a Paymob checkout link for an order,
 * SERVER-SIDE, so the MOBILE pay path can obtain a checkout URL.
 *
 * WHY: the Paymob checkout link is minted on-demand by
 * POST /payments/paymob/create-intention, which ONLY the WEB pay page calls. The
 * mobile app's app/payment.tsx only READS GET /api/v1/cases/:id/payment (which
 * returns orders.payment_link — NULL for a fresh order), so nothing on the mobile
 * path ever minted the intention → "Payment link unavailable". This helper lets
 * the GET endpoint mint it.
 *
 * It mirrors the minting CORE of that POST route (src/routes/payments.js
 * ~74-246): the SAME owedCentsForOrder charge computation, the SAME
 * paymobService.createIntention, the SAME payment_events audit rows — so the
 * charged amount can NEVER drift between the web and mobile paths. ADDITIVE: the
 * proven POST route is untouched.
 *
 * Differences from the POST route, by design:
 *   - IDEMPOTENT: mints at most ONCE per order. If orders.payment_link is already
 *     set, returns it WITHOUT creating a new intention (a returning app user
 *     reuses the same checkout instead of burning a fresh intention each load).
 *   - Does NOT re-price/persist add-ons from a request body (there is none on the
 *     GET path). It charges the order's ALREADY-PERSISTED addons_json.
 *
 * Throws Error with a `.code` for the caller to branch on:
 *   ORDER_NOT_FOUND | INVALID_AMOUNT | UNSUPPORTED_CURRENCY | PATIENT_NOT_FOUND
 *   | PATIENT_PROFILE_INCOMPLETE (carries .fields) | PAYMOB_UNAVAILABLE
 * Returns: { alreadyPaid: true } | { checkoutUrl: string }.
 */

const crypto = require('crypto');
const { queryOne, execute } = require('../pg');
const paymobService = require('./paymob');
const { owedCentsForOrder } = require('./order_pricing');
const { logErrorToDb } = require('../logger');

function err(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * @param {Object} args
 * @param {string} args.orderId
 * @param {string} args.patientId       scope: the order must belong to this patient
 * @param {string} args.redirectionUrl  Paymob post-payment return URL (built by the caller)
 * @returns {Promise<{alreadyPaid: true} | {checkoutUrl: string}>}
 */
async function ensurePaymentLinkForOrder({ orderId, patientId, redirectionUrl }) {
  const id = orderId ? String(orderId).trim() : '';
  if (!id) throw err('order_not_found', 'ORDER_NOT_FOUND');

  // Scope to patientId so one patient can never mint against another's order.
  const order = await queryOne(
    `SELECT id, patient_id, payment_status, price, currency, payment_link, addons_json, service_id
       FROM orders_active
      WHERE id = $1 AND patient_id = $2`,
    [id, patientId]
  );
  if (!order) throw err('order_not_found', 'ORDER_NOT_FOUND');

  if (String(order.payment_status || '').toLowerCase() === 'paid') {
    return { alreadyPaid: true };
  }

  // IDEMPOTENT: a link already exists → reuse it, never mint a second intention.
  if (order.payment_link) {
    return { checkoutUrl: String(order.payment_link) };
  }

  const amount = Number(order.price);
  if (!Number.isFinite(amount) || amount <= 0) throw err('invalid_amount', 'INVALID_AMOUNT');

  const currency = String(order.currency || 'EGP').toUpperCase();
  // Test mode is EGP-only; international orders already carry currency 'EGP'
  // (the charge is EGP; local figures are display-only). Non-EGP is refused.
  if (currency !== 'EGP') throw err('unsupported_currency', 'UNSUPPORTED_CURRENCY');

  // Charge = base + PERSISTED add-ons, via the SAME helper the web route and the
  // webhook use → intention and verification can never drift.
  const amountCents = owedCentsForOrder({ price: order.price, addons_json: order.addons_json || null });

  const patient = await queryOne(
    `SELECT id, name, email, phone, country, country_code FROM users WHERE id = $1`,
    [patientId]
  );
  if (!patient) throw err('patient_not_found', 'PATIENT_NOT_FOUND');

  let result;
  try {
    result = await paymobService.createIntention({
      orderId: order.id,
      amountCents: amountCents,
      currency: currency,
      patient: {
        name: patient.name,
        email: patient.email,
        phone: patient.phone,
        country: patient.country_code || patient.country || 'EG'
      },
      redirectionUrl: redirectionUrl
    });
  } catch (e) {
    if (e && e.code === 'PATIENT_PROFILE_INCOMPLETE') {
      // Rethrow unchanged — it carries .code + .fields for the caller to surface.
      throw e;
    }
    if (e && (e.code === 'PAYMOB_TIMEOUT' || e.code === 'PAYMOB_HTTP_ERROR' || e.code === 'PAYMOB_MALFORMED_RESPONSE')) {
      try {
        await execute(
          `INSERT INTO payment_events (id, order_id, event_type, payload_json, received_at)
           VALUES ($1, $2, 'intention_failed', $3, NOW())`,
          [
            'pe-' + crypto.randomUUID(),
            order.id,
            JSON.stringify({ code: e.code, message: e.message, status: e.status || null })
          ]
        );
      } catch (auditErr) {
        // Audit failure must never mask the original error.
        logErrorToDb(auditErr, { context: 'mobile_pay_intention_audit_failed' });
      }
      throw err('paymob_unavailable', 'PAYMOB_UNAVAILABLE');
    }
    // Unknown error — rethrow for the caller's catch to log.
    throw e;
  }

  // Persist intention id + checkout URL so the NEXT load reuses this link
  // (the idempotency guard above reads payment_link).
  await execute(
    `UPDATE orders SET paymob_intention_id = $1, payment_link = $2 WHERE id = $3`,
    [result.intentionId, result.checkoutUrl, order.id]
  );

  try {
    await execute(
      `INSERT INTO payment_events (id, order_id, paymob_intention_id, event_type, payload_json, received_at)
       VALUES ($1, $2, $3, 'intention_created', $4, NOW())`,
      [
        'pe-' + crypto.randomUUID(),
        order.id,
        result.intentionId,
        JSON.stringify({ amountCents: amountCents, currency: currency, source: 'mobile_pay_page' })
      ]
    );
  } catch (auditErr) {
    logErrorToDb(auditErr, { context: 'mobile_pay_intention_audit_success' });
  }

  return { checkoutUrl: result.checkoutUrl };
}

module.exports = { ensurePaymentLinkForOrder };
