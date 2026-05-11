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
function _logCriticalAlertAttempt(alertKey, statusCode, errorText, message) {
  try {
    var pg = require('./pg');
    pg.execute(
      "INSERT INTO critical_alert_log (alert_key, status_code, error, message)" +
      " VALUES ($1, $2, $3, $4)",
      [
        String(alertKey || 'unknown').slice(0, 200),
        statusCode == null ? null : Number(statusCode),
        errorText == null ? null : String(errorText).slice(0, 1000),
        message == null ? null : String(message).slice(0, 1000)
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

// Returns Promise<boolean>: true if we should send (no recent send for
// this alert_key), false if throttled. Fails open (returns true) if the
// DB is unavailable — we'd rather risk a duplicate alert during a DB
// outage than suppress the alert that says "DB is down".
async function _shouldSend(alertKey) {
  try {
    var pg = require('./pg');
    var row = await pg.queryOne(
      "SELECT 1 FROM critical_alert_log" +
      " WHERE alert_key = $1" +
      "   AND sent_at > NOW() - INTERVAL '" + THROTTLE_MINUTES + " minutes'" +
      " LIMIT 1",
      [alertKey]
    );
    return !row;  // no recent row → send
  } catch (_) {
    return true;  // DB unavailable → fail open
  }
}

// Public API: sendCriticalAlert(message, alertKey?)
//
// `alertKey` defaults to 'generic' for back-compat — existing callers
// in server.js + routes/payments.js pass just a message today.
// New callers (Phase 7 Widget 4 error-rate alert) pass a distinct key
// so the throttle buckets don't collide.
//
// Returns a Promise that resolves AFTER the HTTPS request is queued
// (not after Meta responds — that happens asynchronously). Existing
// non-await callers continue to work; the DB log row settles whenever
// the response lands.
async function sendCriticalAlert(message, alertKey) {
  // Theme 9-B: read envs per call. Render rotation takes effect on
  // the next call, not the next deploy.
  var adminPhone    = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
  var phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  var accessToken   = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  var templateName  = (process.env.CRITICAL_ALERT_TEMPLATE_NAME || '').trim();
  var templateLang  = (process.env.CRITICAL_ALERT_TEMPLATE_LANG || 'en').trim();

  var key = String(alertKey || 'generic').slice(0, 200);
  var text = '[TASHKHEESA CRITICAL] ' + String(message || 'Unknown error').slice(0, 1000);

  var ok = await _shouldSend(key);
  if (!ok) return;

  // Env gate — log the attempt as suppressed so /ops widget 5 still
  // shows we tried (and why it didn't go through).
  if (!adminPhone || !phoneNumberId || !accessToken) {
    _logCriticalAlertAttempt(key, null, 'env_missing', text);
    return;
  }

  // Theme 9-B: outside Meta's 24h customer-service window, free-form text
  // is silently rejected by Meta (response code 131047). Send as a
  // utility-category template instead. If no template name is configured
  // (e.g. pre-Meta-verification), skip the send and log it — the operator
  // still sees the suppression in /ops widget 5.
  if (!templateName) {
    _logCriticalAlertAttempt(key, null, 'template_not_configured', text);
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
        _logCriticalAlertAttempt(key, status, isFailure ? responseBody : null, text);
        if (isFailure) _logToErrorLogs(status, responseBody, key);
      });
      res.resume();
    });

    req.on('error', function (err) {
      var msg = 'request_error: ' + (err && err.message ? err.message : 'unknown');
      _logCriticalAlertAttempt(key, null, msg, text);
      _logToErrorLogs(null, msg, key);
    });
    req.on('timeout', function () {
      req.destroy();
      _logCriticalAlertAttempt(key, null, 'timeout', text);
      _logToErrorLogs(null, 'timeout', key);
    });
    req.write(body);
    req.end();
  } catch (e) {
    var msg = 'send_threw: ' + (e && e.message ? e.message : 'unknown');
    _logCriticalAlertAttempt(key, null, msg, text);
    _logToErrorLogs(null, msg, key);
  }
}

module.exports = { sendCriticalAlert: sendCriticalAlert };
