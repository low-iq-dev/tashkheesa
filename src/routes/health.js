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

  router.get('/healthz', function(req, res) {
    return res.json({
      ok: true,
      mode: MODE,
      timestamp: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      requestId: req.requestId,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
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
