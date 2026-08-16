// src/routes/health.js
// Health, status, and version endpoints.

var express = require('express');
var router = express.Router();

function setupHealthRoutes(opts) {
  var MODE = opts.MODE;
  var CONFIG = opts.CONFIG;
  var pool = opts.pool;
  var pkg = opts.pkg;
  var GIT_SHA = opts.GIT_SHA;
  var SERVER_STARTED_AT = opts.SERVER_STARTED_AT;
  var SERVER_STARTED_AT_ISO = opts.SERVER_STARTED_AT_ISO;

  router.get('/health', function(req, res) {
    return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
  });

  router.get('/status', function(req, res) {
    return res.json({ ok: true, mode: MODE, timestamp: Date.now() });
  });

  // F5 (launch audit): expose per-worker heartbeat freshness so an EXTERNAL
  // uptime monitor pinging /healthz can alarm on a dead worker, not just a dead
  // web process. Single indexed query (MAX(pinged_at) per worker, served by
  // idx_agent_heartbeats_agent_name), reusing the shared WORKER_SPECS/
  // workerLiveness so it stays in lockstep with the watchdog. Only non-sensitive
  // fields are exposed (name/status/ageSec/staleSeconds) — never
  // current_task/meta/token_cost. /healthz stays 200 even if a worker is down;
  // staleness surfaces in the body (workersOk + per-worker status).
  var { WORKER_SPECS, workerLiveness } = require('../services/admin_health');
  router.get('/healthz', async function(req, res) {
    var uptimeSec = Math.floor(process.uptime());
    var names = WORKER_SPECS.map(function(s) { return s.key; });
    var byName = {};
    try {
      var r = await pool.query(
        'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats WHERE agent_name = ANY($1::text[]) GROUP BY agent_name',
        [names]
      );
      (r.rows || []).forEach(function(row) { byName[row.agent_name] = row.last_run; });
    } catch (_) { /* DB hiccup: workers read as down/starting; /healthz still 200 */ }
    var now = Date.now();
    var workers = WORKER_SPECS.map(function(spec) {
      var w = workerLiveness(spec.key, byName[spec.key] || null, now, spec.staleSeconds, uptimeSec);
      return { name: w.name, status: w.status, ageSec: w.ageSec, staleSeconds: spec.staleSeconds };
    });

    // AUDIT-TZ-1 — the clock contract, exposed so it can be MONITORED rather
    // than confirmed by eyeballing a boot log once and hoping.
    //
    // Every SLA deadline is written as a JS .toISOString() into a `timestamp
    // WITHOUT time zone` column, and the sweeps compare with NOW()::timestamp.
    // Those only agree when BOTH the database session and the Node process are
    // UTC. They were not: the session inherited Africa/Cairo, so every deadline
    // read 2-3h further past than it was and cases breached early.
    //
    // src/pg.js pins the session per connection and src/server.js forces the
    // process, but a pinning failure is silent — the SET is fire-and-forget on
    // a pooled client. Reporting it here turns that into something an uptime
    // check can alarm on. clockOk false means SLA timing is wrong on this
    // instance and every deadline it computes is suspect.
    var clock = { db: null, node: null, ok: false };
    try {
      var tzr = await pool.query('SHOW TimeZone');
      clock.db = (tzr.rows && tzr.rows[0]) ? (tzr.rows[0].TimeZone || tzr.rows[0].timezone) : null;
    } catch (_) { /* DB hiccup: clock reads unknown; /healthz still 200 */ }
    try {
      clock.node = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || null;
    } catch (_) { clock.node = process.env.TZ || null; }
    clock.ok = String(clock.db || '').toUpperCase() === 'UTC' &&
               String(clock.node || '').toUpperCase() === 'UTC';

    return res.json({
      ok: true,
      mode: MODE,
      timestamp: Date.now(),
      uptimeSec: uptimeSec,
      requestId: req.requestId,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      },
      workers: workers,
      workersOk: workers.every(function(w) { return w.status !== 'down'; }),
      clock: clock,
      clockOk: clock.ok
    });
  });

  router.get('/__version', function(req, res) {
    return res.json({
      ok: true,
      name: pkg.name,
      version: pkg.version,
      mode: MODE,
      slaMode: CONFIG.SLA_MODE,
      startedAt: SERVER_STARTED_AT,
      startedAtIso: SERVER_STARTED_AT_ISO,
      uptimeSec: Math.floor(process.uptime()),
      gitSha: GIT_SHA,
      requestId: req.requestId
    });
  });

  return router;
}

module.exports = { setupHealthRoutes: setupHealthRoutes };
