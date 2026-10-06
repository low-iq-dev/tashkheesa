'use strict';
// tests/watchtower/critical-alert-push.test.js
//
// 6 Oct 2026 — PART 1: a critical alert reaches a phone.
//
// Push is the primary transport for sendCriticalAlert; the log row is marked
// delivered only when Expo accepts a ticket; the per-key throttle holds; and
// WhatsApp is an optional second transport that can neither block nor fail
// the push. The Expo call is faked at global.fetch and src/pg in require.cache.

const { t, check, withStubs, fakePg, fakeExpo, withEnv, tick } = require('./_harness');

console.log('\n🚨 critical alerts go through the Command push\n');

const WA_OFF = {
  ADMIN_PHONE: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_ACCESS_TOKEN: undefined,
  CRITICAL_ALERT_TEMPLATE_NAME: undefined, OPENCLAW_BASE_URL: undefined, OPENCLAW_SEND_KEY: undefined,
  WHATSAPP_TEST_STUB: undefined, NOTIFICATIONS_WHATSAPP_TRANSPORT: undefined,
};

// Two superadmins; the first is signed in on two devices.
const DEVICES = [
  { id: 'sa-1', push_token: 'ExponentPushToken[a1]' },
  { id: 'sa-1', push_token: 'ExponentPushToken[a2]' },
  { id: 'sa-2', push_token: 'ExponentPushToken[b1]' },
];

function setup(opts) {
  const o = opts || {};
  const errorLogs = [];
  const pg = fakePg((sql) => {
    if (/INSERT INTO critical_alert_log/.test(sql)) return o.throttled ? [] : [{ id: 77 }];
    if (/role = 'superadmin'/.test(sql)) return o.devices || DEVICES;
    if (/INSERT INTO ops_push_log/.test(sql)) return [{ id: 1 }];
    return [];
  });
  const stubs = {
    'src/pg.js': pg,
    'src/logger.js': { logErrorToDb: (err, ctx) => errorLogs.push({ message: err.message, ctx }), major: () => {} },
  };
  if (o.openclaw) stubs['src/lib/openclaw_client.js'] = { sendViaOpenClaw: o.openclaw };
  const restoreMods = withStubs(stubs, ['src/critical-alert.js', 'src/services/ops_push.js', 'src/middleware/push.js']);
  const expo = fakeExpo(o.ticket);
  const restoreEnv = withEnv(Object.assign({}, WA_OFF, o.env || {}));
  const { sendCriticalAlert } = require('../../src/critical-alert');
  return {
    sendCriticalAlert, pg, expo, errorLogs,
    outcomeRow: () => pg.calls.filter((c) => /SET delivered/.test(c.sql)).pop(),
    done: () => { restoreEnv(); expo.restore(); restoreMods(); },
  };
}

(async function run() {

  await check('one push per superadmin device, sent as the loud critical_alert kind', async () => {
    const h = setup();
    try {
      await h.sendCriticalAlert('PAYMENT_WEBHOOK: signature rejected', 'paymob_hmac'); await tick();
      const pushes = h.expo.calls.filter((c) => /exp\.host/.test(c.url));
      if (pushes.length !== 3) return 'expected 3 pushes (one per device), got ' + pushes.length;
      const tokens = pushes.map((p) => p.message.to).sort().join(',');
      if (tokens !== 'ExponentPushToken[a1],ExponentPushToken[a2],ExponentPushToken[b1]') return 'wrong recipients: ' + tokens;
      const m = pushes[0].message;
      if (m.data.kind !== 'critical_alert') return 'data.kind is ' + m.data.kind;
      if (m.data.mode !== 'loud' || m.sound !== 'default' || m.priority !== 'high') return 'not delivered loud';
      if (m.data.alertKey !== 'paymob_hmac') return 'alertKey missing from the payload';
      return null;
    } finally { h.done(); }
  });

  await check('the log row is marked delivered when Expo accepts the tickets', async () => {
    const h = setup();
    try {
      await h.sendCriticalAlert('boom', 'k1'); await tick();
      const row = h.outcomeRow();
      if (!row) return 'no delivery outcome was written to critical_alert_log';
      const [id, delivered, attempted, accepted, error] = row.params;
      if (id !== 77) return 'outcome written to the wrong row: ' + id;
      if (delivered !== true) return 'delivered should be true, got ' + delivered;
      if (attempted !== 3 || accepted !== 3) return 'attempted/accepted = ' + attempted + '/' + accepted;
      if (error !== null) return 'push_error should be null on success, got ' + error;
      return null;
    } finally { h.done(); }
  });

  await check('a rejected ticket is recorded as NOT delivered, with the reason', async () => {
    const h = setup({ ticket: () => ({ status: 'error', message: 'bad', details: { error: 'DeviceNotRegistered' } }) });
    try {
      await h.sendCriticalAlert('boom', 'k2'); await tick();
      const row = h.outcomeRow();
      if (!row) return 'no delivery outcome was written';
      if (row.params[1] !== false) return 'delivered should be false when every ticket is rejected';
      if (row.params[3] !== 0) return 'accepted should be 0, got ' + row.params[3];
      if (!/DeviceNotRegistered/.test(String(row.params[4]))) return 'failure reason not stored: ' + row.params[4];
      return null;
    } finally { h.done(); }
  });

  await check('a partial rejection still counts as delivered (someone was told)', async () => {
    let n = 0;
    const h = setup({ ticket: () => (++n === 1 ? { status: 'error', message: 'x', details: { error: 'MessageTooBig' } } : { status: 'ok' }) });
    try {
      await h.sendCriticalAlert('boom', 'k3'); await tick();
      const p = h.outcomeRow().params;
      if (p[1] !== true || p[2] !== 3 || p[3] !== 2) return 'expected delivered with 2 of 3 accepted, got ' + JSON.stringify(p.slice(1, 4));
      return null;
    } finally { h.done(); }
  });

  await check('the per-key throttle holds: a throttled alert pushes nothing', async () => {
    const h = setup({ throttled: true });
    try {
      await h.sendCriticalAlert('boom', 'k4'); await tick();
      if (h.expo.calls.length) return 'a throttled alert still made ' + h.expo.calls.length + ' request(s)';
      if (h.outcomeRow()) return 'a throttled alert wrote a delivery outcome';
      const claim = h.pg.calls.find((c) => /INSERT INTO critical_alert_log/.test(c.sql));
      if (!claim || !/WHERE NOT EXISTS/.test(claim.sql) || !/5 minutes/.test(claim.sql)) return 'the atomic 5-minute claim is gone';
      return null;
    } finally { h.done(); }
  });

  await check('unset WhatsApp config does not throw and is not logged as a failure', async () => {
    const h = setup();
    try {
      await h.sendCriticalAlert('boom', 'k5'); await tick();
      if (h.expo.calls.some((c) => !/exp\.host/.test(c.url))) return 'something other than Expo was called';
      if (h.errorLogs.length) return 'an unset optional transport wrote error_logs: ' + h.errorLogs[0].message;
      if (h.pg.calls.some((c) => /SET status_code/.test(c.sql))) return 'a WhatsApp outcome was written with WhatsApp off';
      return null;
    } finally { h.done(); }
  });

  await check('a WhatsApp transport that throws cannot fail or block the push', async () => {
    const h = setup({
      env: { ADMIN_PHONE: '+201000000000', OPENCLAW_BASE_URL: 'http://oc.test', OPENCLAW_SEND_KEY: 'k' },
      openclaw: async () => { throw new Error('gateway exploded'); },
    });
    try {
      await h.sendCriticalAlert('boom', 'k6'); await tick();
      const row = h.outcomeRow();
      if (!row || row.params[1] !== true) return 'the push was not recorded as delivered';
      const wa = h.pg.calls.find((c) => /SET status_code/.test(c.sql));
      if (!wa || !/openclaw_threw/.test(String(wa.params[2]))) return 'the WhatsApp failure was not recorded on the row';
      return null;
    } finally { h.done(); }
  });

  await check('nobody reachable on any channel is written to error_logs, not swallowed', async () => {
    const h = setup({ devices: [] });
    try {
      await h.sendCriticalAlert('boom', 'k7'); await tick();
      const row = h.outcomeRow();
      if (!row || row.params[1] !== false) return 'delivered should be false with no device';
      if (!/no_superadmin_device_registered/.test(String(row.params[4]))) return 'reason not recorded: ' + row.params[4];
      const e = h.errorLogs.find((x) => x.ctx && x.ctx.category === 'critical_alert');
      if (!e) return 'an alert that reached nobody left no error_logs row';
      return null;
    } finally { h.done(); }
  });

  await check('critical_alert is catalogued: system group, loud, locked on, Arabic label', async () => {
    const prefs = require('../../src/services/ops_push_prefs');
    const k = prefs.KIND_CATALOGUE.find((x) => x.kind === 'critical_alert');
    if (!k) return 'critical_alert is not in KIND_CATALOGUE';
    if (k.group !== 'system' || k.def !== 'loud' || k.lockOn !== true) return 'wrong defaults: ' + JSON.stringify(k);
    if (!k.ar || !/[؀-ۿ]/.test(k.ar)) return 'no Arabic label';
    if (prefs.effectiveMode('critical_alert', 'off') !== 'loud') return "a stored 'off' is not overridden";
    const r = await prefs.setPref('u', 'critical_alert', 'off').catch((e) => ({ threw: e.message }));
    if (!r || r.code !== 'LOCKED_ON') return 'setPref accepted off on a locked kind';
    return null;
  });

  await check('no alert in src/ is addressed to a recipient id that does not exist', async () => {
    const fs = require('fs'); const path = require('path');
    const { ROOT } = require('./_harness');
    const src = fs.readFileSync(path.join(ROOT, 'src/critical-alert.js'), 'utf8');
    if (/toUserId|superadmin-1/.test(src.replace(/\/\/.*$/gm, ''))) return 'critical-alert.js names a recipient id';
    if (!/role = 'superadmin'/.test(fs.readFileSync(path.join(ROOT, 'src/middleware/push.js'), 'utf8'))) {
      return 'notifySuperadmins no longer resolves superadmins by role';
    }
    return null;
  });

})();
