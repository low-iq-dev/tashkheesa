'use strict';
// src/routes/payments_kashier.js
//
// POST /payments/kashier/webhook — the ONLY place a Kashier payment marks a
// case paid (2026-10-05).
//
// It is deliberately the same shape as POST /payments/callback (Paymob), step
// for step, because every one of those steps exists there for a reason that
// was learned the hard way:
//
//   1. signature        — HMAC over the fields Kashier says it signed, AND a
//                         check that the fields we act on are among them
//                         (src/kashier-signature.js).
//   2. per-transaction  — advisory lock + a provisional payment_events row so
//      idempotency        two deliveries of one transaction cannot both run
//                         markCasePaid, and a crashed delivery can be retried.
//   3. amount           — what Kashier says it charged must equal what the
//                         order owes (owedCentsForOrder), to the piastre and
//                         in the same currency. Otherwise the case stays
//                         UNPAID and a human is paged.
//   4. guarded UPDATE   — payment_status flips only if it was not already
//                         'paid'.
//   5. lifecycle        — markCasePaid, notifications, add-on settlement.
//
// The browser redirect back from Kashier is NOT trusted for money; see
// GET /portal/patient/payment-return/k/:id in routes/patient.js.
//
// processKashierEvent() holds the logic and takes its dependencies as an
// argument so the tests can drive every branch without a database.

const express = require('express');
const crypto = require('crypto');

const router = express.Router();
// There is no app-level JSON parser (only urlencoded, src/middleware.js): each
// router that takes JSON parses it itself, exactly as routes/payments.js does.
// Without this line req.body is undefined and every webhook fails signature
// verification as 'malformed_payload'.
router.use(express.json({ limit: '1mb' }));

const PROVISIONAL_EVENT_TYPE = 'webhook_processing';
const CLAIM_TAKEOVER_SECONDS = 60;

// Money coming IN.
const PAY_EVENTS = ['pay', 'capture'];
// Money going BACK. Never marks anything paid; a human reconciles.
const REVERSAL_EVENTS = ['refund', 'partial_refund', 'void', 'reversal'];

function realDeps() {
  const pg = require('../pg');
  const payments = require('./payments');
  const notify = require('../notify');
  return {
    pool: pg.pool,
    queryOne: pg.queryOne,
    execute: pg.execute,
    kashier: require('../services/kashier'),
    verifyKashierSignature: require('../kashier-signature').verifyKashierSignature,
    SIGNATURE_HEADER: require('../kashier-signature').SIGNATURE_HEADER,
    orderIdFromReference: payments.orderIdFromReference,
    getOrCreatePaymentUrl: payments.getOrCreatePaymentUrl,
    owedCentsForOrder: require('../services/order_pricing').owedCentsForOrder,
    markCasePaid: require('../case_lifecycle').markCasePaid,
    settleAddonsForPaidOrder: require('../services/addon_settlement').settleAddonsForPaidOrder,
    queueMultiChannelNotification: notify.queueMultiChannelNotification,
    notifyAdmins: notify.notifyAdmins,
    logOrderEvent: require('../audit').logOrderEvent,
    logErrorToDb: require('../logger').logErrorToDb,
    sendCriticalAlert: require('../critical-alert').sendCriticalAlert,
    pushOpsEvent: function () {
      return require('../services/ops_push').pushOpsEvent.apply(null, arguments);
    }
  };
}

function safeAlert(d, msg, key) {
  try { d.sendCriticalAlert(msg, key); } catch (_) {}
}

/**
 * @param {object} input  { body, headerSig, ip, userAgent, requestId }
 * @param {object} d      dependencies (realDeps() in production)
 * @returns {Promise<{http: number, json: object}>}
 */
async function processKashierEvent(input, d) {
  const body = input.body || {};
  const cfg = d.kashier.readConfig();

  if (!cfg.apiKey) {
    return { http: 503, json: { ok: false, error: 'webhook_not_configured' } };
  }

  // ── 1. Signature ─────────────────────────────────────────────────────────
  const sig = d.verifyKashierSignature(body, input.headerSig, cfg.apiKey);
  if (!sig.ok) {
    console.warn('[kashier-webhook] signature rejected:', sig.reason, 'ip:', input.ip);
    try {
      await d.execute(
        `INSERT INTO payment_events (id, event_type, payload_json, hmac_verified, received_at)
         VALUES ($1, 'hmac_failure', $2, false, NOW())`,
        [
          'pe-' + crypto.randomUUID(),
          JSON.stringify({
            provider: 'kashier',
            reason: sig.reason,
            ip: input.ip || null,
            user_agent: input.userAgent || null,
            request_id: input.requestId || null
          })
        ]
      );
    } catch (auditErr) {
      d.logErrorToDb(auditErr, { context: 'kashier_webhook_hmac_failure_audit' });
    }
    safeAlert(d,
      'Kashier webhook signature failure (' + sig.reason + ') from ip=' +
      (input.ip || 'unknown') + ' req=' + (input.requestId || 'n/a'),
      'kashier_hmac_failure');
    return { http: 401, json: { ok: false, error: 'unauthorized' } };
  }

  const data = body.data;
  const event = String(body.event || '').toLowerCase();
  const kStatus = String(data.status || '').toUpperCase();          // SIGNED
  const orderId = d.orderIdFromReference(data.merchantOrderId);     // SIGNED
  const txnRaw = data.transactionId || data.kashierOrderId || null;
  const txnKey = txnRaw ? ('kashier:' + String(txnRaw)) : null;
  const method = data.method ? String(data.method) : null;
  const reference = data.orderReference || data.kashierOrderId || null;

  if (!orderId) {
    return { http: 400, json: { ok: false, error: 'order_id required' } };
  }

  const isReversal = REVERSAL_EVENTS.indexOf(event) !== -1;
  const isPayEvent = PAY_EVENTS.indexOf(event) !== -1;
  // What this delivery MEANS. `data.status` is signed; `event` is not, so an
  // event we do not recognise can never be promoted to "paid" — it is
  // recorded, paged, and left for a person.
  const outcome =
      isReversal                              ? 'reversal'
    : (kStatus === 'PENDING')                 ? 'pending'
    : (kStatus === 'FAILURE' || event === 'reject') ? 'failed'
    : (kStatus === 'SUCCESS' && isPayEvent)   ? 'paid'
    : 'other';

  const finalEventType =
      outcome === 'reversal' ? 'refund_or_void_received'
    : outcome === 'paid'     ? 'payment_succeeded'
    : outcome === 'failed'   ? 'payment_failed'
    : 'webhook_received';

  // ── 2. Per-transaction lock + claim ──────────────────────────────────────
  let lockClient = null;
  let claimOwned = false;
  // The claim key includes the status: Kashier legitimately sends PENDING and
  // then SUCCESS for ONE transactionId, and the first must not swallow the
  // second.
  const claimKey = txnKey ? (txnKey + ':' + (isReversal ? event : kStatus)) : null;

  try {
    if (claimKey) {
      try {
        lockClient = await d.pool.connect();
        await lockClient.query('BEGIN');
        const lockRow = await lockClient.query(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
          [claimKey]
        );
        const got = !!(lockRow && lockRow.rows && lockRow.rows[0] && lockRow.rows[0].locked);
        if (!got) {
          return { http: 503, json: { ok: false, error: 'processing_in_progress' } };
        }
      } catch (lockErr) {
        d.logErrorToDb(lockErr, { context: 'kashier_webhook_txn_lock', orderId, category: 'payment' });
        return { http: 503, json: { ok: false, error: 'lock_unavailable' } };
      }

      const ins = await d.execute(
        `INSERT INTO payment_events
           (id, order_id, paymob_transaction_id, event_type, payload_json, hmac_verified, received_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (paymob_transaction_id) WHERE paymob_transaction_id IS NOT NULL DO NOTHING`,
        ['pe-' + crypto.randomUUID(), orderId, claimKey, PROVISIONAL_EVENT_TYPE, JSON.stringify(body)]
      );
      if (ins && ins.rowCount > 0) {
        claimOwned = true;
      } else {
        const takeover = await d.execute(
          `UPDATE payment_events
              SET received_at = NOW(), order_id = $3, payload_json = $4
            WHERE paymob_transaction_id = $1
              AND event_type = $2
              AND received_at < NOW() - INTERVAL '${CLAIM_TAKEOVER_SECONDS} seconds'`,
          [claimKey, PROVISIONAL_EVENT_TYPE, orderId, JSON.stringify(body)]
        );
        if (takeover && takeover.rowCount > 0) {
          claimOwned = true;
          d.logOrderEvent({
            orderId,
            label: 'Kashier webhook: re-processing an abandoned webhook claim',
            meta: JSON.stringify({ kashier_transaction: txnRaw, status: kStatus }),
            actorRole: 'system'
          });
        } else {
          const held = await d.queryOne(
            `SELECT event_type FROM payment_events WHERE paymob_transaction_id = $1 LIMIT 1`,
            [claimKey]
          );
          if (held && String(held.event_type) === PROVISIONAL_EVENT_TYPE) {
            return { http: 503, json: { ok: false, error: 'processing_in_progress' } };
          }
          d.logOrderEvent({
            orderId,
            label: 'Kashier webhook: idempotent replay (already recorded)',
            meta: JSON.stringify({ kashier_transaction: txnRaw, status: kStatus, recorded_event_type: held ? held.event_type : null }),
            actorRole: 'system'
          });
          return { http: 200, json: { ok: true, idempotent: true } };
        }
      }
    }

    const finalizeClaim = async function (typeOverride) {
      if (!claimKey || !claimOwned) return;
      try {
        await d.execute(
          `UPDATE payment_events SET event_type = $2
            WHERE paymob_transaction_id = $1 AND event_type = $3`,
          [claimKey, typeOverride || finalEventType, PROVISIONAL_EVENT_TYPE]
        );
      } catch (finErr) {
        d.logErrorToDb(finErr, { context: 'kashier_webhook_finalize_claim', orderId, category: 'payment' });
      }
    };

    const order = await d.queryOne('SELECT * FROM orders_active WHERE id = $1', [orderId]);
    if (!order) {
      if (outcome === 'paid') {
        safeAlert(d,
          'Kashier webhook for UNKNOWN order ' + orderId + ' (txn ' + (txnRaw || 'n/a') +
          ') — money taken, no order to apply it to',
          'kashier_order_not_found');
      }
      // Leave the claim provisional so Kashier's retry can be re-processed.
      return { http: 503, json: { ok: false, error: 'order not found' } };
    }

    // ── Reversal: record, page, change nothing ─────────────────────────────
    if (outcome === 'reversal') {
      d.logOrderEvent({
        orderId,
        label: 'Kashier ' + event + ' webhook received — order payment state UNCHANGED',
        meta: JSON.stringify({ kashier_transaction: txnRaw, status: kStatus, amount: data.amount, current_payment_status: order.payment_status || null }),
        actorRole: 'system'
      });
      safeAlert(d,
        'Kashier ' + event + ' webhook on order ' + orderId + ' (txn ' + (txnRaw || 'n/a') +
        ', status ' + kStatus + ') — reconcile manually',
        'kashier_refund_or_void');
      await finalizeClaim();
      return { http: 200, json: { ok: true, refund_or_void: true } };
    }

    if (outcome === 'pending' || outcome === 'other') {
      d.logOrderEvent({
        orderId,
        label: 'Kashier webhook: event=' + (event || 'unknown') + ' status=' + (kStatus || 'unknown'),
        meta: JSON.stringify({ kashier_transaction: txnRaw, method, reference }),
        actorRole: 'system'
      });
      if (outcome === 'other' && kStatus === 'SUCCESS') {
        // A successful something we do not have a rule for. Never guess with
        // money: tell a person.
        safeAlert(d,
          'Kashier webhook with status SUCCESS but unrecognised event "' + event +
          '" on order ' + orderId + ' (txn ' + (txnRaw || 'n/a') + ') — NOT marked paid, check it',
          'kashier_unrecognised_event');
      }
      await finalizeClaim();
      return { http: 200, json: { ok: true } };
    }

    if (outcome === 'failed') {
      d.logOrderEvent({
        orderId,
        label: 'Kashier webhook: status=failed',
        meta: JSON.stringify({ kashier_transaction: txnRaw, method, reference, code: data.transactionResponseCode || null }),
        actorRole: 'system'
      });
      const stillUnpaid = String(order.payment_status || '').toLowerCase() !== 'paid';
      if (stillUnpaid && order.patient_id) {
        try {
          d.queueMultiChannelNotification({
            orderId,
            toUserId: order.patient_id,
            channels: ['email', 'whatsapp', 'internal'],
            template: 'payment_failed_patient',
            response: {
              order_id: orderId,
              // E2E 2026-10-06 — was an id slice; queueNotification resolves orders.reference_id.
              caseReference: (order && order.reference_id) || null,
              paymentUrl: '/portal/patient/pay/' + orderId,
              errorReason: null
            }
          }).catch(function (err) {
            console.error('[kashier-webhook] notification queue failed:', err && err.message ? err.message : err);
          });
        } catch (err) {
          console.error('[kashier-webhook] payment-failed notify failed:', err && err.message ? err.message : err);
        }
      }
      await finalizeClaim();
      return { http: 200, json: { ok: true } };
    }

    // ── outcome === 'paid' ─────────────────────────────────────────────────

    // Test-mode guard. A test session takes no money; its webhook must only
    // ever settle a case that belongs to a named test account.
    if (cfg.mode !== 'live' && cfg.testPatientIds.indexOf(String(order.patient_id)) === -1) {
      d.logOrderEvent({
        orderId,
        label: 'Kashier TEST-mode payment for a non-test patient — order left UNPAID',
        meta: JSON.stringify({ kashier_transaction: txnRaw }),
        actorRole: 'system'
      });
      safeAlert(d,
        'Kashier TEST-mode success webhook for order ' + orderId +
        ' whose patient is not a test account — NOT marked paid',
        'kashier_test_mode_refused');
      await finalizeClaim('webhook_received');
      return { http: 200, json: { ok: true, test_mode_refused: true } };
    }

    const alreadyPaid = String(order.payment_status || '').toLowerCase() === 'paid';

    // ── 3. Amount + currency ───────────────────────────────────────────────
    if (!alreadyPaid) {
      const owedCents = d.owedCentsForOrder(order);
      const paidCents = d.kashier.amountToCents(data.amount);
      const owedCurrency = String(order.currency || 'EGP').toUpperCase();
      const paidCurrency = String(data.currency || '').toUpperCase();
      if (!Number.isFinite(paidCents) || paidCents !== owedCents || paidCurrency !== owedCurrency) {
        try {
          await d.execute(
            `INSERT INTO payment_events (id, order_id, event_type, payload_json, hmac_verified, received_at)
             VALUES ($1, $2, 'amount_mismatch', $3, true, NOW())`,
            [
              'pe-' + crypto.randomUUID(),
              orderId,
              JSON.stringify({
                provider: 'kashier',
                owed_cents: owedCents,
                paid_cents: Number.isFinite(paidCents) ? paidCents : null,
                currency: data.currency || null,
                owed_currency: owedCurrency,
                kashier_transaction: txnRaw
              })
            ]
          );
        } catch (auditErr) {
          d.logErrorToDb(auditErr, { context: 'kashier_webhook_amount_mismatch_audit', orderId });
        }
        d.logOrderEvent({
          orderId,
          label: 'Payment amount mismatch — order left UNPAID for manual review',
          meta: JSON.stringify({ provider: 'kashier', owed_cents: owedCents, paid_cents: Number.isFinite(paidCents) ? paidCents : null, owed_currency: owedCurrency, paid_currency: paidCurrency || null }),
          actorRole: 'system'
        });
        try {
          await d.notifyAdmins({
            template: 'payment_amount_mismatch',
            payload: {
              order_id: orderId,
              owed_cents: owedCents,
              paid_cents: Number.isFinite(paidCents) ? paidCents : null,
              paymob_transaction_id: txnKey
            },
            dedupeKey: 'amount_mismatch:' + orderId + ':' + (txnKey || 'no-txn'),
            orderId,
            channel: 'internal'
          });
        } catch (notifyErr) {
          console.error('[kashier-webhook] amount_mismatch notifyAdmins failed:', notifyErr && notifyErr.message);
        }
        try {
          const owedEgp = (Number(owedCents) / 100).toFixed(2);
          const paidEgp = Number.isFinite(paidCents) ? (paidCents / 100).toFixed(2) : 'unknown';
          Promise.resolve(d.pushOpsEvent({
            kind: 'payment_mismatch',
            dedupeKey: orderId,
            title: 'Payment mismatch — case left unpaid',
            body: 'Kashier charged EGP ' + paidEgp + ' on ' + String(orderId).slice(0, 12).toUpperCase() +
                  ', we asked EGP ' + owedEgp + '. Patient has paid and nothing is moving.',
            data: { orderId: orderId, owedCents: owedCents, paidCents: Number.isFinite(paidCents) ? paidCents : null, kashierTransaction: txnRaw || null },
            orderId
          })).catch(function () {});
        } catch (pushErr) {
          console.error('[kashier-webhook] amount_mismatch ops push failed:', pushErr && pushErr.message);
        }
        safeAlert(d,
          'Kashier amount mismatch on order ' + orderId + ' — case left UNPAID, patient was charged',
          'kashier_amount_mismatch');
        await finalizeClaim('amount_mismatch_received');
        return { http: 200, json: { ok: true, amount_mismatch: true } };
      }
    }

    // ── 4. Guarded UPDATE ──────────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const guard = await d.execute(
      `UPDATE orders
          SET payment_status = 'paid',
              paid_at = COALESCE(paid_at, $1),
              uploads_locked = true,
              payment_method = COALESCE(payment_method, $2, 'gateway'),
              payment_reference = COALESCE(payment_reference, $3),
              paymob_transaction_id = COALESCE(paymob_transaction_id, $6),
              hmac_verified_at = COALESCE(hmac_verified_at, $1::timestamptz),
              updated_at = $4
        WHERE id = $5 AND (payment_status IS NULL OR payment_status != 'paid')`,
      [nowIso, method || 'gateway', reference || null, nowIso, orderId, txnKey]
    );

    if (!guard || guard.rowCount === 0) {
      const needsBackfill = (
        String(order.status || '').toLowerCase() !== 'paid' ||
        !order.deadline_at ||
        !order.sla_hours
      );
      if (!needsBackfill) {
        d.logOrderEvent({
          orderId,
          label: 'Kashier webhook: already paid (ignored)',
          meta: JSON.stringify({ kashier_transaction: txnRaw, method, reference }),
          actorRole: 'system'
        });
        await finalizeClaim();
        return { http: 200, json: { ok: true } };
      }
      d.logOrderEvent({
        orderId,
        label: 'Kashier webhook: already paid (backfill lifecycle)',
        meta: JSON.stringify({ kashier_transaction: txnRaw, method, reference }),
        actorRole: 'system'
      });
    }

    // ── 5. Lifecycle ───────────────────────────────────────────────────────
    try {
      await d.markCasePaid(orderId);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const benign = /already\s+(paid|assigned|processed)|idempotent|no[-\s]?op/i.test(msg);
      d.logOrderEvent({
        orderId,
        label: benign
          ? 'Payment lifecycle transition skipped (idempotent)'
          : 'Payment lifecycle transition FAILED — case may not have entered the pipeline',
        meta: JSON.stringify({ error: msg, benign, provider: 'kashier', method, reference }),
        actorRole: 'system'
      });
      if (!benign) {
        try {
          d.logErrorToDb(e, { context: 'kashier_webhook_markCasePaid', orderId, category: 'payment', payment_captured: true });
        } catch (_) {}
        safeAlert(d,
          'markCasePaid FAILED for order ' + orderId + ' AFTER Kashier payment was captured: ' +
          msg.slice(0, 300) + ' — case is paid but may not be in the assignment queue',
          'markcasepaid_failed');
        try {
          await d.pushOpsEvent({
            kind: 'payment_capture_failed',
            dedupeKey: orderId,
            title: 'PAID but not queued',
            body: 'Payment was captured and the case may not have entered the assignment queue. Check it now.',
            orderId: orderId,
            data: { screen: 'case-detail', caseId: orderId }
          });
        } catch (_) { /* the webhook must still answer 200 */ }
      }
    }

    await finalizeClaim();

    d.logOrderEvent({
      orderId,
      label: 'Payment confirmed via gateway',
      meta: JSON.stringify({ provider: 'kashier', mode: cfg.mode, method, reference }),
      actorRole: 'system'
    });
    d.logOrderEvent({
      orderId,
      label: 'payment_confirmed',
      meta: JSON.stringify({ status: 'paid', provider: 'kashier', method, reference }),
      actorRole: 'system'
    });

    // E2E 2026-10-06 — was `String(orderId).slice(0, 12).toUpperCase()`, which
    // patients were shown as "Case 8F83CD55-A06". The real reference, or null
    // and queueNotification looks it up (notify/case_label.js).
    const caseReference = (order && order.reference_id) || null;
    const q = function (payload, tag) {
      try {
        Promise.resolve(d.queueMultiChannelNotification(payload)).catch(function (err) {
          console.error('[kashier-webhook] ' + tag + ' queue failed:', err && err.message ? err.message : err);
        });
      } catch (err) {
        console.error('[kashier-webhook] ' + tag + ' queue threw:', err && err.message ? err.message : err);
      }
    };

    q({
      orderId,
      toUserId: order.patient_id,
      channels: ['email', 'whatsapp', 'internal'],
      template: 'payment_success_patient',
      response: { order_id: orderId, caseReference: caseReference }
    }, 'payment_success_patient');

    if (String(order.urgency_tier || '').toLowerCase() === 'urgent') {
      q({
        orderId,
        toUserId: order.patient_id,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'addon_purchased_urgency',
        response: { order_id: orderId, caseReference: caseReference, slaHours: order.sla_hours || null }
      }, 'addon_purchased_urgency');
    }

    if (order.doctor_id) {
      q({
        orderId,
        toUserId: order.doctor_id,
        channels: ['whatsapp', 'internal'],
        template: 'payment_success_doctor',
        response: { order_id: orderId }
      }, 'payment_success_doctor');
    }

    try {
      await d.execute(
        'UPDATE referral_redemptions SET reward_granted = true WHERE order_id = $1 AND reward_granted = false',
        [orderId]
      );
    } catch (_) {}

    try {
      await d.settleAddonsForPaidOrder({
        orderId,
        order,
        verifiedBy: 'gateway_amount_check',
        via: 'kashier_webhook',
        actorRole: 'system',
        notify: d.queueMultiChannelNotification
      });
    } catch (addonErr) {
      // The base case is paid and queued; an add-on failure must not turn the
      // acknowledgement into a 500 that makes Kashier re-deliver a settled payment.
      d.logErrorToDb(addonErr, { context: 'kashier_webhook_addon_settlement', orderId, category: 'payment' });
      safeAlert(d,
        'Add-on settlement FAILED after Kashier payment on order ' + orderId + ' — base case is paid, add-ons need a look',
        'kashier_addon_settlement_failed');
    }

    return { http: 200, json: { ok: true } };
  } finally {
    if (lockClient) {
      const c = lockClient;
      lockClient = null;
      try {
        await c.query('ROLLBACK');
        c.release();
      } catch (unlockErr) {
        console.error('[kashier-webhook] txn lock release failed:', unlockErr && unlockErr.message);
        try { c.release(true); } catch (_) {}
      }
    }
  }
}

router.post('/webhook', async function (req, res, next) {
  const d = realDeps();
  try {
    const out = await processKashierEvent({
      body: req.body,
      headerSig: req.get(d.SIGNATURE_HEADER),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId
    }, d);
    return res.status(out.http).json(out.json);
  } catch (err) {
    d.logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, context: 'kashier_webhook' });
    return next(err);
  }
});

module.exports = router;
module.exports.processKashierEvent = processKashierEvent;
module.exports.PAY_EVENTS = PAY_EVENTS;
module.exports.REVERSAL_EVENTS = REVERSAL_EVENTS;
