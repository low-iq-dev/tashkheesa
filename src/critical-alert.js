// src/critical-alert.js
// Critical alerts: Command push first (primary), WhatsApp second (optional).
//
// Theme 8 Phase 7 (OQ-6): DB-backed throttle + delivery log.
// Theme 9 Sub-issue B: per-call env reads + Meta utility-template path
//                      + surface failures to error_logs (so the Sub-issue A
//                      WA-401 cron picks them up).
//
// History:
//   Pre-Phase-7 this used an in-memory `lastSentAt` variable, which had
//   two failure modes documented in P1-ERR-7 of the audit:
//     1. Multi-dyno: each instance had its own counter; horizontal
//        scale-out multiplied alerts by dyno count.
//     2. Restart reset: every process.exit(1) wiped the throttle, so
//        a crash loop fired one WhatsApp PER crash — Meta rate-limit
//        burnout territory.
//   Phase 7 moved the throttle to `critical_alert_log` (migration 049).
//
//   Pre-Theme-9-B this captured the WhatsApp envs (phone id, token, API
//   version) at module load. Render env rotation required a deploy to
//   take effect. Also: payload was `type:'text'`, which Meta only allows
//   inside the 24h customer-service window. Alerts firing at 3 AM after
//   a crash were silently rejected by Meta with code 131047. Theme 9-B
//   reads envs per call and switches to a utility-category template
//   (configurable via CRITICAL_ALERT_TEMPLATE_NAME).

var https = require('https');
var { apiVersion } = require('./config/whatsapp');

var THROTTLE_MINUTES = 5;

// Log every send attempt — success or failure — to critical_alert_log.
// Lazy-require pg so this module stays loadable in the boot-time path
// before the pool is initialized. Never throws.
// AUDIT-P1-4: records the OUTCOME on the row already claimed by _claimSend.
// claimId 0 means the claim itself failed (DB down, fail-open) — nothing to
// update, and re-inserting would defeat the throttle.
function _logCriticalAlertAttempt(claimId, statusCode, errorText) {
  if (!claimId) return;
  try {
    var pg = require('./pg');
    pg.execute(
      "UPDATE critical_alert_log SET status_code = $2, error = $3 WHERE id = $1",
      [
        claimId,
        statusCode == null ? null : Number(statusCode),
        errorText == null ? null : String(errorText).slice(0, 1000)
      ]
    ).catch(function () { /* never throw from log writer */ });
  } catch (_) { /* pg not loaded yet — boot path */ }
}

// Theme 9 Sub-issue B: also write failures to error_logs with
// category='whatsapp_send' so the WA-401 cron (Sub-issue A) surfaces them
// alongside notify/whatsapp.js failures. Critical-alert delivery is part
// of the same WhatsApp pipeline; one cron, one signal.
function _logToErrorLogs(statusCode, errorText, alertKey, category) {
  try {
    var logger = require('./logger');
    if (typeof logger.logErrorToDb !== 'function') return;
    var err = new Error('critical_alert_send_failed: ' + (errorText || 'unknown'));
    logger.logErrorToDb(err, {
      category: category || 'whatsapp_send',
      subsystem: 'critical_alert',
      alertKey: String(alertKey || 'generic').slice(0, 200),
      statusCode: statusCode == null ? null : Number(statusCode)
    });
  } catch (_) { /* never throw from log writer */ }
}

// AUDIT-P1-4 — the throttle is now CLAIMED UP FRONT, in one statement.
//
// It used to be a read-only `SELECT 1 ...` check, while the row that closes
// the window was only written from `res.on('end')` — i.e. AFTER the Meta
// round-trip, up to the 10s request timeout later. Every caller inside that
// window passed the throttle. That is exactly the failure migration 049 was
// written to prevent: a crash loop or error burst fires N unhandledRejection
// handlers within seconds, all N pass, and all N page the on-call phone,
// burning the Meta rate limit at the worst possible moment.
//
// INSERT ... SELECT ... WHERE NOT EXISTS claims and checks in a single
// statement, so the window closes before the HTTPS request is even built.
// Returns the claimed row id (to be updated with the outcome), or null when
// throttled. Fails OPEN on DB error — during a DB outage we would rather risk
// a duplicate alert than suppress the alert that says "the DB is down" — and
// signals that with the sentinel id 0.
async function _claimSend(alertKey, message) {
  try {
    var pg = require('./pg');
    var res = await pg.execute(
      "INSERT INTO critical_alert_log (alert_key, message)" +
      " SELECT $1, $2" +
      " WHERE NOT EXISTS (" +
      "   SELECT 1 FROM critical_alert_log" +
      "    WHERE alert_key = $1" +
      "      AND sent_at > NOW() - INTERVAL '" + THROTTLE_MINUTES + " minutes'" +
      " )" +
      " RETURNING id",
      [alertKey, message == null ? null : String(message).slice(0, 1000)]
    );
    if (res && res.rows && res.rows.length) return res.rows[0].id;
    return null;  // throttled
  } catch (_) {
    return 0;     // DB unavailable → fail open, nothing to update later
  }
}

// AUDIT-2026-08-22 (N4) — a suppressed alert must be as visible as a failed one.
//
// The two env gates below used to call _logCriticalAlertAttempt ALONE, which
// writes to critical_alert_log and nowhere else. Every other non-delivery in
// this file also calls _logToErrorLogs, which is what /ops/errors reads. So the
// one failure mode that was silencing all 18 critical alerts — no template
// name configured, on a transport that could not deliver anyway — was the one
// failure mode that never reached the errors dashboard. An operator looking at
// /ops saw nothing at all: no alert, and no record that an alert had been
// suppressed. This helper makes both writes, always.
function _suppressed(claimId, reason, key) {
  _logCriticalAlertAttempt(claimId, null, reason);
  _logToErrorLogs(null, reason, key);
  console.error('[critical-alert] SUPPRESSED — alert not delivered', { reason: reason, alertKey: key });
}

// AUDIT-2026-08-22 (N4) — derive a throttle key for callers that pass none.
//
// The throttle buckets by alert_key over a 5-minute window, so two distinct
// events sharing a key mean the second one is swallowed. server.js's two
// process-death handlers both call sendCriticalAlert(msg) with no key, so an
// uncaughtException within five minutes of an unhandledRejection (a very
// ordinary crash-loop shape) is thrown away — and those are precisely the two
// events you need both halves of. server.js is not this agent's file to edit,
// so the split is derived here from the message's own leading EVENT_NAME:
// prefix, which both handlers already emit ('UNHANDLED_REJECTION: …',
// 'UNCAUGHT_EXCEPTION: …'). Anything without that shape still buckets as
// 'generic', exactly as before.
function _deriveAlertKey(alertKey, message) {
  if (alertKey) return String(alertKey).slice(0, 200);
  var m = /^([A-Z][A-Z0-9_]{3,60}):/.exec(String(message || ''));
  return m ? m[1].toLowerCase() : 'generic';
}

// PRIMARY delivery route for a critical alert (6 Oct 2026, watchtower): Expo
// push to every registered superadmin device — the Command app, the same path
// worker_down uses.
//
// It was the second route, fire-and-forget, with no kind and no record: the
// critical_alert_log row described the WhatsApp attempt only, so "was anyone
// actually told" could not be answered from the table that exists to answer
// it. Now it is awaited, sent as the catalogue kind `critical_alert` (loud,
// lockOn — services/ops_push_prefs.js), and its outcome is returned so the
// caller can mark the row delivered ONLY when Expo accepted a push ticket.
//
// Deliberately notifySuperadmins + recordOpsEvent rather than pushOpsEvent:
// this function already owns a stronger throttle (the per-key claim above),
// and pushOpsEvent's per-kind budget could suppress the one alert that must
// never be suppressed — the same reasoning as services/worker_watchdog.js.
//
// Superadmins are resolved from the database by role; no recipient id is
// named here or anywhere else in this file.
//
// Never throws. Returns { attempted, accepted, rejected, errors }.
async function _pushToCommandApp(key, message) {
  var none = { attempted: 0, accepted: 0, rejected: 0, errors: [] };
  try {
    var notifySuperadmins = require('./middleware/push').notifySuperadmins;
    if (typeof notifySuperadmins !== 'function') { none.errors.push('push_unavailable'); return none; }
    var pool = require('./pg').pool;
    if (!pool) { none.errors.push('pool_unavailable'); return none; }

    var title = 'Critical: ' + String(key || 'generic').replace(/[_-]/g, ' ');
    var body = String(message || 'Unknown error').slice(0, 300);
    var outcome = await notifySuperadmins(pool, {
      title: title,
      body: body,
      // The Command app routes on `screen`; /ops is where the error log and
      // the worker widget live, which is what an operator needs next.
      data: { kind: 'critical_alert', screen: 'ops', alertKey: String(key || 'generic'), severity: 'critical' },
      kind: 'critical_alert'
    });
    outcome = outcome || none;

    // Activity feed row, so an alert missed on the lock screen is still there
    // to scroll back to. sent_count is ACCEPTED tickets, so 0 reads as
    // "fired, reached nobody" on GET /admin/events.
    try {
      var recordOpsEvent = require('./services/ops_push').recordOpsEvent;
      if (typeof recordOpsEvent === 'function') {
        await recordOpsEvent({
          kind: 'critical_alert',
          dedupeKey: String(key || 'generic') + ':' + Date.now(),
          title: title,
          body: body,
          recipients: outcome.accepted
        });
      }
    } catch (_) { /* the feed row is not worth failing an alert over */ }

    return outcome;
  } catch (e) {
    console.error('[critical-alert] push to Command app failed:', e && e.message ? e.message : e);
    none.errors.push('push_threw: ' + (e && e.message ? e.message : 'unknown'));
    return none;
  }
}

// Record what Expo said on the claimed row. `delivered` is true only when at
// least one push ticket was accepted; otherwise push_error says why (no
// registered device, a rejected ticket, a timeout). Never throws.
function _pushFailureReason(outcome) {
  if (outcome && outcome.accepted > 0) return null;
  if (!outcome || !outcome.attempted) {
    return (outcome && outcome.errors && outcome.errors[0]) || 'no_superadmin_device_registered';
  }
  return 'expo_rejected: ' + ((outcome.errors || []).join('; ') || 'unknown');
}

function _logPushOutcome(claimId, outcome) {
  if (!claimId) return;
  try {
    var pg = require('./pg');
    var reason = _pushFailureReason(outcome);
    pg.execute(
      "UPDATE critical_alert_log" +
      "   SET delivered = $2, push_attempted = $3, push_accepted = $4, push_error = $5" +
      " WHERE id = $1",
      [
        claimId,
        !!(outcome && outcome.accepted > 0),
        (outcome && outcome.attempted) || 0,
        (outcome && outcome.accepted) || 0,
        reason == null ? null : String(reason).slice(0, 1000)
      ]
    ).catch(function () { /* never throw from log writer */ });
  } catch (_) { /* pg not loaded yet — boot path */ }
}

// Public API: sendCriticalAlert(message, alertKey?)
//
// `alertKey` defaults to 'generic' for back-compat — existing callers
// in server.js + routes/payments.js pass just a message today.
// New callers (Phase 7 Widget 4 error-rate alert) pass a distinct key
// so the throttle buckets don't collide.
//
// Returns a Promise that resolves once Expo has answered the push (bounded by
// the 8s timeout in middleware/push.js) and the WhatsApp request, if that
// transport is configured, is queued (Meta) or dispatched (OpenClaw). Never
// rejects. Existing non-await callers are unchanged.
async function sendCriticalAlert(message, alertKey) {
  var key = _deriveAlertKey(alertKey, message);
  var text = '[TASHKHEESA CRITICAL] ' + String(message || 'Unknown error').slice(0, 1000);

  // The per-key 5-minute claim governs BOTH transports, so a storm cannot
  // buzz the phone repeatedly and a flapping alarm stays one stream of noise.
  var claimId = await _claimSend(key, text);
  if (claimId === null) return;  // throttled

  // ── 1. PUSH — the primary transport ────────────────────────────────────
  //
  // 2026-08-25: every WhatsApp gate was failing at once (expired Meta token,
  // unset OpenClaw vars, empty template name) — 128 critical alerts attempted
  // in 30 days, zero delivered, including two production-crash pages. Expo
  // push was the one channel still working and was not wired here at all.
  // 2026-10-06: it is now the primary transport, awaited, and the row is
  // marked delivered only if Expo accepted a ticket.
  //
  // ── 2. WHATSAPP — optional second transport ────────────────────────────
  //
  // Off unless its env vars are set. Started alongside the push rather than
  // after it, so neither waits on the other: the two process-death handlers in
  // server.js exit 500ms after calling this, and a WhatsApp send queued behind
  // an awaited push would never leave. Its promise is caught on its own, so
  // nothing in it can throw into the caller or disturb the push; its outcome
  // lands in status_code / error, which keep meaning "the WhatsApp attempt".
  var pushPromise = _pushToCommandApp(key, message);
  var whatsappPromise = _sendWhatsAppAlert(claimId, key, text).catch(function (e) {
    console.error('[critical-alert] WhatsApp transport threw (push unaffected):', e && e.message ? e.message : e);
    return 'failed';
  });

  var pushOutcome = await pushPromise;
  _logPushOutcome(claimId, pushOutcome);
  var pushDelivered = !!(pushOutcome && pushOutcome.accepted > 0);
  var whatsapp = await whatsappPromise;

  // Nobody was told, on any channel. That must be as visible as a failure —
  // AUDIT-2026-08-22 (N4) — so it goes to error_logs where /ops/errors reads.
  // Category 'critical_alert', not 'whatsapp_send': with WhatsApp switched off
  // this is not a WhatsApp fault and must not trip the WA-401 cron.
  if (!pushDelivered && whatsapp === 'off') {
    _logToErrorLogs(null, 'undelivered: push ' + _pushFailureReason(pushOutcome) + '; whatsapp off',
      key, 'critical_alert');
    console.error('[critical-alert] UNDELIVERED — no push ticket accepted and WhatsApp is not configured',
      { alertKey: key });
  }
}

// The WhatsApp half. Returns 'off' when the transport is not configured (no
// log row, no error — unset means disabled), otherwise 'attempted'. The
// provider's answer settles into critical_alert_log.status_code / error.
async function _sendWhatsAppAlert(claimId, key, text) {
  // Theme 9-B: read envs per call. Render rotation takes effect on
  // the next call, not the next deploy.
  var adminPhone    = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
  var phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  var accessToken   = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  var templateName  = (process.env.CRITICAL_ALERT_TEMPLATE_NAME || '').trim();
  var templateLang  = (process.env.CRITICAL_ALERT_TEMPLATE_LANG || 'en').trim();

  // No number to send to: the transport is off. This used to write a
  // suppression row to error_logs on every alert; with push primary, an unset
  // optional transport is a configuration choice, not a failure.
  if (!adminPhone) return 'off';

  var transport = 'openclaw';
  try {
    transport = require('./notify/whatsapp').whatsappTransport();
  } catch (_) { /* default stands */ }

  // ── AUDIT-2026-08-22 (AUDIT-ALERT-TRANSPORT-1): DON'T LET THE ROUTING FIX
  //    BECOME A NEW SINGLE POINT OF FAILURE. ───────────────────────────────
  //
  // whatsappTransport() returns 'openclaw' for ANY value that is not exactly
  // 'meta' — including unset — so the block above made every critical alert
  // depend on OpenClaw being configured, and made the Meta branch below
  // UNREACHABLE unless someone explicitly sets
  // NOTIFICATIONS_WHATSAPP_TRANSPORT=meta.
  //
  // That combination is a configuration bootCheck.js positively blesses: with
  // NOTIFICATIONS_WHATSAPP_ENABLED=false the OPENCLAW_* pair is not required at
  // all, so a deploy can boot green with valid WHATSAPP_PHONE_NUMBER_ID /
  // WHATSAPP_ACCESS_TOKEN / CRITICAL_ALERT_TEMPLATE_NAME and no OpenClaw creds.
  // On that deploy all 18 critical alerts returned oc_env_misconfigured — the
  // Paymob HMAC failure, the three markCasePaid-failed-after-capture sites, the
  // worker-down alarm — while a perfectly good Meta path sat unused.
  //
  // Ops paging must use whatever transport is ACTUALLY configured, so fall back
  // to Meta when the OpenClaw credentials are absent. Note this checks the same
  // two variables lib/openclaw_client.js:60-71 checks, so the fallback triggers
  // in exactly the cases that would have returned oc_env_misconfigured.
  if (transport === 'openclaw') {
    var ocBaseConfigured = String(process.env.OPENCLAW_BASE_URL || '').trim();
    var ocKeyConfigured  = String(process.env.OPENCLAW_SEND_KEY || '').trim();
    var ocStubbed = String(process.env.WHATSAPP_TEST_STUB || '').trim().toLowerCase() === 'true';
    if (!ocStubbed && !(ocBaseConfigured && ocKeyConfigured)) {
      if (phoneNumberId && accessToken) {
        console.warn('[critical-alert] OpenClaw is the configured transport but ' +
          'OPENCLAW_BASE_URL/OPENCLAW_SEND_KEY are unset — falling back to the Meta ' +
          'Cloud API so this alert is not silently dropped.');
        transport = 'meta';
      } else {
        // Neither WhatsApp transport is configured: the transport is off.
        return 'off';
      }
    }
  }

  if (transport === 'openclaw') {
    var sendViaOpenClaw;
    try {
      sendViaOpenClaw = require('./lib/openclaw_client').sendViaOpenClaw;
    } catch (e) {
      _suppressed(claimId, 'openclaw_client_unavailable', key);
      return 'attempted';
    }
    try {
      var ocResult = await sendViaOpenClaw({
        to: adminPhone,
        lang: 'en',
        body: text,
        ref: null,
        userId: null,
        template: 'critical_alert'
      });
      if (ocResult && ocResult.ok) {
        _logCriticalAlertAttempt(claimId, 200, null);
      } else {
        var ocErr = 'openclaw: ' + String((ocResult && ocResult.error) || 'unknown').slice(0, 300);
        _logCriticalAlertAttempt(claimId, (ocResult && ocResult.status) || null, ocErr);
        // sendViaOpenClaw already writes its own error_logs row with
        // category='whatsapp_send'; this second write carries the alertKey and
        // the critical_alert subsystem tag, which is what makes the row
        // attributable to a paging failure rather than a patient message.
        _logToErrorLogs((ocResult && ocResult.status) || null, ocErr, key);
      }
    } catch (e) {
      var ocMsg = 'openclaw_threw: ' + (e && e.message ? e.message : 'unknown');
      _logCriticalAlertAttempt(claimId, null, ocMsg);
      _logToErrorLogs(null, ocMsg, key);
    }
    return 'attempted';
  }

  // ── Meta Cloud API transport (legacy, blocked pending verification) ────
  if (!phoneNumberId || !accessToken) return 'off';

  // Theme 9-B: outside Meta's 24h customer-service window, free-form text
  // is silently rejected by Meta (response code 131047). Send as a
  // utility-category template instead. If no template name is configured
  // (e.g. pre-Meta-verification), skip the send and log it — the operator
  // now sees the suppression on /ops/errors as well as in /ops widget 5.
  //
  // This one is NOT "off": the Meta credentials are set and the template is
  // not, which is a half-finished configuration somebody should hear about.
  if (!templateName) {
    _suppressed(claimId, 'template_not_configured', key);
    return 'attempted';
  }

  var body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: adminPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: text }]
      }]
    }
  });

  try {
    var req = https.request({
      hostname: 'graph.facebook.com',
      path: '/' + apiVersion() + '/' + phoneNumberId + '/messages',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, function (res) {
      var status = res.statusCode || 0;
      var chunks = [];
      res.on('data', function (c) { if (chunks.length < 20) chunks.push(c); });
      res.on('end', function () {
        var responseBody = '';
        try { responseBody = Buffer.concat(chunks).toString('utf8').slice(0, 1000); } catch (_) {}
        var isFailure = !(status >= 200 && status < 300);
        _logCriticalAlertAttempt(claimId, status, isFailure ? responseBody : null);
        if (isFailure) _logToErrorLogs(status, responseBody, key);
      });
      res.resume();
    });

    req.on('error', function (err) {
      var msg = 'request_error: ' + (err && err.message ? err.message : 'unknown');
      _logCriticalAlertAttempt(claimId, null, msg);
      _logToErrorLogs(null, msg, key);
    });
    req.on('timeout', function () {
      req.destroy();
      _logCriticalAlertAttempt(claimId, null, 'timeout');
      _logToErrorLogs(null, 'timeout', key);
    });
    req.write(body);
    req.end();
  } catch (e) {
    var msg = 'send_threw: ' + (e && e.message ? e.message : 'unknown');
    _logCriticalAlertAttempt(claimId, null, msg);
    _logToErrorLogs(null, msg, key);
  }
  return 'attempted';
}

module.exports = { sendCriticalAlert: sendCriticalAlert };
