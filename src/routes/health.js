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
  // 2026-10-11 — { ready, draining }, owned by src/server.js. `ready` flips
  // when the port is bound (which is after migrations); `draining` on SIGTERM.
  // Absent (older callers, tests) means "ready, not draining".
  var lifecycle = opts.lifecycle || { ready: true, draining: false };
  var HEALTH_DB_TIMEOUT_MS = Number(opts.healthDbTimeoutMs) > 0 ? Number(opts.healthDbTimeoutMs) : 1500;

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
  // /healthz?strict=1 turns that into a 503 (see below).
  //
  // 2026-10-11 — THE HEALTH CHECK MUST NOT WAIT ON THE DATABASE.
  //
  // This handler awaited two pool queries. pool.query() queues for a free
  // connection for up to connectionTimeoutMillis (15s); Render's health check
  // gives up after 5s. So whenever the pool was saturated — and it is during
  // every deploy, when the old and the new instance are both alive for at
  // least 60 seconds against a 15-connection ceiling budgeted for ONE — the
  // health check timed out on a web process that was perfectly alive, and
  // Render stopped routing to it. The try/catch below never helped: a queued
  // query is not an error until the 15 seconds are up.
  //
  // The two reads are now raced against HEALTH_DB_TIMEOUT_MS (1.5s) and run
  // single-flight: while one pair is still waiting for a connection, later
  // health checks reuse it instead of queueing more work behind a full pool.
  // A read that does not come back in time is reported exactly as a failed
  // read always was (workers 'starting'/'down', clock unknown), plus
  // `dbTimedOut: true`. The plain URL still answers 200 — it is a check that
  // the WEB PROCESS is alive.
  var { WORKER_SPECS, workerLiveness } = require('../services/admin_health');
  var healthReadInFlight = null;
  function readHealthFromDb(names) {
    if (healthReadInFlight) return healthReadInFlight;
    var settled = Promise.all([
      pool.query(
        'SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats WHERE agent_name = ANY($1::text[]) GROUP BY agent_name',
        [names]
      ).then(function(r) { return r; }, function() { return null; }),
      pool.query('SHOW TimeZone').then(function(r) { return r; }, function() { return null; })
    ]).then(function(pair) { return { heartbeats: pair[0], tz: pair[1], timedOut: false }; });
    healthReadInFlight = settled;
    var clear = function() { if (healthReadInFlight === settled) healthReadInFlight = null; };
    settled.then(clear, clear);
    return settled;
  }
  function readHealthBounded(names) {
    return new Promise(function(resolve) {
      var timer = setTimeout(function() {
        resolve({ heartbeats: null, tz: null, timedOut: true });
      }, HEALTH_DB_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      readHealthFromDb(names).then(function(out) { clearTimeout(timer); resolve(out); });
    });
  }

  router.get('/healthz', async function(req, res) {
    var uptimeSec = Math.floor(process.uptime());

    // Not ready (still booting) or draining (SIGTERM received): 503, at once,
    // without touching the database. Render only routes to an instance whose
    // health check passes, so this is what keeps traffic off a process that
    // is not serving yet or is on its way out.
    if (!lifecycle.ready || lifecycle.draining) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({
        ok: false,
        ready: !!lifecycle.ready,
        draining: !!lifecycle.draining,
        mode: MODE,
        timestamp: Date.now(),
        uptimeSec: uptimeSec,
        requestId: req.requestId
      });
    }

    var names = WORKER_SPECS.map(function(s) { return s.key; });
    var byName = {};
    var dbRead = await readHealthBounded(names);
    try {
      var r = dbRead.heartbeats;
      ((r && r.rows) || []).forEach(function(row) { byName[row.agent_name] = row.last_run; });
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
      // 'SHOW TimeZone' is read in readHealthFromDb() above, beside the heartbeats.
      var tzr = dbRead.tz;
      clock.db = (tzr && tzr.rows && tzr.rows[0]) ? (tzr.rows[0].TimeZone || tzr.rows[0].timezone) : null;
    } catch (_) { /* DB hiccup: clock reads unknown; /healthz still 200 */ }
    try {
      clock.node = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || null;
    } catch (_) { clock.node = process.env.TZ || null; }
    clock.ok = String(clock.db || '').toUpperCase() === 'UTC' &&
               String(clock.node || '').toUpperCase() === 'UTC';

    var workersOk = workers.every(function(w) { return w.status !== 'down'; });

    // 6 Oct 2026 (watchtower) — /healthz?strict=1 for an external monitor that
    // can only alarm on a status code. Same body; 503 when a worker is down or
    // the clock contract is broken. The plain URL stays 200 on purpose: it is
    // Render's own health check, and a 503 there would restart the web service
    // over a stalled background worker, which fixes nothing and drops requests.
    var strict = String((req.query && req.query.strict) || '') === '1';
    if (strict && !(workersOk && clock.ok)) res.status(503);

    return res.json({
      ok: true,
      ready: true,
      draining: false,
      dbTimedOut: !!dbRead.timedOut,
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
      workersOk: workersOk,
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
