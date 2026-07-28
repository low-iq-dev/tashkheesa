'use strict';
// Watchdog LAYER 4 (Command push) trigger logic (Batch 2a):
//   - a worker going DOWN fires exactly one superadmin push
//   - while it stays down, the 30-min cooldown SUPPRESSES further pushes
//   - the cooldown survives a "restart" (state is durable in admin_settings, not
//     in memory), so a crash loop cannot re-fire a spam burst
//   - once the cooldown elapses it re-alerts
//   - recovery (down → alive) fires exactly one "recovered" push
//   - a notifySuperadmins failure never breaks the sweep, and still cools down
// notifySuperadmins is mocked via the watchdog's _deps seam — the Expo send never runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { WORKER_SPECS } = require('../../src/services/admin_health');
const watchdog = require('../../src/services/worker_watchdog');

const DOWN = 'case_sla_worker';
const BIG_UPTIME = 1e9; // large so a stale worker classifies 'down', not 'starting'
const MIN = 60 * 1000;

// A pg-style pool over a shared, DURABLE settings map (admin_settings) and a
// per-sweep heartbeats map. Mirrors the exact queries runWorkerWatchdogSweep
// issues, including the LAYER 4 advisory lock (opts.lockGranted, default true)
// and the pool.connect() the claim runs on.
function makePool(state, opts) {
  opts = opts || {};
  const lockGranted = opts.lockGranted !== false;
  const handle = async (sql, params) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: lockGranted }] };
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ unlocked: true }] };
    if (/FROM agent_heartbeats/.test(sql)) {
      const rows = [];
      for (const n of params[0]) {
        const v = state.heartbeats[n];
        if (v != null) rows.push({ agent_name: n, last_run: v });
      }
      return { rows };
    }
    if (/SELECT value FROM admin_settings WHERE key/.test(sql)) {
      const v = state.settings[params[0]];
      return { rows: v != null ? [{ value: v }] : [] };
    }
    if (/INSERT INTO admin_settings/.test(sql)) { state.settings[params[0]] = params[1]; return { rows: [] }; }
    if (/DELETE FROM admin_settings WHERE key/.test(sql)) { delete state.settings[params[0]]; return { rows: [] }; }
    return { rows: [] };
  };
  return {
    query: handle,
    connect: async () => ({ query: handle, release() {} }),
  };
}

// All workers fresh at `now` EXCEPT `downName` (heartbeat 1h stale ⇒ down).
function setHeartbeats(state, now, downName) {
  const hb = {};
  for (const s of WORKER_SPECS) hb[s.key] = new Date(now - 1000);
  if (downName) hb[downName] = new Date(now - 3600 * 1000);
  state.heartbeats = hb;
}

// Capture notifySuperadmins calls; silence the other three sinks.
function spyPushDeps(impl) {
  const calls = [];
  watchdog._setDepsForTests({
    notifySuperadmins: impl || (async (pool, notif) => { calls.push(notif); }),
    logErrorToDb: async () => {},
    sendCriticalAlert: async () => {},
    logFatal: () => {},
    logMajor: () => {},
  });
  return calls;
}

test('LAYER 4: down→once, cooldown suppresses, survives restart, re-alerts after 30m, recovery once', async (t) => {
  const state = { settings: {}, heartbeats: {} };
  let pool = makePool(state);
  const calls = spyPushDeps();
  t.after(() => watchdog._resetDepsForTests());

  const t0 = 1_800_000_000_000;

  // 1) DOWN → exactly one push, cooldown state persisted
  setHeartbeats(state, t0, DOWN);
  let r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0, uptimeSec: BIG_UPTIME });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pushed, [DOWN]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.type, 'worker_down');
  assert.equal(calls[0].data.worker, DOWN);
  assert.ok(state.settings['worker_down_push'], 'cooldown state persisted to admin_settings');

  // 2) +5 min, still down → cooldown suppresses
  setHeartbeats(state, t0 + 5 * MIN, DOWN);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 5 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushed, []);
  assert.equal(calls.length, 1);

  // 3) RESTART: brand-new pool over the SAME durable settings → still suppressed
  pool = makePool(state);
  setHeartbeats(state, t0 + 6 * MIN, DOWN);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 6 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushed, []);
  assert.equal(calls.length, 1, 'restart must NOT re-fire within cooldown');

  // 4) +31 min from first push, still down → re-alert
  setHeartbeats(state, t0 + 31 * MIN, DOWN);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 31 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushed, [DOWN]);
  assert.equal(calls.length, 2);

  // 5) RECOVERY: heartbeats again → one recovery push, cooldown entry cleared
  setHeartbeats(state, t0 + 32 * MIN, null);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 32 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushRecovered, [DOWN]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].data.type, 'worker_recovered');
  assert.equal(calls[2].data.worker, DOWN);
  assert.equal(state.settings['worker_down_push'], undefined, 'push state dropped when nothing pending');

  // 6) next healthy sweep → no further recovery push
  setHeartbeats(state, t0 + 33 * MIN, null);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 33 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushRecovered, []);
  assert.equal(calls.length, 3);
});

test('LAYER 4: advisory lock NOT acquired → no claim, no push (concurrent-sweep guard)', async (t) => {
  const state = { settings: {}, heartbeats: {} };
  const pool = makePool(state, { lockGranted: false });
  const calls = spyPushDeps();
  t.after(() => watchdog._resetDepsForTests());

  const t0 = 1_800_000_000_000;
  setHeartbeats(state, t0, DOWN);
  const r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0, uptimeSec: BIG_UPTIME });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pushed, [], 'losing the claim lock means no push this tick');
  assert.equal(calls.length, 0);
  assert.equal(state.settings['worker_down_push'], undefined, 'no cooldown slot claimed without the lock');
});

test('LAYER 4: a notifySuperadmins failure never breaks the sweep, and cooldown still applies', async (t) => {
  const state = { settings: {}, heartbeats: {} };
  const pool = makePool(state);
  let n = 0;
  spyPushDeps(async () => { n++; throw new Error('push sink down'); });
  t.after(() => watchdog._resetDepsForTests());

  const t0 = 1_800_000_000_000;
  setHeartbeats(state, t0, DOWN);
  let r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0, uptimeSec: BIG_UPTIME });
  assert.equal(r.ok, true, 'sweep stays ok even though the push threw');
  assert.deepEqual(r.pushed, [DOWN]);
  assert.equal(n, 1);

  // cooldown stamped despite the throw → next tick suppressed (no retry storm)
  setHeartbeats(state, t0 + 2 * MIN, DOWN);
  r = await watchdog.runWorkerWatchdogSweep(pool, { now: t0 + 2 * MIN, uptimeSec: BIG_UPTIME });
  assert.deepEqual(r.pushed, []);
  assert.equal(n, 1, 'a failing sink must not retry every tick');
});
