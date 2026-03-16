/**
 * Ops Dashboard — internal operations overview (password-protected).
 */

var express = require('express');
var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var os = require('os');
var { queryOne, queryAll, execute } = require('../pg');
var { major: logMajor } = require('../logger');

var router = express.Router();
var OPS_BOOT_AT = Date.now();

// ── Helpers ─────────────────────────────────────────────

async function safeGet(sql, params, fallback) {
  try {
    return await queryOne(sql, Array.isArray(params) ? params : []);
  } catch (e) {
    logMajor('ops safeGet: ' + e.message);
    return fallback !== undefined ? fallback : null;
  }
}

async function safeAll(sql, params) {
  try {
    return await queryAll(sql, Array.isArray(params) ? params : []);
  } catch (e) {
    logMajor('ops safeAll: ' + e.message);
    return [];
  }
}

function timeSafeEqual(a, b) {
  var bufA = Buffer.from(String(a));
  var bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function timeAgo(date) {
  if (!date) return 'never';
  var now = Date.now();
  var then = new Date(date).getTime();
  var diffMs = now - then;
  if (diffMs < 0) return 'just now';
  var seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return seconds + 's ago';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'min ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function formatUptime(ms) {
  var totalSec = Math.floor(ms / 1000);
  var days = Math.floor(totalSec / 86400);
  var hours = Math.floor((totalSec % 86400) / 3600);
  var mins = Math.floor((totalSec % 3600) / 60);
  var parts = [];
  if (days > 0) parts.push(days + 'd');
  if (hours > 0) parts.push(hours + 'h');
  parts.push(mins + 'm');
  return parts.join(' ');
}

// ── Auth middleware ─────────────────────────────────────

var JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
var LOGIN_ATTEMPTS = {};
var MAX_LOGIN_ATTEMPTS = 5;
var LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function requireOpsAuth(req, res, next) {
  var token = req.cookies && req.cookies.ops_auth;
  if (!token) return res.redirect('/ops/login');
  try {
    var decoded = jwt.verify(token, JWT_SECRET);
    if (decoded && decoded.ops === true) return next();
    return res.redirect('/ops/login');
  } catch (e) {
    return res.redirect('/ops/login');
  }
}

function checkLoginRateLimit(ip) {
  var record = LOGIN_ATTEMPTS[ip];
  if (!record) return { blocked: false };
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    var remainSec = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return { blocked: true, remainSec: remainSec };
  }
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    delete LOGIN_ATTEMPTS[ip];
    return { blocked: false };
  }
  return { blocked: false };
}

function recordLoginFailure(ip) {
  if (!LOGIN_ATTEMPTS[ip]) LOGIN_ATTEMPTS[ip] = { count: 0, lockedUntil: null };
  LOGIN_ATTEMPTS[ip].count++;
  if (LOGIN_ATTEMPTS[ip].count >= MAX_LOGIN_ATTEMPTS) {
    LOGIN_ATTEMPTS[ip].lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
}

function clearLoginFailures(ip) {
  delete LOGIN_ATTEMPTS[ip];
}

// ── Login routes ────────────────────────────────────────

router.get('/login', function (req, res) {
  res.render('ops-login', { error: null });
});

router.post('/login', function (req, res) {
  var ip = req.ip || req.connection.remoteAddress || 'unknown';
  var rateCheck = checkLoginRateLimit(ip);
  if (rateCheck.blocked) {
    return res.render('ops-login', {
      error: 'Too many attempts. Try again in ' + rateCheck.remainSec + 's.'
    });
  }

  var username = String(req.body.username || '');
  var password = String(req.body.password || '');
  var expectedUser = process.env.OPS_USER || '';
  var expectedPass = process.env.OPS_PASS || '';

  if (!expectedUser || !expectedPass) {
    return res.render('ops-login', { error: 'Ops login not configured.' });
  }

  var userOk = timeSafeEqual(username, expectedUser);
  var passOk = timeSafeEqual(password, expectedPass);

  if (userOk && passOk) {
    clearLoginFailures(ip);
    var token = jwt.sign({ ops: true }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('ops_auth', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000
    });
    return res.redirect('/ops');
  }

  recordLoginFailure(ip);
  return res.render('ops-login', { error: 'Invalid credentials.' });
});

router.get('/logout', function (req, res) {
  res.clearCookie('ops_auth');
  res.redirect('/ops/login');
});

// ── Main dashboard ──────────────────────────────────────

router.get('/', requireOpsAuth, async function (req, res) {
  // ── Platform stats ──
  var totalCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders", [], { c: 0 }
  )) || {}).c || 0;

  var casesThisMonth = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE created_at >= date_trunc('month', NOW())",
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueThisMonth = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= date_trunc('month', NOW())",
    [], { t: 0 }
  )) || {}).t || 0;

  var pendingCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status IN ('new','pending','awaiting_review')",
    [], { c: 0 }
  )) || {}).c || 0;

  var breachedCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status = 'breached'",
    [], { c: 0 }
  )) || {}).c || 0;

  var activeDoctors = ((await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND is_active = true",
    [], { c: 0 }
  )) || {}).c || 0;

  var totalPatients = ((await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'patient'",
    [], { c: 0 }
  )) || {}).c || 0;

  // ── SLA health ──
  var nearBreachCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status NOT IN ('completed','breached','cancelled') AND deadline_at IS NOT NULL AND deadline_at <= NOW() + INTERVAL '2 hours' AND deadline_at > NOW()",
    [], { c: 0 }
  )) || {}).c || 0;

  var avgCompletionHrs = ((await safeGet(
    "SELECT ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)::numeric, 1) as h FROM orders WHERE completed_at IS NOT NULL AND created_at >= date_trunc('month', NOW())",
    [], { h: null }
  )) || {}).h || null;

  // ── Error log stats (last 24h) ──
  var errors24h = ((await safeGet(
    "SELECT COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '24 hours'",
    [], { c: 0 }
  )) || {}).c || 0;

  var errorsByLevel = await safeAll(
    "SELECT level, COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY level ORDER BY c DESC",
    []
  );

  // ── Notification stats ──
  var notifStats = await safeAll(
    "SELECT status, COUNT(*) as c FROM notifications WHERE at >= date_trunc('month', NOW()) GROUP BY status",
    []
  );

  // ── Payment health ──
  var unpaidOrders = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE payment_status = 'unpaid' AND status NOT IN ('cancelled')",
    [], { c: 0 }
  )) || {}).c || 0;

  var failedPayments = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE payment_status = 'failed'",
    [], { c: 0 }
  )) || {}).c || 0;

  // ── Agent stats ──
  var agentHeartbeats = await safeAll(
    "SELECT DISTINCT ON (agent_name) agent_name, status, current_task, pinged_at FROM agent_heartbeats ORDER BY agent_name, pinged_at DESC",
    []
  );

  var agentTokens = await safeAll(
    "SELECT agent_name, COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(tokens_used), 0) as total_tokens FROM agent_token_log WHERE logged_at >= date_trunc('month', NOW()) GROUP BY agent_name",
    []
  );

  var tokenCostMap = {};
  var tokenCountMap = {};
  var totalTokenSpend = 0;
  for (var i = 0; i < agentTokens.length; i++) {
    var cost = Number(agentTokens[i].total_cost) || 0;
    tokenCostMap[agentTokens[i].agent_name] = cost;
    tokenCountMap[agentTokens[i].agent_name] = Number(agentTokens[i].total_tokens) || 0;
    totalTokenSpend += cost;
  }

  var agents = agentHeartbeats.map(function (a) {
    return {
      agent_name: a.agent_name,
      status: a.status,
      current_task: a.current_task || '\u2014',
      pinged_at: a.pinged_at,
      last_seen: timeAgo(a.pinged_at),
      token_cost_mtd: tokenCostMap[a.agent_name] || 0,
      tokens_used_mtd: tokenCountMap[a.agent_name] || 0
    };
  });

  // ── Instagram pipeline ──
  var igStats = await safeAll(
    "SELECT status, COUNT(*) as c FROM ig_scheduled_posts GROUP BY status",
    []
  );

  // ── System health ──
  var uptimeMs = Date.now() - OPS_BOOT_AT;
  var slaMode = process.env.SLA_MODE || 'passive';
  var nodeVersion = process.version;
  var memUsage = process.memoryUsage();
  var heapUsedMb = Math.round(memUsage.heapUsed / 1048576);
  var heapTotalMb = Math.round(memUsage.heapTotal / 1048576);
  var rssMb = Math.round(memUsage.rss / 1048576);
  var gitSha = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || null;
  try {
    if (!gitSha) {
      gitSha = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }
  } catch (e) { /* ignore */ }

  // ── DB connection pool ──
  var dbPoolTotal = 0;
  var dbPoolIdle = 0;
  var dbPoolWaiting = 0;
  try {
    var pg = require('../pg');
    if (pg.pool) {
      dbPoolTotal = pg.pool.totalCount || 0;
      dbPoolIdle = pg.pool.idleCount || 0;
      dbPoolWaiting = pg.pool.waitingCount || 0;
    }
  } catch (e) { /* ignore */ }

  var cairoTime = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo' });

  res.render('ops-dashboard', {
    totalCases: Number(totalCases),
    casesThisMonth: Number(casesThisMonth),
    revenueThisMonth: Number(revenueThisMonth),
    pendingCases: Number(pendingCases),
    breachedCases: Number(breachedCases),
    activeDoctors: Number(activeDoctors),
    totalPatients: Number(totalPatients),
    nearBreachCases: Number(nearBreachCases),
    avgCompletionHrs: avgCompletionHrs,
    errors24h: Number(errors24h),
    errorsByLevel: errorsByLevel,
    notifStats: notifStats,
    unpaidOrders: Number(unpaidOrders),
    failedPayments: Number(failedPayments),
    agents: agents,
    totalTokenSpend: totalTokenSpend,
    igStats: igStats,
    cairoTime: cairoTime,
    uptime: formatUptime(uptimeMs),
    slaMode: slaMode,
    nodeVersion: nodeVersion,
    heapUsedMb: heapUsedMb,
    heapTotalMb: heapTotalMb,
    rssMb: rssMb,
    gitSha: gitSha,
    dbPoolTotal: dbPoolTotal,
    dbPoolIdle: dbPoolIdle,
    dbPoolWaiting: dbPoolWaiting,
    mode: process.env.MODE || process.env.NODE_ENV || 'development'
  });
});

// ── Agent API endpoints (no auth — called from server-side agents) ──

var MAX_FIELD_LEN = 200;

router.post('/agent/ping', async function (req, res) {
  try {
    var body = req.body || {};
    var agentName = String(body.agent_name || '').trim().slice(0, MAX_FIELD_LEN);
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

    var id = 'hb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var status = String(body.status || 'idle').slice(0, MAX_FIELD_LEN);
    var currentTask = body.current_task ? String(body.current_task).slice(0, 500) : null;
    var tokenCost = Math.max(0, Number(body.token_cost_usd) || 0);
    var meta = body.meta ? String(body.meta).slice(0, 2000) : null;

    await execute(
      'INSERT INTO agent_heartbeats (id, agent_name, status, current_task, token_cost_usd, meta, pinged_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [id, agentName, status, currentTask, tokenCost, meta]
    );

    return res.json({ ok: true });
  } catch (e) {
    logMajor('ops agent/ping error: ' + e.message);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

router.post('/agent/log-tokens', async function (req, res) {
  try {
    var body = req.body || {};
    var agentName = String(body.agent_name || '').trim().slice(0, MAX_FIELD_LEN);
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

    var id = 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var tokensUsed = Math.max(0, Math.floor(Number(body.tokens_used) || 0));
    var costUsd = Math.max(0, Number(body.cost_usd) || 0);
    var taskLabel = body.task_label ? String(body.task_label).slice(0, 500) : null;

    await execute(
      'INSERT INTO agent_token_log (id, agent_name, tokens_used, cost_usd, task_label, logged_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [id, agentName, tokensUsed, costUsd, taskLabel]
    );

    return res.json({ ok: true });
  } catch (e) {
    logMajor('ops agent/log-tokens error: ' + e.message);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ── Heartbeat cleanup (prune rows older than 30 days) ──

router.post('/agent/cleanup', requireOpsAuth, async function (req, res) {
  try {
    var result = await execute(
      "DELETE FROM agent_heartbeats WHERE pinged_at < NOW() - INTERVAL '30 days'"
    );
    return res.json({ ok: true, deleted: result.rowCount || 0 });
  } catch (e) {
    logMajor('ops agent/cleanup error: ' + e.message);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
