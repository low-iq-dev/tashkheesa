/**
 * Ops Dashboard — internal operations overview (password-protected).
 */

var express = require('express');
var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var { queryOne, queryAll, execute } = require('../pg');
var { major: logMajor } = require('../logger');

var router = express.Router();

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
    // Compare against self to keep constant time, then return false
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

// ── Auth middleware ─────────────────────────────────────

var JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

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

// ── Login routes ────────────────────────────────────────

router.get('/login', function (req, res) {
  res.render('ops-login', { error: null });
});

router.post('/login', function (req, res) {
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
    var token = jwt.sign({ ops: true }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('ops_auth', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000
    });
    return res.redirect('/ops');
  }

  return res.render('ops-login', { error: 'Invalid credentials.' });
});

router.get('/logout', function (req, res) {
  res.clearCookie('ops_auth');
  res.redirect('/ops/login');
});

// ── Main dashboard ──────────────────────────────────────

router.get('/', requireOpsAuth, async function (req, res) {
  // Platform stats
  var totalCases = ((await safeGet("SELECT COUNT(*) as c FROM orders", [], { c: 0 })) || {}).c || 0;

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

  // Agent stats
  var agentHeartbeats = await safeAll(
    "SELECT DISTINCT ON (agent_name) agent_name, status, current_task, pinged_at FROM agent_heartbeats ORDER BY agent_name, pinged_at DESC",
    []
  );

  var agentTokens = await safeAll(
    "SELECT agent_name, COALESCE(SUM(cost_usd), 0) as total_cost FROM agent_token_log WHERE logged_at >= date_trunc('month', NOW()) GROUP BY agent_name",
    []
  );

  // Build token cost map
  var tokenCostMap = {};
  for (var i = 0; i < agentTokens.length; i++) {
    tokenCostMap[agentTokens[i].agent_name] = Number(agentTokens[i].total_cost) || 0;
  }

  // Enrich heartbeats with time-ago and token cost
  var agents = agentHeartbeats.map(function (a) {
    return {
      agent_name: a.agent_name,
      status: a.status,
      current_task: a.current_task || '—',
      pinged_at: a.pinged_at,
      last_seen: timeAgo(a.pinged_at),
      token_cost_mtd: tokenCostMap[a.agent_name] || 0
    };
  });

  // Instagram pipeline stats
  var igStats = await safeAll(
    "SELECT status, COUNT(*) as c FROM ig_scheduled_posts GROUP BY status",
    []
  );

  // Cairo time
  var cairoTime = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo' });

  res.render('ops-dashboard', {
    totalCases: Number(totalCases),
    casesThisMonth: Number(casesThisMonth),
    revenueThisMonth: Number(revenueThisMonth),
    pendingCases: Number(pendingCases),
    breachedCases: Number(breachedCases),
    activeDoctors: Number(activeDoctors),
    totalPatients: Number(totalPatients),
    agents: agents,
    igStats: igStats,
    cairoTime: cairoTime
  });
});

// ── Agent API endpoints (no auth — called from server-side agents) ──

router.post('/agent/ping', async function (req, res) {
  try {
    var body = req.body || {};
    var agentName = String(body.agent_name || '').trim();
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

    var id = 'hb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var status = String(body.status || 'idle');
    var currentTask = body.current_task || null;
    var tokenCost = Number(body.token_cost_usd) || 0;
    var meta = body.meta ? String(body.meta) : null;

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
    var agentName = String(body.agent_name || '').trim();
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

    var id = 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var tokensUsed = Number(body.tokens_used) || 0;
    var costUsd = Number(body.cost_usd) || 0;
    var taskLabel = body.task_label || null;

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

module.exports = router;
