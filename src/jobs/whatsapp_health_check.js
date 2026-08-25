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

// AUDIT-P1-4: this filtered on context->>'statusCode', a key the WhatsApp
// senders never write — notify/whatsapp.js and lib/openclaw_client.js both
// record the HTTP status under 'status'. Only critical-alert.js writes
// 'statusCode', so the detector could only ever see its own alerting
// failures. When WHATSAPP_ACCESS_TOKEN expired, every send 401'd, this cron
// reported 0, no alert fired, and WhatsApp was silently dead.
//
// 2026-08-25: that fix swapped which half was blind rather than covering
// both. Production proved it — all 19 live whatsapp_send rows are
// critical-alert failures carrying {"statusCode": 401}, and this query asks
// for 'status', so it has been returning 0 while the token has been expired
// for weeks. Read BOTH keys. Also treat OpenClaw's misconfiguration as a
// signal: it writes status null with an oc_env_misconfigured message, which
// is not a 401 but is exactly as fatal to delivery, and was equally silent.
// The context ~ '^\\s*\\{' guard prevents a truncated JSON row (whatsapp.js
// slices context to 4000 chars) from making the ::jsonb cast raise, which
// would abort the whole query and be caught into a 0 result.
async function checkWhatsAppHealth() {
  try {
    var row = await queryOne(
      "SELECT COUNT(*)::int AS c," +
      "       COUNT(*) FILTER (WHERE" +
      "         COALESCE((context::jsonb)->>'status'," +
      "                  (context::jsonb)->>'statusCode') = '401')::int AS unauthorised," +
      "       COUNT(*) FILTER (WHERE message ILIKE '%oc_env_misconfigured%'" +
      "                            OR message ILIKE '%env_missing_openclaw_and_meta%')::int AS misconfigured" +
      " FROM error_logs" +
      " WHERE category = 'whatsapp_send'" +
      "   AND created_at > NOW() - INTERVAL '15 minutes'" +
      "   AND context ~ '^\\s*\\{'" +
      // Do not let THIS alert's own delivery failure re-trigger it.
      //
      // critical-alert.js writes a whatsapp_send row carrying statusCode
      // whenever a page fails to deliver — including a page sent BY this cron.
      // Reading statusCode without this exclusion makes a closed loop: cron
      // fires, alert 401s, that failure lands inside the next 15-minute
      // window, cron fires again. Forever, 96 times a day, with no external
      // input and no way to self-clear. Every other alertKey still counts:
      // a worker_down page failing to deliver IS evidence WhatsApp is down.
      "   AND NOT ((context::jsonb)->>'alertKey' = 'whatsapp_401_detected')" +
      "   AND (" +
      "     COALESCE((context::jsonb)->>'status'," +
      "              (context::jsonb)->>'statusCode') = '401'" +
      "     OR message ILIKE '%oc_env_misconfigured%'" +
      "     OR message ILIKE '%env_missing_openclaw_and_meta%'" +
      "   )"
    );
    var count = row && row.c ? Number(row.c) : 0;
    if (count > 0) {
      var unauthorised = row && row.unauthorised ? Number(row.unauthorised) : 0;
      var misconfigured = row && row.misconfigured ? Number(row.misconfigured) : 0;
      var detail = unauthorised
        ? unauthorised + ' x 401 (token expired — check Render WHATSAPP_ACCESS_TOKEN)'
        : '';
      if (misconfigured) {
        detail += (detail ? ' and ' : '') + misconfigured +
          ' x oc_env_misconfigured (check OPENCLAW_BASE_URL / OPENCLAW_SEND_KEY)';
      }
      sendCriticalAlert(
        'WhatsApp delivery is failing: ' + count + ' send failure(s) in last 15min — ' + detail,
        'whatsapp_401_detected'
      );
      logMajor('[whatsapp-health] delivery failing, count=' + count +
               ' unauthorised=' + unauthorised + ' misconfigured=' + misconfigured);
    }
    return count;
  } catch (e) {
    logMajor('[whatsapp-health] check failed: ' + (e && e.message ? e.message : 'unknown'));
    return 0;
  }
}

module.exports = { checkWhatsAppHealth: checkWhatsAppHealth };
