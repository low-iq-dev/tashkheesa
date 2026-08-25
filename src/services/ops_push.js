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

// ─── Per-kind budget ────────────────────────────────────────────────────────
//
// 2026-08-25. The comment above has said "Per-kind cooldown. Keyed by kind so a
// noisy class cannot drown a quiet one" since this module was written. It was
// not true. The claim filters on `event_key`, which is kind + ':' + dedupeKey
// (see EVENT_KEY below), so the cooldown throttles a REPEAT OF THE SAME EVENT
// and nothing else. Twenty different refunds in a minute produced twenty
// pushes. Same for payment mismatches and doctor applications.
//
// That mattered little with six producers. It matters now, because this change
// adds five more — including auto-assign failures, which arrive in bursts
// exactly when something systemic is wrong and the operator most needs to be
// able to read their lock screen.
//
// So: a real per-kind ceiling, alongside the per-event claim. When a kind
// exceeds its budget the individual pushes stop and ONE summary event goes out
// instead, so the operator learns "14 more refund requests" rather than either
// fourteen buzzes or silence. Suppression that tells nobody is how an alerting
// system loses trust.
const KIND_WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_KIND_PER_WINDOW = Object.freeze({
  // A burst of these means something systemic; one push plus a summary is
  // strictly more useful than twenty.
  urgent_unaccepted: 3,
  refund_requested: 4,
  payment_mismatch: 4,
  doctor_application: 4,
  doctor_auto_paused: 3,
  assignment_failed: 3,
  classifier_parked: 3,
  sla_prebreach: 4,
  payment_capture_failed: 5,   // money already taken — a higher ceiling is right
  chat_reported: 4,
  worker_down: 4,
});
const DEFAULT_KIND_BUDGET = 5;

function budgetFor(kind) {
  const v = MAX_PER_KIND_PER_WINDOW[kind];
  return Number.isFinite(v) ? v : DEFAULT_KIND_BUDGET;
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
 * Has this kind used up its budget for the current window?
 *
 * Counts rows already claimed for the kind, EXCLUDING the one this call just
 * wrote — the claim happens first, so the event is recorded in the feed even
 * when the push is suppressed.
 *
 * @returns {Promise<number|null>} null when under budget and the push should go
 *   out; otherwise the count of events already suppressed in this window (0
 *   means this is the first one over the line, so a summary is due).
 */
async function _kindBudgetExceeded(kind, currentLogId) {
  try {
    const windowMinutes = Math.max(1, Math.round(KIND_WINDOW_MS / 60000));
    const row = await queryOne(
      `SELECT COUNT(*)::int AS c
         FROM ops_push_log
        WHERE kind = $1
          AND id <> $2
          AND sent_at > NOW() - INTERVAL '${windowMinutes} minutes'`,
      [kind, currentLogId]
    );
    const seen = (row && row.c) || 0;
    const budget = budgetFor(kind);
    if (seen < budget) return null;
    return seen - budget;
  } catch (err) {
    // Fail OPEN here, unlike the claim. A budget check that cannot run must
    // never silence an alert: the claim above has already proved this is not a
    // duplicate, so the worst case is one extra push rather than a missed one.
    logErrorToDb(err, { context: 'ops_push.kind_budget', category: 'push' });
    return null;
  }
}

// What the burst summary says. Reads as a sentence on a lock screen, because
// that is the only place it will ever be read.
function _burstTitle(kind, suppressed) {
  const n = suppressed + 1;
  const labels = {
    urgent_unaccepted: 'urgent cases still unaccepted',
    refund_requested: 'refund requests',
    payment_mismatch: 'payment mismatches',
    doctor_application: 'doctor applications',
    doctor_auto_paused: 'doctors auto-paused',
    assignment_failed: 'cases that could not be assigned',
    classifier_parked: 'cases parked for manual triage',
    sla_prebreach: 'cases approaching their SLA',
    payment_capture_failed: 'payments captured but not processed',
    chat_reported: 'chat reports',
    worker_down: 'worker alerts',
  };
  return n + ' more ' + (labels[kind] || String(kind).replace(/_/g, ' '));
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

    // Per-kind ceiling, checked AFTER the per-event claim.
    //
    // The claim still does its own job (a repeat of the SAME event is throttled
    // exactly as before) and the log row is still written. What the budget
    // stops is the BUZZ, not the record — the Activity feed stays complete
    // either way, which matters because the feed is what an operator scrolls
    // back through to reconstruct a bad hour.
    //
    // `_summarySent` stops the summary push recursing into itself.
    if (!o._summarySent) {
      const suppressed = await _kindBudgetExceeded(o.kind, logId);
      if (suppressed !== null) {
        if (suppressed > 0) {
          // One push for the whole burst, so the operator learns "14 more
          // refund requests" instead of either fourteen buzzes or silence.
          // Suppression that tells nobody is how an alerting system loses
          // trust — and a muted channel is worse than a noisy one.
          await pushOpsEvent({
            kind: o.kind,
            dedupeKey: 'burst:' + Math.floor(Date.now() / KIND_WINDOW_MS),
            title: _burstTitle(o.kind, suppressed),
            body: 'Individual alerts are paused for ' +
                  Math.round(KIND_WINDOW_MS / 60000) +
                  ' minutes. Open Activity to see them all.',
            data: { kind: o.kind, burst: true },
            _summarySent: true,
          });
        }
        return { sent: false, skipped: 'kind_budget', logged: true };
      }
    }

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

/**
 * Record an ops event in the Activity feed WITHOUT claiming or throttling it.
 *
 * 2026-08-25. For callers that already own a better throttle than this module's.
 *
 * The worker watchdog is the case this exists for. It called notifySuperadmins
 * DIRECTLY, bypassing pushOpsEvent, so worker_down and worker_recovered wrote
 * no ops_push_log row: miss the push while the phone is locked and the most
 * operationally severe alert on the platform was gone forever — precisely the
 * failure mode the Activity feed was built to prevent.
 *
 * The obvious fix, routing it through pushOpsEvent, is the wrong one. The
 * watchdog's throttle is STRONGER than this module's: a per-worker cooldown
 * persisted in admin_settings (so it survives a restart and is shared across
 * instances) plus a pg advisory lock, with the slot claimed BEFORE the send so
 * a failing sink cannot become a per-tick retry storm. Layering our weaker
 * claim on top would add nothing, and the per-kind budget could SUPPRESS a
 * worker-down alert — exactly the alert that must never be suppressed.
 *
 * So the watchdog keeps its own claim and its own send, and calls this to make
 * the event persist. Non-throwing: a feed row is not worth failing an alert
 * over.
 *
 * @returns {Promise<string|null>} the log row id, or null if it could not be written
 */
async function recordOpsEvent({ kind, dedupeKey, title, body, orderId, recipients }) {
  try {
    if (!kind) return null;
    const eventKey = String(kind) + ':' + String(dedupeKey || Date.now());
    const row = await queryOne(
      `INSERT INTO ops_push_log (event_key, kind, title, body, order_id, sent_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [eventKey, kind, String(title || '').slice(0, 200), String(body || '').slice(0, 500),
       orderId || null, Number.isFinite(recipients) ? recipients : null]
    );
    return (row && row.id) || null;
  } catch (err) {
    logErrorToDb(err, { context: 'ops_push.record', category: 'push', kind: kind });
    return null;
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

module.exports = {
  pushOpsEvent,
  recordOpsEvent,
  cairoDayKey,
  COOLDOWN_MS_BY_KIND,
  MAX_PER_KIND_PER_WINDOW,
  KIND_WINDOW_MS
};
