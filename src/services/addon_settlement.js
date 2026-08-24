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
//      guarded by an existence check on the order_event.

const { queryOne, execute } = require('../pg');
const { logOrderEvent } = require('../audit');
const { getAddon } = require('./addons/registry');
const { parseSelectedAddons } = require('./order_pricing');

/**
 * Resolve a per-currency add-on price from a JSON price map.
 *
 * Moved here from routes/payments.js so the webhook and the two mark-paid
 * paths cannot drift apart on how a price is read. Mirrors the pay page's
 * resolvePriceFromJson (routes/patient.js) so the DISPLAYED price and the
 * CHARGED price come from the same source.
 */
function resolveAddonJsonPrice(jsonStr, currency, fallback) {
  if (!jsonStr || jsonStr === '{}') return fallback || 0;
  try {
    const p = (typeof jsonStr === 'string') ? JSON.parse(jsonStr) : jsonStr;
    const c = (currency || 'EGP').toUpperCase();
    if (p[c] !== undefined && p[c] !== null) return Number(p[c]);
    if (p.EGP !== undefined) return Number(p.EGP);
    return fallback || 0;
  } catch (_) { return fallback || 0; }
}

const VIDEO_EVENT = 'Video consultation add-on selected';
const RX_EVENT    = 'Prescription add-on selected';

/**
 * Has this add-on already been settled on this order?
 *
 * The order_event is the marker rather than the order_addons row, because the
 * event is what prescription_access treats as the receipt and what a human
 * reads in the activity log. Checking it keeps a re-run from writing a second
 * line and re-sending the patient a second confirmation email.
 */
async function alreadySettled(orderId, label) {
  try {
    const row = await queryOne(
      `SELECT 1 AS ok FROM order_events WHERE order_id = $1 AND label = $2 LIMIT 1`,
      [orderId, label]
    );
    return !!row;
  } catch (_) {
    // Unreadable audit log: assume NOT settled. A duplicate order_addons row is
    // impossible (unique index) and a duplicate confirmation email is a far
    // better failure than a doctor never being paid.
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
 * @param {string}   [args.via]          how payment was taken: 'paymob_webhook'
 *                                       | 'admin_mark_paid' | 'superadmin_mark_paid'
 * @param {string}   [args.actorUserId]
 * @param {string}   [args.actorRole='system']
 * @param {Function} [args.notify]       queueMultiChannelNotification, injected
 *                                       so this module does not pull the notify
 *                                       stack into every caller
 * @returns {Promise<{settled: string[], skipped: string[], failed: string[]}>}
 */
async function settleAddonsForPaidOrder({
  orderId,
  order = null,
  via = 'unknown',
  actorUserId = null,
  actorRole = 'system',
  notify = null
} = {}) {
  const result = { settled: [], skipped: [], failed: [] };
  if (!orderId) return result;

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
      // Kill-switch. The case payment still stands; the add-on does not.
      result.skipped.push('video_consult');
      try {
        logOrderEvent({
          orderId,
          label: 'video_consultation_addon_skipped_feature_disabled',
          meta: JSON.stringify({ via }),
          actorRole
        });
      } catch (_) {}
    } else if (await alreadySettled(orderId, VIDEO_EVENT)) {
      result.skipped.push('video_consult');
    } else {
      try {
        // Price precedence: what was LOCKED on the order at intention time —
        // that is the figure owedCentsForOrder verified against what the
        // gateway actually charged. The catalogue read is only a fallback for
        // legacy rows whose addons_json carries no price. Re-reading the
        // catalogue first would silently adopt any price change made between
        // checkout and settlement.
        let videoPrice = Number(selected.video_consultation_price) || 0;
        let priceSource = 'order.addons_json (charged)';
        if (videoPrice <= 0) {
          const service = await queryOne('SELECT * FROM services WHERE id = $1', [ord.service_id]);
          videoPrice = resolveAddonJsonPrice(
            service && service.video_consultation_prices_json,
            currency,
            Number(service && service.video_consultation_price) || 0
          );
          priceSource = 'services.video_consultation_prices_json (fallback)';
        }

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

        logOrderEvent({
          orderId,
          label: VIDEO_EVENT,
          meta: JSON.stringify({ price: videoPrice, price_source: priceSource, via }),
          actorUserId,
          actorRole
        });

        // Ungated on purpose — see the note at the top of this file.
        const svc = getAddon('video_consult');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'video_consult'`);
        if (svc && addonService) {
          await svc.onPurchase({ order: ord, addonService, currency, chargedPriceEgp: videoPrice });
        } else {
          throw new Error('video_consult addon not registered/seeded');
        }

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
    if (await alreadySettled(orderId, RX_EVENT)) {
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
          const resolved = await queryOne(
            `SELECT base_price_egp, prices_json FROM addon_services
              WHERE id = 'prescription' AND COALESCE(is_active, true) = true`
          );
          const per = (resolved && resolved.prices_json) || {};
          const fromJson = Number(per[currency]);
          rxPrice = Number.isFinite(fromJson) && fromJson > 0
            ? Math.round(fromJson)
            : Math.round(Number(resolved && resolved.base_price_egp) || 0);
          priceSource = 'addon_services (fallback)';
        }
        if (!(rxPrice > 0)) throw new Error('prescription addon has no resolvable price');

        await execute(
          `UPDATE orders
              SET addons_json = COALESCE(addons_json, '{}')::jsonb || $1::jsonb
            WHERE id = $2`,
          [JSON.stringify({ prescription: true, prescription_price: rxPrice }), orderId]
        );

        logOrderEvent({
          orderId,
          label: RX_EVENT,
          meta: JSON.stringify({ price: rxPrice, currency, price_source: priceSource, via }),
          actorUserId,
          actorRole
        });

        const svc = getAddon('prescription');
        const addonService = await queryOne(`SELECT * FROM addon_services WHERE id = 'prescription'`);
        if (svc && addonService) {
          await svc.onPurchase({ order: ord, addonService, currency, chargedPriceEgp: rxPrice });
        } else {
          throw new Error('prescription addon not registered/seeded');
        }

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

module.exports = { settleAddonsForPaidOrder, resolveAddonJsonPrice, VIDEO_EVENT, RX_EVENT };
