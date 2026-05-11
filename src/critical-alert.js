// src/critical-alert.js
// Send critical WhatsApp alerts to the admin phone.
//
// Theme 8 Phase 7 (OQ-6): DB-backed throttle + delivery log.
//
// Pre-Phase-7 this used an in-memory `lastSentAt` variable, which had
// two failure modes documented in P1-ERR-7 of the audit:
//   1. Multi-dyno: each instance had its own counter; horizontal
//      scale-out multiplied alerts by dyno count.
//   2. Restart reset: every process.exit(1) wiped the throttle, so
//      a crash loop fired one WhatsApp PER crash — Meta rate-limit
//      burnout territory.
//
// Now: throttle state lives in `critical_alert_log` (migration 049).
// Every send attempt — successful or failed — writes a row including
// the HTTP status from Meta. Widget 5 on /ops surfaces last-attempt
// age + status so operators see when the alert pipeline itself breaks.

var https = require('https');

var ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
var WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
var WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
var WHATSAPP_API_VERSION = (process.env.WHATSAPP_API_VERSION || 'v22.0').trim();

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
  var key = String(alertKey || 'generic').slice(0, 200);
  var text = '[TASHKHEESA CRITICAL] ' + String(message || 'Unknown error').slice(0, 1000);

  var ok = await _shouldSend(key);
  if (!ok) return;

  // Env gate — log the attempt as suppressed so /ops widget 5 still
  // shows we tried (and why it didn't go through).
  if (!ADMIN_PHONE || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    _logCriticalAlertAttempt(key, null, 'env_missing', text);
    return;
  }

  var body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: ADMIN_PHONE,
    type: 'text',
    text: { body: text }
  });

  try {
    var req = https.request({
      hostname: 'graph.facebook.com',
      path: '/' + WHATSAPP_API_VERSION + '/' + WHATSAPP_PHONE_NUMBER_ID + '/messages',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WHATSAPP_ACCESS_TOKEN,
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
        _logCriticalAlertAttempt(
          key,
          status,
          (status >= 200 && status < 300) ? null : responseBody,
          text
        );
      });
      res.resume();
    });

    req.on('error', function (err) {
      _logCriticalAlertAttempt(key, null, 'request_error: ' + (err && err.message ? err.message : 'unknown'), text);
    });
    req.on('timeout', function () {
      req.destroy();
      _logCriticalAlertAttempt(key, null, 'timeout', text);
    });
    req.write(body);
    req.end();
  } catch (e) {
    _logCriticalAlertAttempt(key, null, 'send_threw: ' + (e && e.message ? e.message : 'unknown'), text);
  }
}

module.exports = { sendCriticalAlert: sendCriticalAlert };
