// src/services/worker_watchdog.js
//
// Dead-man's-switch for the two cron workers (case_sla_worker, acceptance_watcher).
// A watchdog needs a heartbeat to watch: both workers stamp agent_heartbeats
// (via /ops/agent/ping) on EVERY tick, including no-op ticks. This sweep reads
// MAX(pinged_at) per worker — the exact read GET /api/v1/admin/health uses —
// classifies each with the SHARED admin_health.workerLiveness helper (12-min /
// 6-min staleness budgets), and on a worker going 'down' fires three LAYERED
// sinks, in priority order:
//
//   LAYER 1 (durable, load-bearing): one error_logs row via logErrorToDb,
//     category='worker_down'. This is the sink that cannot silently no-op —
//     it does not depend on Meta/WhatsApp/email being configured.
//   LAYER 2 (the Command deliverable): an admin_settings flag
//     (key='worker_health_banner') mirroring the ai_billing_status pattern
//     exactly — auto-shows when any worker is down, auto-clears when all
//     recover. Command's dashboard banner reads worker status from /health.
//   LAYER 3 (best-effort, explicitly optional): sendCriticalAlert(msg,
//     'worker_down'). Wrapped so its failure (the Meta template may be
//     unverified) can NEVER affect layers 1/2.
//
// IMPORTANT semantics:
//   - Heartbeat absence means "worker OR ping-path down" — copy says
//     "no heartbeat from X for Nm", never "worker X dead".
//   - Side-effects fire only on STATE CHANGE. Prior state is read from the
//     durable admin_settings flag (the source of truth), so a process restart
//     never re-alarms for an already-flagged worker and never re-spams.
//   - Alarm fires on workerLiveness status==='down' ONLY. The 'starting'
//     status (host uptime < budget, i.e. warm-up after a (re)start) never
//     alarms — the budgets already absorb a single skipped tick, so we do not
//     tighten them.
//   - The whole sweep is wrapped: any watchdog error logs to error_logs
//     (category='worker_watchdog') and never throws into the boot loop.
//
// This module is scheduled UNGATED at boot (outside the SLA_MODE==='primary'
// block) so it survives the exact failure mode where flipping that gate kills
// BOTH workers at once.

'use strict';

var { logErrorToDb, fatal: logFatal, major: logMajor } = require('../logger');
var { sendCriticalAlert } = require('../critical-alert');
var { WORKER_SPECS, workerLiveness } = require('./admin_health');
var { notifySuperadmins } = require('../middleware/push');

var FLAG_KEY = 'worker_health_banner';
// LAYER 4 (Command push) cooldown: per-worker last-notified timestamps are kept
// in admin_settings under this key so the 30-min cooldown SURVIVES a process
// restart. The watchdog holds NO in-memory notification state — every sweep
// re-reads these stamps from the DB — so a crash-loop restart cannot re-fire the
// same worker-down push. In-memory would re-alarm on every restart; that is why
// this is durable.
var PUSH_STATE_KEY = 'worker_down_push';
var PUSH_COOLDOWN_MS = 30 * 60 * 1000;
// Cross-instance / self-overlap mutual exclusion for the LAYER 4 push CLAIM.
// The watchdog runs UNGATED in every web instance (server.js) via a non-awaited
// setInterval, so two sweeps can overlap. Without serialisation both could read
// "no cooldown stamp" for the same down worker and BOTH push (duplicate
// superadmin spam). A pg advisory lock (server-global, auto-released when the
// session ends — so a crash can't wedge it) serialises the read-check-write so
// exactly one sweep claims each worker's slot. No other advisory lock exists in
// this codebase; this key is distinct.
var PUSH_LOCK_KEY = 918273645;

// Injectable deps (test seam — mirrors ai_health.js / admin_settings.js).
var _deps = {
  logErrorToDb: logErrorToDb,
  sendCriticalAlert: sendCriticalAlert,
  logFatal: logFatal,
  logMajor: logMajor,
  notifySuperadmins: notifySuperadmins,
};
function _setDepsForTests(d) { if (d) Object.assign(_deps, d); }
function _resetDepsForTests() {
  _deps = {
    logErrorToDb: logErrorToDb,
    sendCriticalAlert: sendCriticalAlert,
    logFatal: logFatal,
    logMajor: logMajor,
    notifySuperadmins: notifySuperadmins,
  };
}

// Human-readable, never-says-"dead" heartbeat-age phrase.
function _agePhrase(name, ageSec, staleSeconds) {
  var budgetMin = Math.round(staleSeconds / 60);
  if (ageSec == null) {
    return 'no heartbeat from ' + name + ' on record (past its ' + budgetMin + 'm budget)';
  }
  return 'no heartbeat from ' + name + ' for ' + Math.round(ageSec / 60) + 'm (budget ' + budgetMin + 'm)';
}

// ── admin_settings flag (mirrors ai_health._writeFlag / getAiHealth) ──────────
async function getWorkerHealthBanner(pool) {
  try {
    var r = await pool.query('SELECT value FROM admin_settings WHERE key = $1', [FLAG_KEY]);
    var row = r && r.rows && r.rows[0];
    if (!row || !row.value) return { down: [], since: null };
    var v = JSON.parse(row.value);
    return {
      down: Array.isArray(v.down) ? v.down : [],
      since: v.since || null,
      ages: v.ages || null,
    };
  } catch (_) {
    // Unreadable → treat as healthy so we never block on a bad/locked read.
    return { down: [], since: null };
  }
}

async function _writeBanner(pool, obj, nowIso) {
  await pool.query(
    "INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES ($1, $2, 'worker-watchdog', $3) " +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at',
    [FLAG_KEY, JSON.stringify(obj), nowIso]
  );
}

async function _clearBanner(pool) {
  // Absence = healthy (same convention as ai_billing_status' "absence = healthy").
  await pool.query('DELETE FROM admin_settings WHERE key = $1', [FLAG_KEY]);
}

// ── LAYER 4 push-cooldown state (own admin_settings key — PUSH_STATE_KEY) ─────
// Shape: { pushedAt: { <workerName>: <epochMs> } }. Isolated from the banner so
// the load-bearing layers 1/2 are untouched by the push feature.
async function _getDownPushState(pool) {
  try {
    var r = await pool.query('SELECT value FROM admin_settings WHERE key = $1', [PUSH_STATE_KEY]);
    var row = r && r.rows && r.rows[0];
    if (!row || !row.value) return { pushedAt: {} };
    var v = JSON.parse(row.value);
    return { pushedAt: (v && typeof v.pushedAt === 'object' && v.pushedAt) ? v.pushedAt : {} };
  } catch (_) {
    // Fail-open (same posture as the banner read). A transient read failure costs
    // at most ONE extra push per tick (the claim then sees no stamp) and self-heals
    // once the write lands. In the rare CORRELATED case where BOTH the read and
    // write of admin_settings fail while a worker stays down, no stamp ever
    // persists, so this can re-alert each tick for the outage's duration — bounded,
    // serialised by the advisory lock, and self-limiting the moment the table is
    // readable + writable again.
    return { pushedAt: {} };
  }
}

async function _writeDownPushState(pool, obj, nowIso) {
  await pool.query(
    "INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES ($1, $2, 'worker-watchdog', $3) " +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at',
    [PUSH_STATE_KEY, JSON.stringify(obj), nowIso]
  );
}

async function _clearDownPushState(pool) {
  await pool.query('DELETE FROM admin_settings WHERE key = $1', [PUSH_STATE_KEY]);
}

/**
 * One watchdog tick. Reads heartbeats, classifies with workerLiveness, and on a
 * STATE CHANGE fires layers 1/2/3. Never throws. Returns a summary for logs/tests.
 *
 * @param {import('pg').Pool} pool
 * @param {{now?:number, uptimeSec?:number}} [opts]
 *   - now: Date.now() reference (test seam; default Date.now())
 *   - uptimeSec: host process uptime in seconds (test seam; default
 *     process.uptime()). < a worker's budget ⇒ 'starting', not 'down'.
 */
async function runWorkerWatchdogSweep(pool, opts) {
  opts = opts || {};
  var now = typeof opts.now === 'number' ? opts.now : Date.now();
  var uptimeSec = typeof opts.uptimeSec === 'number' ? opts.uptimeSec : Math.floor(process.uptime());
  var nowIso = new Date(now).toISOString();

  try {
    var names = WORKER_SPECS.map(function (s) { return s.key; });

    // Reuse the EXACT read GET /api/v1/admin/health + the /ops widget use.
    var hb = await pool.query(
      'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats' +
      ' WHERE agent_name = ANY($1::text[]) GROUP BY agent_name',
      [names]
    );
    var byName = {};
    (hb.rows || []).forEach(function (row) { byName[row.agent_name] = row.last_run; });

    // Classify with the SHARED helper — do NOT reimplement.
    var liveness = WORKER_SPECS.map(function (spec) {
      return Object.assign(
        { staleSeconds: spec.staleSeconds },
        workerLiveness(spec.key, byName[spec.key] || null, now, spec.staleSeconds, uptimeSec)
      );
    });
    var down = liveness.filter(function (w) { return w.status === 'down'; });
    var downNames = down.map(function (w) { return w.name; });

    // Prior state = the DURABLE flag (survives restarts; prevents re-alarm/spam).
    var banner = await getWorkerHealthBanner(pool);
    var prevDown = new Set(banner.down);

    // ── Newly-down workers → LAYER 1 + LAYER 3 (state change only) ───────────
    var newlyDown = down.filter(function (w) { return !prevDown.has(w.name); });
    for (var i = 0; i < newlyDown.length; i++) {
      var w = newlyDown[i];
      var msg = _agePhrase(w.name, w.ageSec, w.staleSeconds);

      // LAYER 1 — load-bearing durable row. Cannot silently no-op.
      try {
        await _deps.logErrorToDb(new Error(msg), {
          category: 'worker_down',
          level: 'error',
          context: 'worker_watchdog',
          worker: w.name,
          ageSec: w.ageSec,
          staleSeconds: w.staleSeconds,
          status: 'down',
        });
      } catch (e1) {
        // Even layer 1's wrapper failing must not kill the sweep; logErrorToDb
        // is itself fire-and-forget, so this is belt-and-suspenders.
        try { _deps.logFatal('[worker-watchdog] layer-1 logErrorToDb failed', e1); } catch (_) {}
      }

      // LAYER 3 — best-effort, FULLY isolated. Its failure must never reach 1/2.
      try {
        await _deps.sendCriticalAlert('[worker-watchdog] ' + msg, 'worker_down');
      } catch (e3) {
        try { _deps.logFatal('[worker-watchdog] layer-3 sendCriticalAlert failed (non-fatal)', e3); } catch (_) {}
      }
    }

    // ── LAYER 2 — banner flag: auto-show / auto-clear ────────────────────────
    var recovered = false;
    if (downNames.length > 0) {
      var ages = {};
      down.forEach(function (x) { ages[x.name] = x.ageSec; });
      // Preserve the original incident start if the banner was already showing.
      var since = prevDown.size > 0 && banner.since ? banner.since : nowIso;
      await _writeBanner(pool, { down: downNames, since: since, ages: ages }, nowIso);
    } else if (prevDown.size > 0) {
      // down -> ok: ALL monitored workers healthy again. Clear + audit once.
      recovered = true;
      await _clearBanner(pool);
      try {
        await _deps.logErrorToDb(
          new Error('worker heartbeats recovered — all monitored workers healthy'),
          {
            category: 'worker_down',
            level: 'info',
            context: 'worker_watchdog',
            recovered: true,
            previouslyDown: Array.from(prevDown),
          }
        );
      } catch (_) { /* recovery audit is best-effort */ }
      try { _deps.logMajor('[worker-watchdog] recovered — all workers healthy (was: ' + Array.from(prevDown).join(', ') + ')'); } catch (_) {}
    }

    if (newlyDown.length > 0) {
      try { _deps.logFatal('[worker-watchdog] ' + newlyDown.map(function (x) { return _agePhrase(x.name, x.ageSec, x.staleSeconds); }).join('; ')); } catch (_) {}
    }

    // ── LAYER 4 — Command push to superadmins (watchdog-triggered) ────────────
    // A superadmin push per DOWN worker, rate-limited to AT MOST ONE per worker
    // per 30 min (PUSH_COOLDOWN_MS) while it stays down, plus ONE "recovered"
    // push when an alerting worker comes back alive. Cooldown timestamps live in
    // admin_settings (PUSH_STATE_KEY) — NOT in memory — so a process restart can
    // never re-fire a spam burst: the stamps survive and the cooldown still applies.
    //
    // CONCURRENCY: the watchdog runs UNGATED in every web instance (server.js)
    // via a non-awaited setInterval, so two sweeps (cross-instance OR self-
    // overlap) can race the read-check-write and BOTH push. We serialise the
    // CLAIM (read stamps → decide → write stamps) under a pg advisory lock so
    // exactly one sweep claims each worker's slot. The actual sends happen AFTER
    // the lock is released — the slot is already claimed, so no other sweep will
    // double-send, and we avoid holding a DB session across the exp.host HTTP call.
    // Fully isolated: a push (or its state write) failing can never affect layers
    // 1/2/3 or the sweep result.
    //
    // The watchdog runs INSIDE the process it monitors, so it covers worker-
    // THREAD death (a worker stops heartbeating while the host lives). Host /
    // whole-process death is covered externally by UptimeRobot hitting /healthz.
    var pushed = [];
    var pushRecovered = [];
    var toPushDown = [];       // workers claimed for a down push {name,ageSec,staleSeconds}
    var toPushRecovered = [];  // worker names claimed for a recovery push
    var pushClient = null;
    var pushClaimError = null;
    // AUDIT-2026-08-22 (AUDIT-WATCHDOG-RELEASE-1) — set when ROLLBACK itself
    // fails; passed to release() so the pool destroys the connection.
    var pushRollbackFailed = null;
    try {
      pushClient = await pool.connect();
      var gotPushLock = false;
      // AUDIT-2026-08-22 (AUDIT-WATCHDOG-LOCK-1) — was pg_try_advisory_lock +
      // pg_advisory_unlock on a `pool` client.
      //
      // `pool` is the Supabase TRANSACTION-mode pooler (DATABASE_URL, port 6543).
      // pool.connect() there hands back a logical client, NOT a pinned backend:
      // the lock was taken on backend A and the unlock statement was routed to
      // whichever backend was free — usually B, where it returned FALSE and was
      // discarded by the empty `catch (_)`. Backend A kept the lock, and the
      // pooler does not run server_reset_query in transaction mode, so it kept
      // it forever. From the first sweep onward pg_try_advisory_lock returned
      // false, gotPushLock was permanently false, and EVERY ops push — including
      // the worker-down alerts this whole file exists to send — was silently
      // skipped. The founder would have learned about a dead worker from a
      // patient.
      //
      // pg_try_advisory_xact_lock is released by the server at COMMIT/ROLLBACK,
      // so it cannot outlive the transaction and cannot be released on the wrong
      // backend. The pooler pins one backend for the duration of a transaction,
      // which is precisely the scope the claim needs.
      try {
        await pushClient.query('BEGIN');
        var lockRow = await pushClient.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [PUSH_LOCK_KEY]);
        gotPushLock = !!(lockRow && lockRow.rows && lockRow.rows[0] && lockRow.rows[0].locked);
        if (gotPushLock) {
          var pushState = await _getDownPushState(pushClient);
          var pushedAt = pushState.pushedAt || {};
          var pushChanged = false;

          // Down workers → claim on first-down, then again only once cooldown elapses.
          for (var pi = 0; pi < down.length; pi++) {
            var pw = down[pi];
            var lastMs = pushedAt[pw.name];
            var due = (typeof lastMs !== 'number') || (now - lastMs >= PUSH_COOLDOWN_MS);
            if (!due) continue;
            pushedAt[pw.name] = now;   // claim the slot BEFORE sending
            pushChanged = true;
            toPushDown.push(pw);
          }

          // Recovery → any worker with a live cooldown entry that is ALIVE again
          // is claimed for ONE recovery push, then its entry is cleared.
          var aliveSet = {};
          liveness.forEach(function (w) { if (w.status === 'alive') aliveSet[w.name] = true; });
          Object.keys(pushedAt).filter(function (name) { return aliveSet[name]; }).forEach(function (name) {
            delete pushedAt[name];
            pushChanged = true;
            toPushRecovered.push(name);
          });

          // Commit the claim under the lock; drop the key when nothing is pending.
          if (pushChanged) {
            if (Object.keys(pushedAt).length === 0) {
              await _clearDownPushState(pushClient);
            } else {
              await _writeDownPushState(pushClient, { pushedAt: pushedAt }, nowIso);
            }
          }
        }
        // !gotPushLock → another sweep owns the claim this tick; skip cleanly.
        // COMMIT both persists the claim writes and releases the xact lock.
        await pushClient.query('COMMIT');
      } catch (eTx) {
        // AUDIT-2026-08-22 (AUDIT-WATCHDOG-RELEASE-1) — capture a FAILING
        // rollback. node-pg does not reset a released connection, so a client
        // left inside an aborted transaction is handed straight to the next
        // borrower, who gets "current transaction is aborted, commands ignored
        // until end of transaction block" for a fault they did not cause.
        // Passing the rollback error to release() makes the pool DESTROY the
        // connection instead. src/pg.js withTransaction:383-386 already does
        // exactly this; the finally below now does the same.
        try { await pushClient.query('ROLLBACK'); }
        catch (rollbackErr) { pushRollbackFailed = rollbackErr; }
        throw eTx;
      }
    } catch (e4) {
      // AUDIT-2026-08-22 (AUDIT-WATCHDOG-LOCK-1) — this catch used to log
      // "(swallowed)" and move on, which is how a permanently-broken alerting
      // path stayed invisible. The sweep still must not throw (layers 1-3 have
      // already done real work and the caller is a bare setInterval), but the
      // failure is now (a) logged as a hard failure of the ALERTING PATH, not a
      // shrug, (b) written to error_logs, and (c) surfaced in the sweep result
      // as pushClaimError so /healthz and the admin health card can see that
      // ops pushes are not being delivered.
      pushClaimError = (e4 && e4.message) ? e4.message : String(e4);
      // The claim transaction rolled back, so the cooldown stamps were NOT
      // persisted. Anything staged in memory is an UNCLAIMED slot — sending it
      // would re-send on every subsequent tick with no throttle. Drop it.
      toPushDown = [];
      toPushRecovered = [];
      try {
        _deps.logFatal('[worker-watchdog] layer-4 push claim FAILED — ops pushes ' +
          '(including worker-down alerts) are NOT being delivered this tick', e4);
      } catch (_) {}
      try {
        await _deps.logErrorToDb(e4, {
          category: 'worker_watchdog',
          level: 'error',
          context: 'layer4_push_claim',
        });
      } catch (_) {}
    } finally {
      // AUDIT-2026-08-22 (AUDIT-WATCHDOG-RELEASE-1) — release(err) destroys the
      // connection rather than returning a poisoned one to the pool.
      if (pushClient && pushClient.release) {
        try { pushClient.release(pushRollbackFailed || undefined); }
        catch (_) { try { pushClient.release(); } catch (_e) {} }
      }
    }

    // Send AFTER releasing the lock. Each slot is already claimed (stamp written),
    // so no other sweep/instance double-sends; a send failure cannot un-claim it,
    // so a failing sink never becomes a per-tick retry storm.
    for (var sdi = 0; sdi < toPushDown.length; sdi++) {
      var sdw = toPushDown[sdi];
      try {
        await _deps.notifySuperadmins(pool, {
          title: 'Worker down: ' + sdw.name,
          body: _agePhrase(sdw.name, sdw.ageSec, sdw.staleSeconds),
          data: { type: 'worker_down', worker: sdw.name, ageSec: sdw.ageSec == null ? null : sdw.ageSec },
        });
      } catch (ep) {
        try { _deps.logFatal('[worker-watchdog] layer-4 down push failed (non-fatal)', ep); } catch (_) {}
      }
      pushed.push(sdw.name);
    }
    for (var sri = 0; sri < toPushRecovered.length; sri++) {
      var srn = toPushRecovered[sri];
      try {
        await _deps.notifySuperadmins(pool, {
          title: 'Worker recovered: ' + srn,
          body: srn + ' is heartbeating again.',
          data: { type: 'worker_recovered', worker: srn },
        });
      } catch (er) {
        try { _deps.logFatal('[worker-watchdog] layer-4 recovery push failed (non-fatal)', er); } catch (_) {}
      }
      pushRecovered.push(srn);
    }

    return {
      ok: true,
      down: downNames,
      newlyDown: newlyDown.map(function (w) { return w.name; }),
      recovered: recovered,
      pushed: pushed,
      pushRecovered: pushRecovered,
      liveness: liveness.map(function (w) { return { name: w.name, status: w.status, ageSec: w.ageSec }; }),
      // AUDIT-2026-08-22 (AUDIT-WATCHDOG-LOCK-1) — null on the happy path; a
      // string means the push CLAIM failed and no ops push was sent this tick.
      pushClaimError: pushClaimError,
    };
  } catch (err) {
    // Self-isolating: a watchdog failure logs and is swallowed — never throws
    // into the boot loop or the interval.
    try {
      await _deps.logErrorToDb(err, {
        category: 'worker_watchdog',
        level: 'error',
        context: 'runWorkerWatchdogSweep',
      });
    } catch (_) { /* nothing more we can do */ }
    try { _deps.logFatal('[worker-watchdog] sweep failed (swallowed)', err); } catch (_) {}
    return { ok: false, error: true };
  }
}

module.exports = {
  runWorkerWatchdogSweep: runWorkerWatchdogSweep,
  getWorkerHealthBanner: getWorkerHealthBanner,
  FLAG_KEY: FLAG_KEY,
  _setDepsForTests: _setDepsForTests,
  _resetDepsForTests: _resetDepsForTests,
};
