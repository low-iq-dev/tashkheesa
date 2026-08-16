// tests/core/theme8-phase7-widgets.test.js
//
// Theme 8 Phase 7 regression guard — 6 dashboard widgets + migration 049
// + DB-backed critical-alert log.
//
// Source-grep-only test (Phase 3 pattern): no real DB, no server boot.
// Assertions:
//   - migration 049 file present with critical_alert_log CREATE TABLE
//   - critical-alert.js uses DB throttle + logs every attempt
//   - ops.js has the 6 widget queries
//   - ops-dashboard.ejs renders the 6 widget cards
//   - empty-data fallback (`typeof phase7Widgets !== 'undefined'`) present
//   - Behavioral smoke: render the dashboard EJS with empty + populated
//     phase7Widgets locals and confirm both render without error.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📊 Theme 8 Phase 7 — six dashboard widgets + critical_alert_log\n');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; } }
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// 1. Migration 049 present + correct shape.
const m049 = read('src/migrations/049_critical_alert_log.sql');
assert(/CREATE TABLE IF NOT EXISTS\s+critical_alert_log/i.test(m049),
  "migration 049 creates critical_alert_log table", "");
assert(/alert_key\s+TEXT\s+NOT NULL/i.test(m049),
  "migration 049 declares alert_key NOT NULL (for throttle key)", "");
assert(/status_code\s+INTEGER/i.test(m049),
  "migration 049 declares status_code (HTTP status from Meta)", "");
assert(/idx_critical_alert_log_alert_key/i.test(m049),
  "migration 049 indexes (alert_key, sent_at DESC) for throttle lookup", "");

// 2. critical-alert.js rewrite — DB throttle, status capture, attempt log.
const ca = read('src/critical-alert.js');
assert(/critical_alert_log/.test(ca),
  "critical-alert.js references critical_alert_log table", "");
assert(/_logCriticalAlertAttempt|INSERT INTO critical_alert_log/.test(ca),
  "critical-alert.js logs every attempt (success or failure)", "");
assert(/_shouldSend|sent_at\s*>\s*NOW\(\)\s*-\s*INTERVAL/i.test(ca),
  "critical-alert.js does DB-backed throttle check via sent_at > NOW() - INTERVAL", "");
assert(/res\.statusCode|status\s*=\s*res\.statusCode/.test(ca),
  "critical-alert.js captures HTTP status from Meta response", "");
assert(!/var lastSentAt\s*=\s*0\s*;/.test(ca),
  "critical-alert.js no longer uses in-memory `lastSentAt` throttle",
  "in-memory throttle still present — defeats multi-dyno + restart-reset fix");

// 3. ops.js has the 6 widget queries.
const ops = read('src/routes/ops.js');
assert(/notifQueueDepth\b[\s\S]{0,200}status\s+IN\s*\(\s*'queued'\s*,\s*'retry'/.test(ops),
  "Widget 1 (queue depth) queries notifications WHERE status IN (queued, retry)", "");
assert(/notifStatusSplit\b/.test(ops) && /GROUP BY status/.test(ops),
  "Widget 2 (status split) groups notifications by status", "");
assert(/CRON_NAMES\b/.test(ops) && /agent_heartbeats/.test(ops),
  "Widget 3 (cron last-run) reads agent_heartbeats for canonical CRON_NAMES", "");
assert(/AVG\(c\)/.test(ops) && /baseline/i.test(ops) && /INTERVAL '7 days'/i.test(ops),
  "Widget 4 (error rate) computes AVG(c) baseline over '7 days'", "");
assert(/SELECT\s+sent_at[^;]*FROM\s+critical_alert_log/i.test(ops),
  "Widget 5 (critical-alert health) reads critical_alert_log", "");
assert(/resendKeyPresent\b/.test(ops) && /channel\s*=\s*'email'\s*AND\s*status\s*=\s*'sent'/i.test(ops),
  "Widget 6 (Resend health) checks RESEND_API_KEY + last email send", "");

// 4. ops-dashboard.ejs renders the 6 widget cards.
const dash = read('src/views/ops-dashboard.ejs');
// STALE-TEST FIX (2026-08-16): these six matched the ORIGINAL card titles
// ('Notif Queue Depth', 'Cron Last-Run', 'Error Rate (now/baseline)', …). The
// dashboard was rebuilt into the compact pill layout and every title was
// shortened to fit its cell. Matching titles meant the guard could not tell
// "renamed" from "deleted" — and one of them WAS deleted: Widget 5's card
// vanished in the rework while routes/ops.js kept paying for its query on
// every load and throwing the answer away. That is exactly the regression this
// test exists to catch, and the copy-matching form hid it behind five
// identical-looking cosmetic failures.
//
// Assert each widget's DATA BINDING in the view instead. A renamed card still
// passes; a deleted one cannot.
assert(/_w\.notifQueueDepth/.test(dash),          "dashboard renders Widget 1 (queue depth) binding", "");
assert(/_w\.notifStatusSplit/.test(dash),         "dashboard renders Widget 2 (dispatch split) binding", "");
assert(/_w\.cronWidget/.test(dash),               "dashboard renders Widget 3 (cron last-run) binding", "");
assert(/_w\.errorRate\.currentHour/.test(dash) && /_w\.errorRate\.baseline/.test(dash),
  "dashboard renders Widget 4 (error rate) current + baseline bindings", "");
assert(/_w\.lastCriticalAlert|_ca\s*=\s*_w\.lastCriticalAlert/.test(dash),
  "dashboard renders Widget 5 (critical-alert health) binding", "");
assert(/_w\.resend\.envPresent/.test(dash),       "dashboard renders Widget 6 (Resend health) binding", "");

// 5. Empty-data fallback — typeof phase7Widgets !== 'undefined' check.
assert(/typeof phase7Widgets !== 'undefined'/.test(dash),
  "dashboard uses defensive `typeof phase7Widgets !== 'undefined'` fallback",
  "missing fallback — view will crash if locals.phase7Widgets is undefined");

// 6. Behavioral smoke: render the dashboard with both empty + populated
//    phase7Widgets locals. EJS must not throw, output must contain key
//    widget labels.
function makeLocals(phase7Widgets) {
  // Minimum locals the dashboard expects (verified from ops.js res.render call).
  return {
    cspNonce: '', totalCases: 0, casesThisMonth: 0, revenueThisMonth: 0,
    pendingCases: 0, breachedCases: 0, completedThisMonth: 0, revenueAllTime: 0,
    activeDoctors: 0, totalDoctors: 0, totalPatients: 0, nearBreachCases: 0,
    avgCompletionHrs: null, casesToday: 0, revenueToday: 0, newPatientsToday: 0,
    errorsToday: 0, errors24h: 0, errorsByLevel: [], recentErrors: [],
    notifStats: [], unpaidOrders: 0, failedPayments: 0, recentOrders: [],
    agents: [], totalTokenSpend: 0, igStats: [], cairoTime: 'now',
    uptime: '0m', slaMode: 'primary', nodeVersion: 'v20', heapUsedMb: 0,
    heapTotalMb: 0, rssMb: 0, gitSha: 'test', dbPoolTotal: 0, dbPoolIdle: 0,
    dbPoolWaiting: 0, mode: 'test', macMiniStatus: { gateway: 'unknown', checkedAt: null },
    macMiniCheckedAgo: null, paymobHealth: { lastIntentionAgo: null, lastWebhookAgo: null, hmacFailures24h: 0 },
    silentFailures7d: 0,
    // STALE-FIXTURE FIX (2026-08-16): the view gained an `errorsOk` local (the
    // green/red "production clean" tier on the Errors 24h cell). routes/ops.js
    // supplies it, but this fixture did not, so both render smokes threw
    // `errorsOk is not defined` and the six behavioural assertions below never
    // ran at all — the file failed loudly while telling us nothing.
    errorsOk: true,
    phase7Widgets: phase7Widgets
  };
}

const DASH_PATH = path.join(ROOT, 'src', 'views', 'ops-dashboard.ejs');

// 6a. Render with undefined phase7Widgets (the defensive fallback path).
try {
  const html = ejs.render(read('src/views/ops-dashboard.ejs'), makeLocals(undefined), { filename: DASH_PATH });
  assert(html.length > 0, "empty-widgets render: produces HTML output", "");
  // STALE-TEST FIX (2026-08-16): the ops dashboard was rebuilt into the compact
  // pill layout and the widget labels were shortened for the narrower cells
  // ('Notif Queue Depth' → 'Queue depth', and the 'card error' tier class
  // became per-card 'error'/'warn'/'ok' on .cron-card). Every widget, binding
  // and colour tier survived the rework; only the copy and the class names
  // moved. Assert the DATA BINDINGS the ops route promises the view, which is
  // the contract that actually matters, plus one label so the number is not
  // rendered bare.
  assert(html.indexOf('data-stat="phase7Widgets.notifQueueDepth"') !== -1,
    "empty-widgets render: still renders the Widget 1 queue-depth binding", "");
  assert(/Queue depth/i.test(html), "empty-widgets render: queue-depth cell is labelled", "");
  assert(html.indexOf('never') !== -1 || html.indexOf('NO KEY') !== -1,
    "empty-widgets render: shows 'never' or 'NO KEY' placeholders gracefully", "");
} catch (e) {
  t.fail(fileTag + ': empty-widgets EJS render throws', e);
}

// 6b. Render with populated phase7Widgets — verify color tiers and labels.
try {
  const populated = {
    notifQueueDepth: 73,                                  // 50+ → red
    notifOldestStuckSec: 720,                             // 12 min → matches red
    notifOldestStuckAgo: '12min',
    notifStatusSplit: [
      { status: 'sent', c: 1240 },
      { status: 'skipped', c: 31 },                       // Phase 4-C unlock
      { status: 'failed', c: 4 }
    ],
    cronWidget: [
      { name: 'case_sla_worker', lastRun: new Date(), lastRunAgo: '2min' },
      { name: 'notification_worker', lastRun: null, lastRunAgo: null }, // never run
      { name: 'video_scheduler', lastRun: new Date(Date.now() - 30 * 60 * 1000), lastRunAgo: '30min' }, // red
      { name: 'instagram_scheduler', lastRun: new Date(Date.now() - 12 * 60 * 1000), lastRunAgo: '12min' }, // amber
      { name: 'acceptance_watcher', lastRun: null, lastRunAgo: null }
    ],
    errorRate: { currentHour: 25, baseline: 4 },          // 6.25× → red
    lastCriticalAlert: { sentAt: new Date(), ago: '5min', statusCode: 200, ok: true, alertKey: 'generic', error: null },
    resend: { envPresent: true, lastSentAt: new Date(), lastSentAgo: '3min' }
  };
  const html = ejs.render(read('src/views/ops-dashboard.ejs'), makeLocals(populated), { filename: DASH_PATH });
  assert(html.indexOf('73') !== -1, "populated render: Widget 1 shows queue depth 73", "");
  assert(html.indexOf('skipped') !== -1, "populated render: Widget 2 includes 'skipped' status pill", "");
  assert(html.indexOf('case_sla_worker') !== -1, "populated render: Widget 3 lists case_sla_worker", "");
  assert(html.indexOf('never run') !== -1, "populated render: Widget 3 shows 'never run' for missing heartbeats", "");
  // The baseline is now rendered with one decimal (4 → "4.0") so a baseline of
  // 4.25 does not display as 4. Match the current/baseline pair structurally
  // rather than pinning the old integer formatting.
  assert(/25<\/span>\/<span[^>]*>4\.0</.test(html) || /25\s*\/\s*4(\.0)?/.test(html),
    "populated render: Widget 4 shows the current/baseline pair (25 over 4.0)", "");
  // Colour tiers: the redesign replaced the shared 'card error' class with
  // per-card 'error' / 'warn' / 'ok' on .cron-card. video_scheduler is 30min
  // stale in this fixture, which is past the 25min red threshold.
  assert(/cron-card\s+error/.test(html),
    "populated render: a stale worker is rendered in the red tier (cron-card error)", "");
  assert(/cron-card\s+warn/.test(html),
    "populated render: a 12min-stale worker is rendered in the amber tier (cron-card warn)", "");
} catch (e) {
  t.fail(fileTag + ': populated EJS render throws', e);
}
