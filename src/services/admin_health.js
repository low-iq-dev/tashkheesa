'use strict';

// Tashkheesa Command — health/liveness helpers for GET /api/v1/admin/health.
//
// READ-ONLY. The worker heartbeat mechanism already exists (agent_heartbeats,
// migration 049); these helpers only shape its rows into the Pulse status
// strip. See docs/COMMAND_APP_PHASE0_AUDIT.md §4 and the ops dashboard's
// "Widget 3" reader (src/routes/ops.js) which uses the same MAX(pinged_at)
// per agent_name query.
//
// Pure functions so the route logic is unit-testable without a server or DB.

// The two cron workers the Pulse strip pills watch, each with a staleness
// budget of roughly 2-3x its own ping interval (case_sla_worker pings every
// 5 min, acceptance_watcher every 2 min). A worker that hasn't pinged within
// its budget is reported "not alive".
const WORKER_SPECS = [
  { key: 'case_sla_worker', staleSeconds: 12 * 60 },   // sla-sweep
  { key: 'acceptance_watcher', staleSeconds: 6 * 60 },
];

/**
 * Classify a worker from its last heartbeat as one of:
 *   'alive'    — pinged within its staleness budget (green)
 *   'starting' — stale/missing, BUT the host instance has only just (re)started,
 *                so the in-process worker hasn't had a chance to ping yet (grey).
 *                This is the Render free-tier case: the instance sleeps on idle
 *                and wakes on the incoming request, so a stale heartbeat right
 *                after wake is "warming up", not "dead". Must NOT fire a RED alarm.
 *   'down'     — stale/missing AND the instance has been up longer than the
 *                worker's staleness budget, so it really should have pinged (red).
 *
 * `alive` (boolean) stays true only for the 'alive' status, for simple consumers.
 *
 * @param {string} name
 * @param {Date|string|null} lastPingedAt - last agent_heartbeats.pinged_at, or null
 * @param {number} now - Date.now() reference
 * @param {number} staleSeconds - max heartbeat age before considered stale
 * @param {number} [uptimeSec=Infinity] - host process uptime; < staleSeconds ⇒ 'starting'
 */
function workerLiveness(name, lastPingedAt, now, staleSeconds, uptimeSec) {
  const up = typeof uptimeSec === 'number' ? uptimeSec : Infinity;
  // Stale/missing on a freshly-woken instance is warm-up, not death.
  const staleStatus = up < staleSeconds ? 'starting' : 'down';

  if (!lastPingedAt) {
    return { name, alive: false, status: staleStatus, lastRunAt: null, ageSec: null };
  }

  const last = lastPingedAt instanceof Date ? lastPingedAt : new Date(lastPingedAt);
  const ageSec = Math.floor((now - last.getTime()) / 1000);
  const fresh = ageSec >= 0 && ageSec <= staleSeconds;

  return {
    name,
    alive: fresh,
    status: fresh ? 'alive' : staleStatus,
    lastRunAt: last.toISOString(),
    ageSec,
  };
}

/**
 * Assemble the /admin/health payload from already-fetched inputs.
 * @param {object} args
 * @param {number} args.uptimeSec
 * @param {{totalCount:number,idleCount:number,waitingCount:number}|null} args.pool
 * @param {Array<{agent_name:string,last_run:Date|string}>} args.heartbeatRows
 * @param {{gitSha?:string,startedAtIso?:string,version?:string,mode?:string}} args.deploy
 * @param {number} args.now
 */
function buildHealthPayload({ uptimeSec, pool, heartbeatRows, deploy, now }) {
  const byName = {};
  for (const row of (heartbeatRows || [])) {
    byName[row.agent_name] = row.last_run;
  }

  const workers = {};
  for (const spec of WORKER_SPECS) {
    workers[spec.key] = workerLiveness(spec.key, byName[spec.key] || null, now, spec.staleSeconds, uptimeSec);
  }

  return {
    ok: true,
    timestamp: now,
    api: { reachable: true, uptimeSec },
    db: {
      connected: true,
      pool: pool
        ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
        : null,
    },
    workers,
    deploy: {
      sha: (deploy && deploy.gitSha) || null,
      startedAt: (deploy && deploy.startedAtIso) || null,
      version: (deploy && deploy.version) || null,
      mode: (deploy && deploy.mode) || null,
    },
  };
}

module.exports = { WORKER_SPECS, workerLiveness, buildHealthPayload };
