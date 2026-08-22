// src/critical-alert.js
// Send critical WhatsApp alerts to the admin phone.
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
function _logToErrorLogs(statusCode, errorText, alertKey) {
  try {
    var logger = require('./logger');
    if (typeof logger.logErrorToDb !== 'function') return;
    var err = new Error('critical_alert_send_failed: ' + (errorText || 'unknown'));
    logger.logErrorToDb(err, {
      category: 'whatsapp_send',
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

// Public API: sendCriticalAlert(message, alertKey?)
//
// `alertKey` defaults to 'generic' for back-compat — existing callers
// in server.js + routes/payments.js pass just a message today.
// New callers (Phase 7 Widget 4 error-rate alert) pass a distinct key
// so the throttle buckets don't collide.
//
// Returns a Promise that resolves AFTER the request is queued (Meta) or
// dispatched (OpenClaw) — not after the provider's response, which settles
// asynchronously into the DB log row. Existing non-await callers are unchanged.
async function sendCriticalAlert(message, alertKey) {
  // Theme 9-B: read envs per call. Render rotation takes effect on
  // the next call, not the next deploy.
  var adminPhone    = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
  var phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  var accessToken   = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  var templateName  = (process.env.CRITICAL_ALERT_TEMPLATE_NAME || '').trim();
  var templateLang  = (process.env.CRITICAL_ALERT_TEMPLATE_LANG || 'en').trim();

  var key = _deriveAlertKey(alertKey, message);
  var text = '[TASHKHEESA CRITICAL] ' + String(message || 'Unknown error').slice(0, 1000);

  var claimId = await _claimSend(key, text);
  if (claimId === null) return;  // throttled

  if (!adminPhone) {
    _suppressed(claimId, 'env_missing_admin_phone', key);
    return;
  }

  // ── AUDIT-2026-08-22 (N4): route through the CONFIGURED transport. ─────
  //
  // This function always spoke to Meta's Graph API directly, ignoring
  // NOTIFICATIONS_WHATSAPP_TRANSPORT. But .env.example documents the Meta path
  // as blocked pending Business verification, and the default transport was
  // flipped to OpenClaw precisely because OpenClaw is the one that is live. So
  // on the running system every one of the 18 critical alerts — Paymob HMAC
  // failure, payment-intention mismatch, all three markCasePaid-failed-after-
  // capture sites, "video paid while disabled, manual refund needed",
  // worker-down, error-rate spike, the WhatsApp-401 alarm itself — was
  // unreachable, and setting CRITICAL_ALERT_TEMPLATE_NAME would not have fixed
  // it, because the template gate is on a road that leads nowhere.
  //
  // OpenClaw takes free-form text, so there is no HSM template to configure and
  // no 24h customer-service window to fall foul of; the alert text goes as-is.
  //
  // Deliberately calls sendViaOpenClaw directly rather than notify/whatsapp
  // sendWhatsApp: the latter gates on NOTIFICATIONS_WHATSAPP_ENABLED (the
  // patient/doctor notification kill-switch) and on the non-production
  // recipient allowlist. Neither should govern ops paging — an operator
  // turning off patient notifications, or running a staging instance, must
  // still be told the payment webhook is rejecting signatures. ADMIN_PHONE is
  // a single explicitly-configured staff number, not a user's.
  //
  // Both requires are lazy: this module is loaded from server.js's boot path
  // before much of the graph exists, and a critical-alert module that cannot
  // be required is a critical-alert module that cannot warn anyone.
  var transport = 'openclaw';
  try {
    transport = require('./notify/whatsapp').whatsappTransport();
  } catch (_) { /* default stands */ }

  if (transport === 'openclaw') {
    var sendViaOpenClaw;
    try {
      sendViaOpenClaw = require('./lib/openclaw_client').sendViaOpenClaw;
    } catch (e) {
      _suppressed(claimId, 'openclaw_client_unavailable', key);
      return;
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
    return;
  }

  // ── Meta Cloud API transport (legacy, blocked pending verification) ────
  if (!phoneNumberId || !accessToken) {
    _suppressed(claimId, 'env_missing', key);
    return;
  }

  // Theme 9-B: outside Meta's 24h customer-service window, free-form text
  // is silently rejected by Meta (response code 131047). Send as a
  // utility-category template instead. If no template name is configured
  // (e.g. pre-Meta-verification), skip the send and log it — the operator
  // now sees the suppression on /ops/errors as well as in /ops widget 5.
  if (!templateName) {
    _suppressed(claimId, 'template_not_configured', key);
    return;
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
}

module.exports = { sendCriticalAlert: sendCriticalAlert };
