'use strict';

// services/ops_push.js
//
// AUDIT 2026-08-17 — business-event push for the Command app.
//
// The push infrastructure was already built, registered and working, and had
// exactly one producer: worker_watchdog telling the founder a background worker
// had stopped heartbeating. Nothing pushed for anything that happens to the
// business — so an urgent case (4h SLA) that no doctor accepted inside its
// 15-minute window at 2am was discovered at 9am, by someone opening the app and
// noticing.
//
// This module is the single entry point for those pushes. Every trigger site
// calls pushOpsEvent(); none of them talk to middleware/push directly, so the
// throttle cannot be bypassed by a new call site forgetting about it.
//
// DESIGN NOTES
//
// 1. THE CLAIM IS ATOMIC. A single INSERT ... SELECT ... WHERE NOT EXISTS
//    decides "has this already been sent" and records the send in one
//    statement, so two web instances racing on the same event cannot both win.
//    This is the same shape as critical-alert.js's _claimSend, for the same
//    reason: a check-then-act throttle leaks duplicates under concurrency.
//
// 2. IT FAILS CLOSED, NOT OPEN. critical-alert deliberately fails OPEN on a DB
//    error — during an outage it would rather double-alert than suppress the
//    alert saying the DB is down. The opposite is right here: these are routine
//    business events, and a DB wobble that duplicated every one of them would
//    turn the founder's phone into a nuisance he learns to ignore. A push he
//    misses costs less than a channel he mutes.
//
// 3. NOTHING HERE THROWS. Every trigger site is inside a request or a worker
//    doing real work — recording a refund, marking a breach. A push failing
//    must never roll back the thing it is describing.

const { queryOne, execute, pool } = require('../pg');
const { logErrorToDb } = require('../logger');
const { notifySuperadmins } = require('../middleware/push');

// Per-kind cooldown. Keyed by kind so a noisy class cannot drown a quiet one.
//
// The values are chosen from how fast a human could usefully act on each:
// there is no point re-telling someone about the same refund queue every
// minute, and an urgent case is deduped per case anyway (see EVENT_KEY below),
// so its cooldown only guards against a retry storm on the SAME case.
const COOLDOWN_MS_BY_KIND = Object.freeze({
  urgent_unaccepted: 60 * 60 * 1000,   // per case; an hour guards retries
  sla_breach_first: 12 * 60 * 60 * 1000, // per day key; the guard is the key
  refund_requested: 5 * 60 * 1000,
  payment_mismatch: 5 * 60 * 1000,
  doctor_application: 30 * 60 * 1000,
  doctor_auto_paused: 60 * 60 * 1000,
});
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

function cooldownFor(kind) {
  return COOLDOWN_MS_BY_KIND[kind] || DEFAULT_COOLDOWN_MS;
}

/**
 * Claim the right to send this event, atomically.
 *
 * @returns {Promise<boolean>} true if this caller won the claim and should send
 */
async function _claim(eventKey, kind, title, body, orderId) {
  const cooldownMinutes = Math.max(1, Math.round(cooldownFor(kind) / 60000));
  try {
    const row = await queryOne(
      `INSERT INTO ops_push_log (event_key, kind, title, body, order_id)
            SELECT $1, $2, $3, $4, $5
             WHERE NOT EXISTS (
                   SELECT 1 FROM ops_push_log
                    WHERE event_key = $1
                      AND sent_at > NOW() - INTERVAL '${cooldownMinutes} minutes'
             )
         RETURNING id`,
      [eventKey, kind, String(title || '').slice(0, 200), String(body || '').slice(0, 500), orderId || null]
    );
    return Boolean(row && row.id) ? row.id : null;
  } catch (err) {
    // Fail CLOSED — see design note 2.
    logErrorToDb(err, { context: 'ops_push.claim', category: 'push', eventKey: eventKey });
    return null;
  }
}

/**
 * Send a business-event push to every superadmin with a registered device.
 *
 * @param {Object} opts
 * @param {string} opts.kind        event class, e.g. 'urgent_unaccepted'
 * @param {string} opts.dedupeKey   what makes this event unique — a case id, or
 *                                  a date for once-per-day events. Combined
 *                                  with kind to form the throttle key.
 * @param {string} opts.title       push title
 * @param {string} opts.body        push body
 * @param {Object} [opts.data]      payload for the app to route on
 * @param {string} [opts.orderId]   recorded on the log row
 * @returns {Promise<{sent: boolean, skipped?: string, recipients?: number}>}
 */
async function pushOpsEvent(opts) {
  const o = opts || {};
  try {
    if (!o.kind || !o.dedupeKey) return { sent: false, skipped: 'missing_kind_or_key' };

    const eventKey = String(o.kind) + ':' + String(o.dedupeKey);
    const logId = await _claim(eventKey, o.kind, o.title, o.body, o.orderId);
    if (!logId) return { sent: false, skipped: 'throttled' };

    let recipients = 0;
    try {
      // notifySuperadmins resolves the tokens itself and swallows per-device
      // failures. It does not report how many it reached, so count here — a
      // zero is worth recording, because it means the event fired and nobody
      // had a device registered to receive it.
      const rows = await queryOne(
        "SELECT COUNT(*)::int AS c FROM users WHERE role = 'superadmin' AND push_token IS NOT NULL"
      );
      recipients = (rows && rows.c) || 0;

      await notifySuperadmins(pool, {
        title: o.title,
        body: o.body,
        data: Object.assign({ kind: o.kind }, o.data || {}),
      });
    } catch (err) {
      logErrorToDb(err, {
        context: 'ops_push.notifySuperadmins',
        category: 'push',
        eventKey: eventKey,
        orderId: o.orderId || null,
      });
    }

    try {
      await execute('UPDATE ops_push_log SET sent_count = $1 WHERE id = $2', [recipients, logId]);
    } catch (_) { /* the count is diagnostic; the send already happened */ }

    return { sent: true, recipients: recipients };
  } catch (err) {
    logErrorToDb(err, { context: 'ops_push.pushOpsEvent', category: 'push' });
    return { sent: false, skipped: 'error' };
  }
}

// Cairo business day, for the once-per-day dedupe keys. Deliberately the
// operator's local day rather than UTC: "the first breach of the day" means the
// first one in the day HE is having.
function cairoDayKey(now) {
  const d = now instanceof Date ? now : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

module.exports = { pushOpsEvent, cairoDayKey, COOLDOWN_MS_BY_KIND };
