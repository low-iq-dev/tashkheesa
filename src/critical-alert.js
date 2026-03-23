// src/critical-alert.js
// Send critical WhatsApp alerts to the admin phone. Throttled to 1 per 5 minutes.

var https = require('https');

var ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
var WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
var WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
var WHATSAPP_API_VERSION = (process.env.WHATSAPP_API_VERSION || 'v22.0').trim();

var THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
var lastSentAt = 0;

function sendCriticalAlert(message) {
  var now = Date.now();

  // Throttle: max 1 alert per 5 minutes
  if (now - lastSentAt < THROTTLE_MS) {
    return;
  }

  if (!ADMIN_PHONE || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    return;
  }

  lastSentAt = now;

  var text = '[TASHKHEESA CRITICAL] ' + String(message || 'Unknown error').slice(0, 1000);

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
    }, function(res) {
      // Drain response to free socket
      res.resume();
    });

    req.on('error', function() {});
    req.on('timeout', function() { req.destroy(); });
    req.write(body);
    req.end();
  } catch (_) {}
}

module.exports = { sendCriticalAlert: sendCriticalAlert };
