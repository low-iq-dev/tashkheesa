// src/jobs/error_rate_check.js
//
// Side issue #50 — error_rate_5x critical-alert cron.
//
// Phase 7 /ops Widget 4 surfaces (current-hour error_logs count) vs
// (rolling 7-day hourly baseline). This cron is the alerting half of
// that signal: every 15 min, run the same baseline-vs-current query
// and fire sendCriticalAlert('error_rate_5x', ...) when
//   current >= 5 AND current >= 5 * baseline
// — i.e. the per-hour error count is both absolutely meaningful AND
// at least 5x the trailing baseline. The absolute floor prevents
// false-positives during quiet windows where any single error would
// otherwise exceed a ~0 baseline.
//
// Throttle: sendCriticalAlert keys on the alertKey arg. Reusing
// 'error_rate_5x' makes Phase 7's DB-backed _shouldSend() suppress
// repeat fires inside its window (so a sustained spike doesn't spam
// the admin WhatsApp).
//
// Pattern: mirrors src/jobs/whatsapp_health_check.js (Theme 9
// Sub-issue A). Same arity, same logger taps, same error-swallow.

'use strict';

var { queryOne } = require('../pg');
var { sendCriticalAlert } = require('../critical-alert');
var { major: logMajor } = require('../logger');

async function checkErrorRate() {
  try {
    var row = await queryOne(
      "WITH baseline AS (" +
      "  SELECT COALESCE(AVG(c), 0) AS avg_per_hour FROM (" +
      "    SELECT date_trunc('hour', created_at) AS h, COUNT(*) AS c" +
      "      FROM error_logs" +
      "     WHERE created_at >= NOW() - INTERVAL '7 days'" +
      "       AND created_at <  date_trunc('hour', NOW())" +
      "     GROUP BY 1" +
      "  ) sub" +
      ")," +
      " cur AS (" +
      "  SELECT COUNT(*) AS c FROM error_logs" +
      "   WHERE created_at >= date_trunc('hour', NOW())" +
      " )" +
      " SELECT cur.c AS current_hour, baseline.avg_per_hour AS baseline" +
      "   FROM cur, baseline"
    );
    var currentHour = row && row.current_hour != null ? Number(row.current_hour) : 0;
    var baseline    = row && row.baseline     != null ? Number(row.baseline)     : 0;

    var ratioBreach    = currentHour >= 5 * baseline;
    var absoluteBreach = currentHour >= 5;

    if (ratioBreach && absoluteBreach) {
      var ratioStr = baseline > 0
        ? (currentHour / baseline).toFixed(1) + 'x baseline'
        : 'cold-start (baseline=0)';
      sendCriticalAlert(
        'Error rate spike: ' + currentHour + ' errors this hour vs baseline ' +
        baseline.toFixed(2) + '/hr (' + ratioStr + '). Check /ops Widget 4 + error_logs.',
        'error_rate_5x'
      );
      logMajor('[error-rate] spike detected: current=' + currentHour + ' baseline=' + baseline.toFixed(2));
    }
    return { currentHour: currentHour, baseline: baseline };
  } catch (e) {
    logMajor('[error-rate] check failed: ' + (e && e.message ? e.message : 'unknown'));
    return { currentHour: 0, baseline: 0 };
  }
}

module.exports = { checkErrorRate: checkErrorRate };
