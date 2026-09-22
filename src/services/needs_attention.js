'use strict';

// src/services/needs_attention.js
//
// The sweep that makes silence loud.
//
// THE FAILURE THIS ANSWERS (22 September 2026)
// --------------------------------------------
// Three intake doors, three people who reached out and were never answered:
// Karol through /coming-soon (eight weeks), 66 contact-form submissions into
// an error log nobody reads, and hend — who started a case about her mother's
// breast cancer, got to step 2 of 4, and stopped. Nothing was broken in any of
// them. Every door notifies on SUCCESS; not one watched for SILENCE.
//
// So this does not add a fourth notification. It reads v_needs_attention
// (migration 114) — the single definition of "someone is waiting" — and says
// so, on a clock, whether or not anything happened.
//
// WHY IT RUNS ON RENDER AND NOT ON THE MAC MINI
// ---------------------------------------------
// Tash runs on the mini, and when the mini is offline Tash is down AND its own
// watchdog is down with it. A watchdog that dies alongside the thing it
// watches is not a watchdog. This runs next to the database, on the instance
// that is already externally monitored, and Tash reads the same view for its
// brief rather than owning the alerting.
//
// THE DEAD-MAN'S SWITCH
// ---------------------
// The sweep heartbeats to agent_heartbeats as 'attention_sweep', and that name
// is registered in admin_health.WORKER_SPECS. /healthz already reports every
// spec's freshness and the external uptime monitor already watches /healthz —
// so if this sweep stops running, the existing alarm notices. The alerting
// does not depend on itself being alive to report that it is dead, which is
// the single property all three original doors lacked.

const { queryAll, execute } = require('../db');
const { major: logMajor } = require('../logger');

// A thing must be waiting this long before it is worth waking anyone for.
// Below this, a patient mid-wizard would page you for being mid-wizard.
const ALERT_AFTER_MINUTES = 60;

// One alert per item per this window. Without it, a sweep every 15 minutes
// sends the same person the same message 96 times a day and they stop reading
// any of it — which is the failure mode of every alerting system that ever
// got muted.
const REALERT_AFTER_HOURS = 24;

const AGENT_NAME = 'attention_sweep';

/**
 * Everyone currently waiting on a human, oldest first.
 * @param {object} [opts]
 * @param {number} [opts.minMinutes] only items waiting at least this long
 * @returns {Promise<Array>}
 */
async function listWaiting(opts) {
  const minMinutes = (opts && typeof opts.minMinutes === 'number') ? opts.minMinutes : 0;
  return queryAll(
    'SELECT kind, ref, who, email, phone, summary, waiting_since, severity, ' +
    '       EXTRACT(EPOCH FROM (NOW() - waiting_since)) / 60 AS waiting_minutes ' +
    '  FROM v_needs_attention ' +
    ' WHERE waiting_since < NOW() - ($1 || \' minutes\')::interval ' +
    ' ORDER BY severity ASC, waiting_since ASC',
    [String(minMinutes)]
  );
}

/**
 * A one-line-per-item digest, newest concern first. Plain text on purpose:
 * it has to survive WhatsApp, an SMS, an email body and a terminal.
 */
function formatDigest(items) {
  if (!items.length) return 'Nobody is waiting. All four intake doors are clear.';
  const lines = items.slice(0, 20).map((i) => {
    const hrs = Math.floor(Number(i.waiting_minutes) / 60);
    const age = hrs >= 48 ? Math.floor(hrs / 24) + 'd' : (hrs >= 1 ? hrs + 'h' : '<1h');
    return '• [' + age + '] ' + i.kind.replace(/_/g, ' ') + ' — ' + i.who +
           (i.email ? ' (' + i.email + ')' : '') + ': ' + (i.summary || '').slice(0, 90);
  });
  if (items.length > 20) lines.push('• …and ' + (items.length - 20) + ' more');
  return lines.join('\n');
}

/**
 * Has this exact item already been alerted on inside the re-alert window?
 * Uses error_logs as the ledger — it is already the durable append-only record
 * this service keeps, and a dedicated table for "did I mention this" would be
 * one more thing to migrate and back up for no gain.
 */
async function alreadyAlerted(kind, ref) {
  const rows = await queryAll(
    "SELECT 1 FROM error_logs " +
    " WHERE category = 'attention_alert' AND context LIKE $1 " +
    "   AND created_at > NOW() - ($2 || ' hours')::interval LIMIT 1",
    ['%"' + kind + ':' + ref + '"%', String(REALERT_AFTER_HOURS)]
  );
  return rows.length > 0;
}

async function recordAlerted(items) {
  if (!items.length) return;
  const keys = items.map((i) => i.kind + ':' + i.ref);
  try {
    await execute(
      "INSERT INTO error_logs (id, error_id, level, message, category, context, created_at) " +
      "VALUES (gen_random_uuid()::text, gen_random_uuid()::text, 'info', $1, 'attention_alert', $2, NOW())",
      ['attention sweep alerted on ' + items.length + ' item(s)', JSON.stringify({ alerted: keys })]
    );
  } catch (e) {
    // Never let the ledger write sink the alert that already went out.
    console.error('[attention-sweep] could not record alert ledger:', e && e.message);
  }
}

/**
 * One pass. Returns a summary rather than throwing, because a sweep that
 * crashes is a sweep that stops running, and this one exists precisely to
 * survive being ignored.
 *
 * @param {object} [deps] injectable for tests
 * @returns {Promise<{total:number, alertable:number, alerted:number, digest:string}>}
 */
async function runAttentionSweep(deps) {
  const d = deps || {};
  const _list = d.listWaiting || listWaiting;
  const _already = d.alreadyAlerted || alreadyAlerted;
  const _record = d.recordAlerted || recordAlerted;
  const _send = d.sendAlert || defaultSendAlert;

  let waiting = [];
  try {
    waiting = await _list({ minMinutes: 0 });
  } catch (err) {
    logMajor('[attention-sweep] could not read v_needs_attention — nobody is being watched right now', {
      error: err && err.message
    });
    return { total: 0, alertable: 0, alerted: 0, digest: '', failed: true };
  }

  const alertable = waiting.filter((i) => Number(i.waiting_minutes) >= ALERT_AFTER_MINUTES);

  const fresh = [];
  for (const item of alertable) {
    let seen = false;
    try { seen = await _already(item.kind, item.ref); } catch (_) { seen = false; }
    if (!seen) fresh.push(item);
  }

  if (fresh.length) {
    const body =
      'Tashkheesa — ' + fresh.length + ' new ' +
      (fresh.length === 1 ? 'person is' : 'people are') + ' waiting on a reply:\n\n' +
      formatDigest(fresh);
    try {
      await _send(body, fresh);
      await _record(fresh);
    } catch (err) {
      // Do NOT record: an alert that failed to send must be retried next pass,
      // not marked as delivered. This is the difference between a queue and a
      // shrug.
      logMajor('[attention-sweep] alert send FAILED — will retry next pass', {
        error: err && err.message, items: fresh.length
      });
    }
  }

  return {
    total: waiting.length,
    alertable: alertable.length,
    alerted: fresh.length,
    digest: formatDigest(waiting)
  };
}

async function defaultSendAlert(body) {
  const { sendCriticalAlert } = require('../critical-alert');
  await sendCriticalAlert(body, 'attention-sweep');
}

module.exports = {
  runAttentionSweep,
  listWaiting,
  formatDigest,
  ALERT_AFTER_MINUTES,
  REALERT_AFTER_HOURS,
  AGENT_NAME
};
