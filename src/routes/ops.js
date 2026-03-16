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

// ── Configured agents (always show even if never pinged) ──

var CONFIGURED_AGENTS = [
  'ops-agent',
  'growth-agent',
  'care-agent',
  'finance-agent'
];

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
  // Cairo midnight for "today" queries
  var CAIRO_TODAY = "date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'";

  // ── Platform stats (orders + cases combined) ──
  var totalCases = ((await safeGet(
    "SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM cases) as c",
    [], { c: 0 }
  )) || {}).c || 0;

  var casesThisMonth = ((await safeGet(
    "SELECT (SELECT COUNT(*) FROM orders WHERE created_at >= date_trunc('month', NOW())) + (SELECT COUNT(*) FROM cases WHERE created_at >= date_trunc('month', NOW())) AS c",
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueThisMonth = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= date_trunc('month', NOW())",
    [], { t: 0 }
  )) || {}).t || 0;

  var pendingOrders = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status IN ('new','pending','awaiting_review','review')",
    [], { c: 0 }
  )) || {}).c || 0;
  var pendingNewCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM cases WHERE status IN ('new','pending','paid')",
    [], { c: 0 }
  )) || {}).c || 0;
  var pendingCases = Number(pendingOrders) + Number(pendingNewCases);

  var breachedOrders = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status = 'breached'",
    [], { c: 0 }
  )) || {}).c || 0;
  var breachedNewCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM cases WHERE status = 'breached'",
    [], { c: 0 }
  )) || {}).c || 0;
  var breachedCases = Number(breachedOrders) + Number(breachedNewCases);

  var completedOrders = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE status IN ('completed','done','delivered') AND created_at >= date_trunc('month', NOW())",
    [], { c: 0 }
  )) || {}).c || 0;
  var completedNewCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM cases WHERE status = 'completed' AND created_at >= date_trunc('month', NOW())",
    [], { c: 0 }
  )) || {}).c || 0;
  var completedThisMonth = Number(completedOrders) + Number(completedNewCases);

  var revenueAllTime = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured')",
    [], { t: 0 }
  )) || {}).t || 0;

  var activeDoctors = ((await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor' AND is_active = true",
    [], { c: 0 }
  )) || {}).c || 0;

  var totalDoctors = ((await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'doctor'",
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

  // ── Today's snapshot ──
  var casesToday = ((await safeGet(
    "SELECT (SELECT COUNT(*) FROM orders WHERE created_at >= " + CAIRO_TODAY + ") + (SELECT COUNT(*) FROM cases WHERE created_at >= " + CAIRO_TODAY + ") AS c",
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueToday = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= " + CAIRO_TODAY,
    [], { t: 0 }
  )) || {}).t || 0;

  var newPatientsToday = ((await safeGet(
    "SELECT COUNT(*) as c FROM users WHERE role = 'patient' AND created_at >= " + CAIRO_TODAY,
    [], { c: 0 }
  )) || {}).c || 0;

  var errorsToday = ((await safeGet(
    "SELECT COUNT(*) as c FROM error_logs WHERE created_at >= " + CAIRO_TODAY,
    [], { c: 0 }
  )) || {}).c || 0;

  // ── Error log stats (last 24h) ──
  var errors24h = ((await safeGet(
    "SELECT COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '24 hours'",
    [], { c: 0 }
  )) || {}).c || 0;

  var errorsByLevel = await safeAll(
    "SELECT level, COUNT(*) as c FROM error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY level ORDER BY c DESC",
    []
  );

  // ── Recent errors (last 10 for the dashboard feed) ──
  var recentErrors = await safeAll(
    "SELECT id, level, message, url, method, created_at FROM error_logs ORDER BY created_at DESC LIMIT 10",
    []
  );
  for (var ei = 0; ei < recentErrors.length; ei++) {
    recentErrors[ei].time_ago = timeAgo(recentErrors[ei].created_at);
  }

  // ── Notification stats ──
  var notifStats = await safeAll(
    "SELECT status, COUNT(*) as c FROM notifications WHERE at >= date_trunc('month', NOW()) GROUP BY status",
    []
  );

  // ── Payment health ──
  var unpaidOrders = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE payment_status = 'unpaid' AND status NOT IN ('cancelled','expired_unpaid')",
    [], { c: 0 }
  )) || {}).c || 0;

  var failedPayments = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders WHERE payment_status = 'failed'",
    [], { c: 0 }
  )) || {}).c || 0;

  // ── Recent activity (last 10 orders) ──
  var recentOrders = await safeAll(
    "SELECT o.id, o.status, o.price, o.payment_status, o.created_at, COALESCE(sv.name, 'Unknown') as service_name, COALESCE(u.name, 'Patient') as patient_name, COALESCE(sp.name, '') as specialty_name FROM orders o LEFT JOIN services sv ON sv.id = o.service_id LEFT JOIN users u ON u.id = o.patient_id LEFT JOIN specialties sp ON sp.id = o.specialty_id ORDER BY o.created_at DESC LIMIT 10",
    []
  );
  for (var ri = 0; ri < recentOrders.length; ri++) {
    recentOrders[ri].time_ago = timeAgo(recentOrders[ri].created_at);
  }

  // ── Agent config (enabled/paused from DB) ──
  var agentConfigRows = await safeAll(
    "SELECT agent_name, is_enabled FROM agent_config",
    []
  );
  var agentEnabledMap = {};
  for (var aci = 0; aci < agentConfigRows.length; aci++) {
    agentEnabledMap[agentConfigRows[aci].agent_name] = agentConfigRows[aci].is_enabled !== false;
  }

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

  var heartbeatMap = {};
  for (var hi = 0; hi < agentHeartbeats.length; hi++) {
    heartbeatMap[agentHeartbeats[hi].agent_name] = agentHeartbeats[hi];
  }

  var allAgentNames = CONFIGURED_AGENTS.slice();
  for (var ai = 0; ai < agentHeartbeats.length; ai++) {
    if (allAgentNames.indexOf(agentHeartbeats[ai].agent_name) === -1) {
      allAgentNames.push(agentHeartbeats[ai].agent_name);
    }
  }

  var agents = allAgentNames.map(function (name) {
    var hb = heartbeatMap[name];
    return {
      agent_name: name,
      status: hb ? hb.status : 'never',
      current_task: hb ? (hb.current_task || '\u2014') : '\u2014',
      pinged_at: hb ? hb.pinged_at : null,
      last_seen: hb ? timeAgo(hb.pinged_at) : 'never',
      token_cost_mtd: tokenCostMap[name] || 0,
      tokens_used_mtd: tokenCountMap[name] || 0,
      enabled: agentEnabledMap.hasOwnProperty(name) ? agentEnabledMap[name] : true
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
    completedThisMonth: Number(completedThisMonth),
    revenueAllTime: Number(revenueAllTime),
    activeDoctors: Number(activeDoctors),
    totalDoctors: Number(totalDoctors),
    totalPatients: Number(totalPatients),
    nearBreachCases: Number(nearBreachCases),
    avgCompletionHrs: avgCompletionHrs,
    casesToday: Number(casesToday),
    revenueToday: Number(revenueToday),
    newPatientsToday: Number(newPatientsToday),
    errorsToday: Number(errorsToday),
    errors24h: Number(errors24h),
    errorsByLevel: errorsByLevel,
    recentErrors: recentErrors,
    notifStats: notifStats,
    unpaidOrders: Number(unpaidOrders),
    failedPayments: Number(failedPayments),
    recentOrders: recentOrders,
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

// ── Error drill-down routes ─────────────────────────────

router.get('/errors', requireOpsAuth, async function (req, res) {
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var perPage = 50;
  var offset = (page - 1) * perPage;
  var levelFilter = req.query.level || '';

  var whereClause = '';
  var params = [];
  if (levelFilter) {
    whereClause = ' WHERE level = $1';
    params.push(levelFilter);
  }

  var totalRow = await safeGet(
    'SELECT COUNT(*) as c FROM error_logs' + whereClause,
    params, { c: 0 }
  );
  var totalCount = Number((totalRow || {}).c) || 0;
  var totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  var queryParams = params.slice();
  var limitParam = '$' + (queryParams.length + 1);
  var offsetParam = '$' + (queryParams.length + 2);
  queryParams.push(perPage, offset);

  var errors = await safeAll(
    'SELECT id, level, message, url, method, request_id, created_at FROM error_logs' + whereClause + ' ORDER BY created_at DESC LIMIT ' + limitParam + ' OFFSET ' + offsetParam,
    queryParams
  );

  for (var i = 0; i < errors.length; i++) {
    errors[i].time_ago = timeAgo(errors[i].created_at);
    errors[i].message_short = errors[i].message ? String(errors[i].message).slice(0, 120) : '';
  }

  res.render('ops-errors', {
    errors: errors,
    page: page,
    totalPages: totalPages,
    totalCount: totalCount,
    levelFilter: levelFilter
  });
});

router.get('/errors/:id', requireOpsAuth, async function (req, res) {
  var errorId = String(req.params.id || '');
  var err = await safeGet(
    'SELECT * FROM error_logs WHERE id = $1',
    [errorId], null
  );

  if (!err) {
    return res.status(404).render('ops-error-detail', { err: null });
  }

  err.time_ago = timeAgo(err.created_at);

  // Parse context JSON if present
  var contextParsed = null;
  if (err.context) {
    try {
      contextParsed = JSON.parse(err.context);
    } catch (e) {
      contextParsed = err.context;
    }
  }
  err.context_parsed = contextParsed;

  res.render('ops-error-detail', { err: err });
});

// ── Agent toggle endpoint ───────────────────────────────

router.post('/agent/toggle', requireOpsAuth, async function (req, res) {
  var body = req.body || {};
  var agentName = String(body.agent_name || '').trim();
  if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

  // Read current state from DB
  var current = await safeGet(
    'SELECT is_enabled FROM agent_config WHERE agent_name = $1',
    [agentName], { is_enabled: true }
  );
  var newState = !(current && current.is_enabled !== false);

  try {
    await execute(
      "INSERT INTO agent_config (agent_name, is_enabled, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (agent_name) DO UPDATE SET is_enabled = $2, updated_at = NOW()",
      [agentName, newState]
    );
    logMajor('ops agent toggle: ' + agentName + ' -> ' + (newState ? 'enabled' : 'paused'));
  } catch (e) {
    logMajor('ops agent/toggle error: ' + e.message);
    if ((req.get('accept') || '').includes('application/json')) {
      return res.status(500).json({ ok: false, error: 'internal' });
    }
    return res.redirect('/ops');
  }

  if ((req.get('accept') || '').includes('application/json')) {
    return res.json({ ok: true, agent_name: agentName, enabled: newState });
  }
  return res.redirect('/ops');
});

// ── Agent API endpoints (no auth — called from server-side agents) ──

var MAX_FIELD_LEN = 200;

router.post('/agent/ping', async function (req, res) {
  try {
    var body = req.body || {};
    var agentName = String(body.agent_name || '').trim().slice(0, MAX_FIELD_LEN);
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

    // Check agent_config — if paused, acknowledge but don't record
    var configRow = await safeGet(
      'SELECT is_enabled FROM agent_config WHERE agent_name = $1',
      [agentName], null
    );
    if (configRow && configRow.is_enabled === false) {
      return res.json({ ok: true, paused: true });
    }

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
