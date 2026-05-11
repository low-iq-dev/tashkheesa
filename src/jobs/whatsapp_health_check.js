// src/jobs/whatsapp_health_check.js
//
// Theme 9 Sub-issue A — periodic WhatsApp 401 detector (alerting plumbing only).
//
// Runs every 15 min via node-cron (registered in src/server.js). Counts
// error_logs rows tagged category='whatsapp_send' with HTTP status 401 in
// the last 15 minutes; if > 0, fires sendCriticalAlert so ops sees the
// token-expired signal within a single cron window.
//
// Why this is paired with Sub-issue B but ships independently:
//   - The alert PATH (this cron + sendCriticalAlert) is fully Meta-independent.
//   - The alert DELIVERY (sendCriticalAlert → Meta utility template) is gated
//     on CRITICAL_ALERT_TEMPLATE_NAME being set, which depends on Meta
//     verification clearance.
//   Until Meta clears, the cron fires + sendCriticalAlert logs
//   'template_not_configured' to critical_alert_log + error_logs. The /ops
//   dashboard widget surfaces the underlying 401 count regardless — so the
//   operator-facing signal is visible even before Meta clearance.
//
// What sources its input: error_logs rows written by:
//   - src/notify/whatsapp.js (logWhatsAppError → category='whatsapp_send')
//   - src/critical-alert.js (Theme 9-B _logToErrorLogs → category='whatsapp_send')
// One cron, one signal, one inbox.

'use strict';

var { queryOne } = require('../pg');
var { sendCriticalAlert } = require('../critical-alert');
var { major: logMajor } = require('../logger');

async function checkWhatsAppHealth() {
  try {
    var row = await queryOne(
      "SELECT COUNT(*)::int AS c" +
      " FROM error_logs" +
      " WHERE category = 'whatsapp_send'" +
      "   AND created_at > NOW() - INTERVAL '15 minutes'" +
      "   AND (context::jsonb)->>'statusCode' = '401'"
    );
    var count = row && row.c ? Number(row.c) : 0;
    if (count > 0) {
      sendCriticalAlert(
        'WhatsApp 401 detected: ' + count + ' send failure(s) in last 15min. ' +
        'Token may have expired — check Render env WHATSAPP_ACCESS_TOKEN.',
        'whatsapp_401_detected'
      );
      logMajor('[whatsapp-health] 401 detected, count=' + count);
    }
    return count;
  } catch (e) {
    logMajor('[whatsapp-health] check failed: ' + (e && e.message ? e.message : 'unknown'));
    return 0;
  }
}

module.exports = { checkWhatsAppHealth: checkWhatsAppHealth };
