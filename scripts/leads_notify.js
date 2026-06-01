#!/usr/bin/env node
// scripts/leads_notify.js
//
// Launch-blast dispatcher for pre_launch_leads.
//
// Selects every lead where consent=true AND launch_notified_at IS NULL,
// sends the launch email (+ SMS when phone_e164 is present), and stamps
// launch_notified_at on each row AFTER the send completes — so re-running
// the script never double-sends.
//
// Usage:
//   npm run leads:notify                 # send to all eligible recipients
//   npm run leads:notify -- --dry-run    # print who WOULD receive; no sends
//   npm run leads:notify -- --limit 10   # cap batch (useful for canary)
//   npm run leads:notify -- --limit 10 --dry-run
//
// Exit codes:
//   0 — finished cleanly (may still have per-recipient failures logged)
//   1 — fatal: env missing, DB down, etc.

require('dotenv').config();

var args = process.argv.slice(2);
var DRY_RUN = args.indexOf('--dry-run') !== -1;
var LIMIT = null;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    LIMIT = parseInt(args[i + 1], 10) || null;
  }
}

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Source .env.production (Render env) before running.');
  process.exit(1);
}

var { pool, queryAll, execute } = require('../src/pg');
var notify = require('../src/notify/coming_soon');

async function main() {
  console.log('[leads:notify] mode=%s limit=%s', DRY_RUN ? 'DRY-RUN' : 'LIVE', LIMIT || '-');

  // Hard-filter at the SQL layer so the dispatcher module never sees an
  // unconsented row. Order is deterministic for reproducible runs.
  var sql =
    "SELECT id, name, email, phone, phone_e164, language, consent " +
    "FROM pre_launch_leads " +
    "WHERE consent = true AND launch_notified_at IS NULL " +
    "  AND email IS NOT NULL AND email <> '' " +
    "ORDER BY created_at ASC";
  if (LIMIT && LIMIT > 0) sql += ' LIMIT ' + LIMIT;

  var rows = await queryAll(sql);
  console.log('[leads:notify] %d eligible recipient(s)', rows.length);

  if (rows.length === 0) {
    console.log('[leads:notify] nothing to do.');
    return;
  }

  if (DRY_RUN) {
    rows.forEach(function(r) {
      console.log('  - %s <%s> lang=%s phone=%s', r.name || '(no name)', r.email, r.language || 'ar', r.phone_e164 || 'no');
    });
    console.log('[leads:notify] DRY-RUN complete — no sends.');
    return;
  }

  var sent = 0;
  var failed = 0;
  for (var j = 0; j < rows.length; j++) {
    var lead = rows[j];
    var emailRes = { status: 'failed', reason: 'unstarted' };
    var smsRes = { status: 'na', reason: 'unstarted' };
    try {
      emailRes = await notify.sendLaunchEmail(lead);
      smsRes = await notify.sendLaunchSms(lead);
    } catch (err) {
      // Should not throw — dispatchers swallow internally — but belt+braces.
      console.error('[leads:notify] dispatch threw for %s: %s', lead.id, err && err.message);
    }

    // Stamp launch_notified_at ALWAYS (sent or failed) so we don't retry
    // forever on the same address. To force a retry later, an admin can
    // UPDATE pre_launch_leads SET launch_notified_at = NULL WHERE id = $1.
    try {
      await execute(
        'UPDATE pre_launch_leads SET launch_notified_at = NOW(), updated_at = NOW() WHERE id = $1',
        [lead.id]
      );
    } catch (e) {
      console.error('[leads:notify] failed to stamp launch_notified_at for %s: %s', lead.id, e && e.message);
    }

    var oneOk = (emailRes.status === 'sent' || smsRes.status === 'sent');
    if (oneOk) sent++; else failed++;
    console.log('[leads:notify] %s email=%s sms=%s', lead.email,
      emailRes.status + (emailRes.reason ? '(' + emailRes.reason + ')' : ''),
      smsRes.status   + (smsRes.reason   ? '(' + smsRes.reason   + ')' : ''));
  }

  console.log('[leads:notify] done — %d sent, %d failed.', sent, failed);
}

main()
  .then(function() {
    return pool.end();
  })
  .then(function() { process.exit(0); })
  .catch(function(err) {
    console.error('[leads:notify] FATAL:', err && err.message);
    console.error(err && err.stack);
    pool.end().finally(function() { process.exit(1); });
  });
