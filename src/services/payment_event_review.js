/**
 * Tashkheesa Command — mark a payment_event "reviewed" (superadmin write).
 *
 * Batch 1, amount-mismatch triage. payment_events is an APPEND-ONLY log; a
 * review is a MUTABLE operator annotation, so it lives in the payment_event_reviews
 * overlay (UNIQUE payment_event_id — migration 075). This is an UPSERT: a first
 * review inserts, a re-review updates note + reviewed_at + reviewer IN PLACE
 * (never a second row).
 *
 * Deliberately NO status machine and NO resolution workflow — the triage is
 * read-only + a "reviewed" flag; resolution actions (refund / mark-paid) happen
 * via deep-link to the case where those flows already live. Wrapped in ONE
 * atomic transaction with both audit rows written on the txn client (mirrors
 * admin_refund.js). Pure DB write — fully rollback-able.
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

/**
 * @param {import('pg').PoolClient} client  already-connected pg client
 * @param {{ paymentEventId: string, note?: string|null, actorId: string }} opts
 * @returns {Promise<{ paymentEventId, reviewedBy, reviewedAt, note }>}
 */
async function reviewPaymentEvent(client, opts) {
  const paymentEventId = String(opts && opts.paymentEventId ? opts.paymentEventId : '').trim();
  const actorId = opts && opts.actorId ? opts.actorId : null;
  // Optional annotation. Blank/whitespace normalizes to NULL (note is TEXT NULL).
  const rawNote = opts && opts.note != null ? String(opts.note).trim() : '';
  const note = rawNote ? rawNote.slice(0, 1000) : null;

  await client.query('BEGIN');
  try {
    // (1) event must exist — 404 otherwise. order_id (nullable on the event) is
    //     used only for the order_events audit breadcrumb.
    const ev = (await client.query(
      `SELECT id, order_id, event_type FROM payment_events WHERE id = $1`,
      [paymentEventId]
    )).rows[0];
    if (!ev) throw af('Payment event not found', 404, 'EVENT_NOT_FOUND');

    // (2) UPSERT the review — one row per event (UNIQUE payment_event_id).
    //     Re-review refreshes reviewer + note + reviewed_at in place.
    const up = await client.query(
      `INSERT INTO payment_event_reviews (id, payment_event_id, reviewed_by, reviewed_at, note)
         VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (payment_event_id) DO UPDATE
         SET reviewed_by = EXCLUDED.reviewed_by,
             reviewed_at = NOW(),
             note        = EXCLUDED.note
       RETURNING reviewed_by, reviewed_at, note`,
      [randomUUID(), paymentEventId, actorId, note]
    );
    const row = up.rows[0];

    // (3) order_events audit — on the txn client (atomic with the review).
    //     Only when the event references an order (it always does for
    //     amount_mismatch, but guard for the generic case).
    if (ev.order_id) {
      await client.query(
        `INSERT INTO order_events (id, order_id, label, meta, at, actor_user_id, actor_role)
           VALUES ($1, $2, 'payment_event_reviewed', $3, NOW(), $4, 'superadmin')`,
        [randomUUID(), ev.order_id,
          JSON.stringify({
            payment_event_id: paymentEventId,
            event_type: ev.event_type,
            note_preview: (note || '').slice(0, 100),
          }),
          actorId]
      );
    }

    // (4) admin audit into error_logs — on the txn client.
    await client.query(
      `INSERT INTO error_logs (id, level, category, message, user_id, context)
         VALUES ($1, 'audit', 'admin_audit', $2, $3, $4)`,
      [randomUUID(), `payment_event_reviewed: ${paymentEventId}`, actorId,
        JSON.stringify({ action: 'payment_event_reviewed', target: paymentEventId, event_type: ev.event_type, hasNote: !!note })]
    );

    await client.query('COMMIT');

    return {
      paymentEventId,
      reviewedBy: row.reviewed_by || null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
      note: row.note || null,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  }
}

module.exports = { reviewPaymentEvent };
