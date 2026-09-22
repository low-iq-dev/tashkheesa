'use strict';
// tests/core/attention-sweep.test.js
//
// 2026-09-22 — the sweep that makes silence loud
//
// Three intake doors each swallowed a real person: Karol through /coming-soon
// (eight weeks), 66 contact-form submissions into an error log, and hend, who
// started a case about her mother's breast-cancer MRI, reached step 2 of 4 and
// stopped. Nothing was broken in any of them. Every door notified on SUCCESS;
// none watched for SILENCE.
//
// These pin the behaviours that make this sweep different from the three
// notification paths that already existed and did not help.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const {
  runAttentionSweep, formatDigest, ALERT_AFTER_MINUTES, REALERT_AFTER_HOURS, AGENT_NAME
} = require('../../src/services/needs_attention');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🔔 the attention sweep\n');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

async function check(name, fn) {
  try { const err = await fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

const item = (over) => Object.assign({
  kind: 'abandoned_case', ref: 'r1', who: 'hend', email: 'h@example.com',
  phone: null, summary: 'mother has breast cancer, MRI report',
  waiting_since: new Date(Date.now() - 3 * 3600e3), severity: 1, waiting_minutes: 180
}, over || {});

(async function run() {

  await check('someone waiting past the threshold produces an alert', async () => {
    let sent = null;
    const r = await runAttentionSweep({
      listWaiting: async () => [item()],
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async (body) => { sent = body; }
    });
    if (r.alerted !== 1) return 'expected 1 alert, got ' + r.alerted;
    if (!sent || sent.indexOf('hend') === -1) return 'the person is not named in the alert';
    return null;
  });

  await check('someone still mid-wizard is NOT alerted on', async () => {
    const r = await runAttentionSweep({
      listWaiting: async () => [item({ waiting_minutes: ALERT_AFTER_MINUTES - 1 })],
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async () => { throw new Error('should not have sent'); }
    });
    return r.alerted === 0 ? null : 'paged someone for being mid-wizard';
  });

  await check('an item already alerted on today is not repeated', async () => {
    const r = await runAttentionSweep({
      listWaiting: async () => [item()],
      alreadyAlerted: async () => true,
      recordAlerted: async () => {},
      sendAlert: async () => { throw new Error('should not have sent'); }
    });
    return r.alerted === 0 ? null : 'would send the same person the same alert every 15 minutes';
  });

  await check('a FAILED send is not recorded — it must retry next pass', async () => {
    let recorded = false;
    const r = await runAttentionSweep({
      listWaiting: async () => [item()],
      alreadyAlerted: async () => false,
      recordAlerted: async () => { recorded = true; },
      sendAlert: async () => { throw new Error('whatsapp down'); }
    });
    if (recorded) return 'a failed alert was marked as delivered — the person is lost again';
    if (r.alerted !== 1) return 'shape changed';
    return null;
  });

  await check('a send failure does not throw the sweep out', async () => {
    const r = await runAttentionSweep({
      listWaiting: async () => [item()],
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async () => { throw new Error('boom'); }
    });
    return r && typeof r.total === 'number' ? null : 'the sweep died on a send failure';
  });

  await check('a database failure degrades loudly instead of reporting "all clear"', async () => {
    const r = await runAttentionSweep({
      listWaiting: async () => { throw new Error('pool timeout'); },
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async () => { throw new Error('should not send'); }
    });
    if (!r.failed) return 'a DB failure looked identical to nobody waiting';
    return r.alerted === 0 ? null : 'alerted on nothing';
  });

  await check('nobody waiting says so plainly rather than sending nothing', async () => {
    const r = await runAttentionSweep({
      listWaiting: async () => [],
      alreadyAlerted: async () => false,
      recordAlerted: async () => {},
      sendAlert: async () => { throw new Error('should not send'); }
    });
    if (r.alerted !== 0) return 'alerted with an empty queue';
    return /Nobody is waiting/.test(r.digest) ? null : 'empty digest is not legible';
  });

  await check('the worst case is listed first, not the newest', async () => {
    const old = item({ ref: 'old', who: 'Karol', severity: 1, waiting_minutes: 60 * 24 * 54 });
    const neu = item({ ref: 'new', who: 'Someone', severity: 3, waiting_minutes: 120 });
    const d = formatDigest([old, neu]);
    return d.indexOf('Karol') < d.indexOf('Someone') ? null : 'ordering is not by severity';
  });

  await check('a long queue is truncated rather than sent as a wall of text', async () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ ref: 'r' + i }));
    const d = formatDigest(many);
    if (d.split('\n').length > 22) return 'digest is ' + d.split('\n').length + ' lines';
    return /20 more/.test(d) ? null : 'truncation is silent — the count is hidden';
  });

  // ── the wiring that makes it a watchdog rather than another silent job ──

  await check('the sweep heartbeats under a name the watchdog knows', () => {
    const health = read('src/services/admin_health.js');
    if (!new RegExp("'" + AGENT_NAME + "'").test(health)) {
      return AGENT_NAME + ' is not in WORKER_SPECS — /healthz would never notice it stop';
    }
    return /pingOps\('attention_sweep'/.test(read('src/job_queue.js'))
      ? null : 'the job never pings, so its heartbeat is always stale';
  });

  await check('it is scheduled on a clock, not triggered by an event', () => {
    const jq = read('src/job_queue.js');
    if (!/boss\.schedule\('attention-sweep'/.test(jq)) return 'not scheduled';
    return /\*\/15 \* \* \* \*/.test(jq) ? null : 'not on the 15-minute cadence';
  });

  await check('it is a singleton, so two instances cannot double-alert', () => (
    /singletonKey: 'attention-sweep'/.test(read('src/job_queue.js'))
      ? null : 'no singletonKey'
  ));

  await check('server.js schedules it, and not behind SLA_MODE', () => {
    const srv = read('src/server.js');
    if (!/scheduleAttentionSweep\(\)/.test(srv)) return 'never scheduled at boot';
    const at = srv.indexOf('await scheduleAttentionSweep()');
    const slaAt = srv.indexOf('slaBoss = await scheduleSlaSweep()');
    return (slaAt === -1 || at < slaAt) ? null : 'it sits inside the SLA_MODE branch';
  });

  await check('the view exists and covers all four doors', () => {
    const f = fs.readdirSync(path.join(root, 'src/migrations')).find((n) => /needs_attention/.test(n));
    if (!f) return 'no migration creates v_needs_attention';
    const sql = read('src/migrations/' + f);
    for (const kind of ['contact_submission', 'pre_launch_lead', 'abandoned_case', 'doctor_application']) {
      if (sql.indexOf("'" + kind + "'") === -1) return 'door not covered: ' + kind;
    }
    return null;
  });

  await check('practice and demo cases are excluded from the queue', () => {
    const f = fs.readdirSync(path.join(root, 'src/migrations')).find((n) => /needs_attention/.test(n));
    const sql = read('src/migrations/' + f);
    if (!/is_practice/.test(sql)) return 'practice cases would page you';
    return /demo_appreview/.test(sql) ? null : 'the App Review demo case would page you';
  });

  await check('re-alert window is a day, not a quarter of an hour', () => (
    REALERT_AFTER_HOURS >= 12 ? null : 'too chatty — this is how alerting gets muted'
  ));

})();
