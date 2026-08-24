'use strict';

// Add-on settlement — one implementation, called from every path that can
// mark an order paid.
//
// 2026-08-24. Until now this logic existed once, inline, in the Paymob webhook
// (routes/payments.js). That is a problem, because the Paymob webhook has never
// fired in production: the integration is refusing the live credentials, and
// every paid order on the platform got there through
// POST /admin/orders/:id/mark-paid or its superadmin twin. Neither of those
// touches add-ons at all — they set payment_status, paid_at and payment_method
// and call markCasePaid, and stop.
//
// So a patient could tick "Digital Prescription", pay by bank transfer, have an
// operator mark the case paid, and:
//   * orders.addons_json would still say the add-on was merely SELECTED, not
//     settled, so nothing downstream could tell the difference between a
//     purchase and an abandoned checkout;
//   * the 'Prescription add-on selected' order_event — which
//     services/addons/prescription_access.js requires as its receipt — would
//     never be written, so the doctor's case page would say "not purchased"
//     forever;
//   * no order_addons row would exist, so onFulfill has nothing to fulfil and
//     onComplete never pays the doctor their commission;
//   * the patient would never get their confirmation.
//
// The money is collected and the product silently does not exist. Extracting
// the block and calling it from all three entry points is the fix.
//
// Two deliberate departures from the inline original:
//
//   1. onPurchase is NO LONGER wrapped in safeDualWrite. That helper returns
//      undefined without calling anything when ADDON_SYSTEM_V2 is not exactly
//      'true', and it swallows its own errors. Creating the order_addons row is
//      idempotent bookkeeping about money that has already been collected —
//      there is no scenario where skipping it is the safe outcome, and skipping
//      it silently loses the doctor their commission. The flag stays meaningful
//      for the things it was built to gate (the /api/orders/.../addons
//      endpoints, the video earnings write); it should never have been able to
//      decide whether a purchase gets recorded.
//
//   2. It is idempotent by construction, because operators retry. Every write
//      is either an ON CONFLICT DO NOTHING / DO UPDATE, a jsonb merge, or is
//      guarded by an existence check on the order_addons ROW.
//
// ── The verification contract (added after review, 2026-08-24) ──────────────
//
// The first version of this module was called straight from mark-paid, and
// that was wrong in a way worth spelling out, because it is easy to
// reintroduce.
//
// services/addons/prescription_access.js treats the 'Prescription add-on
// selected' order_event as its RECEIPT, and it is safe to do so for exactly
// one reason: that line was only ever written inside the payment callback,
// after the charged amount had been checked against owedCentsForOrder. Writing
// the same line from mark-paid — a handler with no amount field anywhere in it
// — keeps the marker and throws away the property that made it meaningful.
//
// The concrete cost: a patient ticks Video consultation, abandons the gateway,
// bank-transfers the BASE FEE only, and an operator marks the case paid. The
// add-on is recorded as bought, the patient is emailed a confirmation for it,
// and onComplete later pays the doctor 85% of 200 EGP against nothing
// collected. Prescription is worse at 50% of 400.
//
// So settlement now requires the caller to say HOW payment was established:
//
//   'gateway_amount_check'  the gateway confirmed an amount and
//                           owedCentsForOrder verified it covers base + add-ons.
//                           Only the Paymob callback may claim this.
//   'operator_assertion'    a human is asserting they received the money for
//                           these specific add-ons, and their user id is on the
//                           record. This is a second, deliberate click — never
//                           a side effect of marking the base fee paid.
//
// Anything else refuses and records the add-ons as awaiting settlement, which
// the admin order page surfaces as an outstanding action.

const { queryOne, execute } = require('../pg');
const { logOrderEvent } = require('../audit');
const { getAddon } = require('./addons/registry');
const { parseSelectedAddons } = require('./order_pricing');
const { resolveAddonPrice } = require('./addons/pricing');

/**
 * The EGP figure to stamp on order_addons.price_at_purchase_egp.
 *
 * That column is what prescription.onComplete / video_consult.onComplete
 * multiply by the commission percentage, so it has to be EGP. Passing a
 * charged amount straight through — which the first version did — means a
 * non-EGP order pays the doctor a percentage of a number in the wrong unit.
 * services/addons/prescription_access.js already handled this correctly, so
 * the purchase path and the backfill path disagreed: exactly the
 * two-answers-to-one-question defect this whole change set out to remove.
 *
 * The charged amount IS the EGP amount when the order is in EGP. Otherwise the
 * charged amount stays on price_at_purchase_amount with its own currency, and
 * the EGP column takes the catalogue's EGP price.
 */
async function toEgpAmount(addonServiceId, chargedAmount, currency) {
  if (String(currency || 'EGP').toUpperCase() === 'EGP') return chargedAmount;
  const egp = await resolveAddonPrice(addonServiceId, 'EGP');
  return egp ? Number(egp.amount) || 0 : 0;
}

const VIDEO_EVENT = 'Video consultation add-on selected';
const RX_EVENT    = 'Prescription add-on selected';

/**
 * Has this add-on already been settled on this order?
 *
 * Keyed on the order_addons ROW, not on the order_event — a correction from
 * review. The first version logged the event BEFORE calling onPurchase, so any
 * failure in between (a transient DB error, or addon_services.is_active toggled
 * off, which makes resolveAddonPrice return null and onPurchase throw) left the
 * marker behind with no row. Every retry then short-circuited on the marker,
 * the row was never created, onFulfill had nothing to fulfil, onComplete never
 * ran, and the doctor was never paid — permanently, with no operator action
 * that could recover it.
 *
 * The row is the thing that actually has to exist, so the row is what we check.
 * It is also protected by a unique index on (order_id, addon_service_id), so
 * the check and the write agree even under a double-click.
 */
async function alreadySettled(orderId, addonServiceId) {
  try {
    const row = await queryOne(
      `SELECT 1 AS ok FROM order_addons
        WHERE order_id = $1 AND addon_service_id = $2 LIMIT 1`,
      [orderId, addonServiceId]
    );
    return !!row;
  } catch (_) {
    // Unreadable: assume NOT settled. A duplicate row is impossible (unique
    // index) and a duplicate confirmation email is a far better failure than a
    // doctor never being paid.
    return false;
  }
}

/**
 * Settle every add-on the patient selected on an order that has just been paid.
 *
 * Never throws. A settlement failure must not turn a successful payment into a
 * 500 for the payer or a failed mark-paid for the operator — but every failure
 * is written to the order's activity log, because an add-on that silently did
 * not settle is money taken for a product nobody knows to deliver.
 *
 * @param {Object}   args
 * @param {string}   args.orderId
 * @param {Object}   [args.order]        the orders row, if the caller has it
 * @param {string}   args.verifiedBy     'gateway_amount_check' | 'operator_assertion'.
 *                                       REQUIRED. See the verification contract
 *                                       at the top of this file — settling an
 *                                       add-on is asserting its money arrived,
 *                                       and the caller has to say how it knows.
 * @param {string}   [args.via]          how payment was taken: 'paymob_webhook'
 *                                       | 'admin_settle_addons' | 'superadmin_settle_addons'
 * @param {string}   [args.actorUserId]
 * @param {string}   [args.actorRole='system']
 * @param {Function} [args.notify]       queueMultiChannelNotification, injected
 *                                       so this module does not pull the notify
 *                                       stack into every caller
 * @returns {Promise<{settled: string[], skipped: string[], failed: string[], refused?: string}>}
 */
const VALID_VERIFICATION = ['gateway_amount_check', 'operator_assertion'];

async function settleAddonsForPaidOrder({
  orderId,
  order = null,
  verifiedBy = null,
  via = 'unknown',
  actorUserId = null,
  actorRole = 'system',
  notify = null
} = {}) {
  const result = { settled: [], skipped: [], failed: [] };
  if (!orderId) return result;

  // Refuse rather than default. A default here would be a default answer to
  // "did the money arrive?", and the only safe answer to that is "you tell me".
  if (!VALID_VERIFICATION.includes(String(verifiedBy || ''))) {
    result.refused = 'no_verification_basis';
    console.error('[addon-settlement] refused for order ' + orderId +
      ' — verifiedBy must be one of ' + VALID_VERIFICATION.join(' | ') +
      ', got ' + JSON.stringify(verifiedBy));
    return result;
  }

  let ord = order;
  if (!ord) {
    try {
      ord = await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]);
    } catch (_) {
      ord = null;
    }
  }
  if (!ord) return result;

  const selected = parseSelectedAddons(ord);
  const currency = String(ord.locked_currency || ord.currency || 'EGP').toUpperCase();

  // ─────────────────────────── video consultation ───────────────────────────
  if (selected.video_consultation) {
    let videoEnabled = true;
    try {
      videoEnabled = require('../video_helpers').isVideoEnabled();
    } catch (_) { videoEnabled = false; }

    if (!videoEnabled) {
      // Kill-switch flipped between charge and settlement. The case payment
      // stands; the add-on cannot be delivered.
      //
      // This is NOT a benign skip, and the original inline version treated it
      // as one — a silent order_event and nothing else. If the patient was
      // charged for the add-on at intention time and the flag went off before
      // settlement, they have paid for something that will never exist, and no
      // human is told. It is reported as failed so the caller and the admin
      // page both see an outstanding line, and it stays retryable: nothing has
      // been written, so re-running after the flag comes back settles it
      // normally.
      result.failed.push('video_consult');
      try {
        logOrderEvent({
          orderId,
          label: 'Video consultation add-on NOT settled — feature disabled',
          meta: JSON.stringify({
            via,
            charged: Number(selected.video_consultation_price) || null,
            note: 'patient may have paid for an add-on that cannot be delivered — refund or re-enable'
          }),
          actorUserId,
          actorRole
        });
      } catch (_) {}
    } else if (await alreadySettled(orderId, 'video_consult')) {
      result.skipped.push('video_consult');
    } else {
      try {
        // Price precedence: what was LOCKED on the order at intention time —
        // that is the figure owedCentsForOrder verified against what the
        // gateway actually charged. Re-reading a catalogue first would silently
        // adopt any price change made between checkout and settlement.
        let videoPrice = Number(selected.video_consultation_price) || 0;
        let priceSource = 'order.addons_json (charged)';
        if (videoPrice <= 0) {
          // Review correction: this fallback used to read
          // services.video_consultation_prices_json, which is populated on 0 of
          // 168 rows, so it always produced 0 — and unlike the prescription
          // branch it had no `> 0` guard. A legacy row would have recorded the
          // add-on at 0 on the order while onPurchase, seeing a falsy
          // chargedPriceEgp, fell back to the registry's 200 and paid the
          // doctor 170. Same catalogue as everything else now.
          const resolved = await resolveAddonPrice('video_consult', currency);
          videoPrice = resolved ? Number(resolved.amount) || 0 : 0;
          priceSource = 'addon_services (fallback)';
        }
        if (!(videoPrice > 0)) throw new Error('video_consult addon has no resolvable price');

        const videoEgp = await toEgpAmount('video_consult', videoPrice, currency);

        // MERGE, never replace: a wholesale replace here once wiped the
        // prescription lines charged in the same transaction.
        await execute(
          `UPDATE orders
              SET video_consultation_selected = true,
                  video_consultation_price = $1,
                  addons_json = COALESCE(addons_json, '{}')::jsonb || $2::jsonb
            WHERE id = $3`,
          [videoPrice, JSON.stringify({ video_consultation: true, video_consultation_price: videoPrice }), orderId]
        );

        // Ungated on purpose — see the note at the top of this file.
        const svc = getAddon('video_consult');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'video_consult'`);
        if (svc && addonService) {
          await svc.onPurchase({ order: ord, addonService, currency, chargedPriceEgp: videoEgp });
        } else {
          throw new Error('video_consult addon not registered/seeded');
        }

        // The event is written AFTER the row exists, never before. It is the
        // human-readable receipt and prescription_access reads its sibling as
        // proof of purchase; writing it ahead of the money write meant a
        // failure left a receipt for a purchase that had not happened.
        logOrderEvent({
          orderId,
          label: VIDEO_EVENT,
          meta: JSON.stringify({
            price: videoPrice, price_egp: videoEgp, currency,
            price_source: priceSource, via, verified_by: verifiedBy
          }),
          actorUserId,
          actorRole
        });

        if (typeof notify === 'function') {
          Promise.resolve(notify({
            orderId,
            toUserId: ord.patient_id,
            channels: ['email', 'whatsapp', 'internal'],
            template: 'addon_purchased_video',
            response: { order_id: orderId, caseReference: String(orderId).slice(0, 12).toUpperCase() }
          })).catch(function(err) {
            console.error('[addon-settlement] addon_purchased_video queue failed:', err && err.message);
          });
        }

        result.settled.push('video_consult');
      } catch (e) {
        result.failed.push('video_consult');
        console.error('[addon-settlement] video_consult failed:', e && e.message ? e.message : e);
        try {
          logOrderEvent({
            orderId,
            label: 'Video consultation add-on processing failed',
            meta: JSON.stringify({ error: String(e && e.message ? e.message : e), via }),
            actorRole: 'system'
          });
        } catch (_) {}
      }
    }
  }

  // ───────────────────────────── prescription ─────────────────────────────
  //
  // NOTE: the sla_24hr branch that used to sit between these two was dead after
  // migration 019b. Faster turnaround is an urgency TIER on main-service
  // pricing, not an add-on — see docs/architecture/addon_service_abstraction.md
  // §0 and §1.2. Do not reintroduce it here.
  if (selected.prescription) {
    if (await alreadySettled(orderId, 'prescription')) {
      result.skipped.push('prescription');
    } else {
      try {
        let rxPrice = Number(selected.prescription_price) || 0;
        let priceSource = 'order.addons_json (charged)';
        if (rxPrice <= 0) {
          // Single fallback, one number. The old inline version hardcoded 350
          // here while prescription_access fell back to addon_services' 400 —
          // the same missing price row producing two different answers, and
          // owedCentsForOrder verified against neither. addon_services is the
          // registry and therefore the authority.
          const resolved = await resolveAddonPrice('prescription', currency);
          rxPrice = resolved ? Number(resolved.amount) || 0 : 0;
          priceSource = 'addon_services (fallback)';
        }
        if (!(rxPrice > 0)) throw new Error('prescription addon has no resolvable price');

        const rxEgp = await toEgpAmount('prescription', rxPrice, currency);

        await execute(
          `UPDATE orders
              SET addons_json = COALESCE(addons_json, '{}')::jsonb || $1::jsonb
            WHERE id = $2`,
          [JSON.stringify({ prescription: true, prescription_price: rxPrice }), orderId]
        );

        const svc = getAddon('prescription');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'prescription'`);
        if (svc && addonService) {
          await svc.onPurchase({ order: ord, addonService, currency, chargedPriceEgp: rxEgp });
        } else {
          throw new Error('prescription addon not registered/seeded');
        }

        // After the row, never before — see the video branch.
        logOrderEvent({
          orderId,
          label: RX_EVENT,
          meta: JSON.stringify({
            price: rxPrice, price_egp: rxEgp, currency,
            price_source: priceSource, via, verified_by: verifiedBy
          }),
          actorUserId,
          actorRole
        });

        if (typeof notify === 'function') {
          Promise.resolve(notify({
            orderId,
            toUserId: ord.patient_id,
            channels: ['email', 'whatsapp', 'internal'],
            template: 'addon_purchased_prescription',
            response: { order_id: orderId, caseReference: String(orderId).slice(0, 12).toUpperCase() }
          })).catch(function(err) {
            console.error('[addon-settlement] addon_purchased_prescription queue failed:', err && err.message);
          });
        }

        result.settled.push('prescription');
      } catch (e) {
        result.failed.push('prescription');
        console.error('[addon-settlement] prescription failed:', e && e.message ? e.message : e);
        try {
          logOrderEvent({
            orderId,
            label: 'Prescription add-on processing failed',
            meta: JSON.stringify({ error: String(e && e.message ? e.message : e), via }),
            actorRole: 'system'
          });
        } catch (_) {}
      }
    }
  }

  return result;
}

module.exports = { settleAddonsForPaidOrder, VIDEO_EVENT, RX_EVENT };
