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

var FLAG_KEY = 'worker_health_banner';

// Injectable deps (test seam — mirrors ai_health.js / admin_settings.js).
var _deps = {
  logErrorToDb: logErrorToDb,
  sendCriticalAlert: sendCriticalAlert,
  logFatal: logFatal,
  logMajor: logMajor,
};
function _setDepsForTests(d) { if (d) Object.assign(_deps, d); }
function _resetDepsForTests() {
  _deps = {
    logErrorToDb: logErrorToDb,
    sendCriticalAlert: sendCriticalAlert,
    logFatal: logFatal,
    logMajor: logMajor,
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

    return {
      ok: true,
      down: downNames,
      newlyDown: newlyDown.map(function (w) { return w.name; }),
      recovered: recovered,
      liveness: liveness.map(function (w) { return { name: w.name, status: w.status, ageSec: w.ageSec }; }),
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
