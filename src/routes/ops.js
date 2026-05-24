/**
 * Ops Dashboard — internal operations overview (password-protected).
 */

var express = require('express');
var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var os = require('os');
var { exec } = require('child_process');
var { queryOne, queryAll, execute } = require('../pg');
var { major: logMajor } = require('../logger');
var { SILENT_FAILURE_EVENTS } = require('../case_lifecycle');

var router = express.Router();
var OPS_BOOT_AT = Date.now();

// ── Silent-failures suffix conventions (Theme 8 Phase 5) ──────────────
//
// The /ops/silent-failures view queries case_events for event_types that
// end in `_SKIPPED`, `_FAILED`, `_DROPPED`, or `_NO_OP`. SILENT_FAILURE_EVENTS
// declared in case_lifecycle.js is the registry of known literals — the
// view picks them up automatically via SQL LIKE rather than a hard-coded
// IN list, so future entries don't require ops.js edits.
//
// Defensive guard: warn ONCE at boot if a registry literal doesn't match
// the expected suffix convention. Catches typos like
// `SLA_PAUSE_SKIPPPED` (3 P's) where the literal would emit to
// case_events but the LIKE patterns wouldn't pick it up.
var SILENT_FAILURE_SUFFIXES = ['_SKIPPED', '_FAILED', '_DROPPED', '_NO_OP'];
(function checkRegistrySuffixes() {
  try {
    if (!Array.isArray(SILENT_FAILURE_EVENTS)) return;
    SILENT_FAILURE_EVENTS.forEach(function (label) {
      var hasKnownSuffix = SILENT_FAILURE_SUFFIXES.some(function (s) {
        return String(label || '').endsWith(s);
      });
      if (!hasKnownSuffix) {
        logMajor(
          '[ops/silent-failures] WARNING: registry literal "' + label + '" does not end in ' +
          SILENT_FAILURE_SUFFIXES.join(' / ') +
          ' — the /ops/silent-failures LIKE query will NOT match this event_type.'
        );
      }
    });
  } catch (_) {
    // Boot-time guard must never crash ops.js load.
  }
})();

// ── Configured agents (always show even if never pinged) ──
//
// Side issue #55 (2026-05-12): list canonicals workers from side issue
// #49 (case_sla_worker, notification_worker, instagram_scheduler) plus
// the two that don't ping yet (video_scheduler, acceptance_watcher —
// pending side issue #54). The legacy rollup names (ops-agent,
// growth-agent, care-agent, finance-agent) were retired by #49 and no
// longer appear in fresh heartbeats. Any stale rollup-name rows still
// present in agent_heartbeats will surface via the merge at line 466
// below but show very old pinged_at timestamps; they'll age out
// naturally.

var CONFIGURED_AGENTS = [
  'case_sla_worker',
  'notification_worker',
  'video_scheduler',
  'instagram_scheduler',
  'acceptance_watcher'
];

// ── SSH helper for Mac mini monitoring ──────────────────

var macMiniStatus = { gateway: 'unknown', checkedAt: null };

function sshExec(cmd, callback) {
  var host = process.env.OPS_SSH_HOST;
  var user = process.env.OPS_SSH_USER;
  var keyPath = process.env.OPS_SSH_KEY_PATH;
  if (!host || !user) return callback(new Error('SSH not configured'), null);
  var sshCmd = 'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes';
  if (keyPath) sshCmd += ' -i ' + keyPath;
  sshCmd += ' ' + user + '@' + host + ' "' + cmd.replace(/"/g, '\\"') + '"';
  exec(sshCmd, { timeout: 10000 }, function (err, stdout) {
    callback(err, stdout ? stdout.trim() : '');
  });
}

function refreshMacMiniStatus() {
  sshExec('pgrep -f openclaw > /dev/null && echo running || echo stopped', function (err, result) {
    if (!err) {
      macMiniStatus.gateway = (result === 'running') ? 'running' : 'stopped';
      macMiniStatus.checkedAt = new Date().toISOString();
    }
  });
}

// Theme 6 §4-A (P3-WORKER-N5): probe registration is no longer at module-load.
// server.js now calls startMacMiniProbe() inside the primary-instance block so
// the probe runs on exactly one Render box and its interval id can be cleared
// on graceful shutdown.
var macMiniProbeId = null;
function startMacMiniProbe(intervalMs) {
  if (macMiniProbeId) return macMiniProbeId;
  var ms = Number(intervalMs || 2 * 60 * 1000);
  refreshMacMiniStatus();
  macMiniProbeId = setInterval(refreshMacMiniStatus, ms);
  if (macMiniProbeId && macMiniProbeId.unref) macMiniProbeId.unref();
  return macMiniProbeId;
}
function stopMacMiniProbe() {
  if (macMiniProbeId) { clearInterval(macMiniProbeId); macMiniProbeId = null; }
}

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

var JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not set');
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

// Stage 1 of the OPS_AGENT_KEY rollout (Theme 3 sub-issue D).
//
// Behavior matrix:
//   * OPS_AGENT_KEY unset                 → log "agent <route> unsigned"
//                                            and pass through (back-compat
//                                            with prior unauth'd agents).
//   * Header missing or wrong             → log "agent <route> unsigned"
//                                            and pass through (Stage 1).
//   * Header matches OPS_AGENT_KEY        → log "agent <route> signed OK"
//                                            and pass through.
//
// Stage 2 (manual cutover, NOT in this commit) flips the unsigned and
// wrong-key branches to 401. Runbook:
//   docs/runbooks/THEME_03_OPS_AGENT_KEY_CUTOVER.md
function requireAgentKeyOptional(routeLabel) {
  return function (req, res, next) {
    var expected = process.env.OPS_AGENT_KEY;
    var provided = String(req.get('x-ops-agent-key') || '');
    var verdict;
    if (!expected) {
      verdict = 'unsigned';   // server has no key configured yet
    } else if (!provided) {
      verdict = 'unsigned';
    } else {
      try {
        var a = Buffer.from(expected);
        var b = Buffer.from(provided);
        verdict = (a.length === b.length && crypto.timingSafeEqual(a, b))
          ? 'signed OK'
          : 'unsigned';
      } catch (_) {
        verdict = 'unsigned';
      }
    }
    var agentName = (req.body && req.body.agent_name)
      ? String(req.body.agent_name).slice(0, 80)
      : '<unknown>';
    logMajor('agent ' + routeLabel + ' ' + verdict + ' agent=' + agentName);
    return next();
  };
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
//
// gatherDashboardStats() collects every metric the dashboard shows and
// returns a plain data object. Two consumers share it: the HTML render
// (GET /) and the live-refresh JSON endpoint (GET /stats.json). Keeping
// one collector means the page and its 5s poll can never drift apart.
// Request/process-specific values that aren't metrics (cspNonce, csrfField)
// stay in the route handler.

async function gatherDashboardStats() {
  var CAIRO_TODAY = "date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'";

  // ── Platform stats ──
  var totalCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active",
    [], { c: 0 }
  )) || {}).c || 0;

  var casesThisMonth = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE created_at >= date_trunc('month', NOW())",
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueThisMonth = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= date_trunc('month', NOW())",
    [], { t: 0 }
  )) || {}).t || 0;

  var pendingCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE status IN ('new','pending','awaiting_review','review','paid')",
    [], { c: 0 }
  )) || {}).c || 0;

  var breachedCases = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE status = 'breached'",
    [], { c: 0 }
  )) || {}).c || 0;

  var completedThisMonth = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE status IN ('completed','done','delivered') AND created_at >= date_trunc('month', NOW())",
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueAllTime = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders_active WHERE payment_status IN ('paid','captured')",
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
    "SELECT COUNT(*) as c FROM orders_active WHERE status NOT IN ('completed','breached','cancelled') AND deadline_at IS NOT NULL AND deadline_at <= NOW() + INTERVAL '2 hours' AND deadline_at > NOW()",
    [], { c: 0 }
  )) || {}).c || 0;

  var avgCompletionHrs = ((await safeGet(
    "SELECT ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)::numeric, 1) as h FROM orders_active WHERE completed_at IS NOT NULL AND created_at >= date_trunc('month', NOW())",
    [], { h: null }
  )) || {}).h || null;

  // ── Today's snapshot ──
  var casesToday = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE created_at >= " + CAIRO_TODAY,
    [], { c: 0 }
  )) || {}).c || 0;

  var revenueToday = ((await safeGet(
    "SELECT COALESCE(SUM(price), 0) as t FROM orders_active WHERE payment_status IN ('paid','captured') AND created_at >= " + CAIRO_TODAY,
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

  // ── Recent errors (last 10, 24h only) ──
  var recentErrors = await safeAll(
    "SELECT id, level, message, url, method, created_at FROM error_logs WHERE created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 10",
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
    "SELECT COUNT(*) as c FROM orders_active WHERE payment_status = 'unpaid' AND status NOT IN ('cancelled','expired_unpaid')",
    [], { c: 0 }
  )) || {}).c || 0;

  var failedPayments = ((await safeGet(
    "SELECT COUNT(*) as c FROM orders_active WHERE payment_status = 'failed'",
    [], { c: 0 }
  )) || {}).c || 0;

  // ── Recent activity (last 10 orders) ──
  var recentOrders = await safeAll(
    "SELECT o.id, o.status, o.price, o.payment_status, o.created_at, COALESCE(sv.name, 'Unknown') as service_name, COALESCE(u.name, 'Patient') as patient_name, COALESCE(sp.name, '') as specialty_name FROM orders_active o LEFT JOIN services sv ON sv.id = o.service_id LEFT JOIN users u ON u.id = o.patient_id LEFT JOIN specialties sp ON sp.id = o.specialty_id ORDER BY o.created_at DESC LIMIT 10",
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

  // Render ONLY the active configured agents. Previously we merged in any
  // orphan agent_name found in agent_heartbeats, which resurfaced retired
  // rollup names (care-agent, ops-agent) as scary "Down" rows long after
  // they stopped existing. The canonical roster is CONFIGURED_AGENTS.
  var agents = CONFIGURED_AGENTS.map(function (name) {
    var hb = heartbeatMap[name];
    var pingedAt = hb ? hb.pinged_at : null;
    var enabled = agentEnabledMap.hasOwnProperty(name) ? agentEnabledMap[name] : true;
    // Status derived from heartbeat age (not the frozen text the agent last
    // POSTed). Computed server-side so the HTML render and /ops/stats.json
    // share one source of truth. 'off' = disabled-in-config (operator choice,
    // NOT a fault \u2014 must not surface as a problem in the attention column).
    var diffHrs = pingedAt ? (Date.now() - new Date(pingedAt).getTime()) / 3600000 : 999;
    var state, statusLabel, statusDot;
    if (!enabled) {
      state = 'off';   statusLabel = 'Off';   statusDot = '\u26aa';
    } else if (diffHrs < 2) {
      state = 'live';  statusLabel = 'Live';  statusDot = '\u{1F7E2}';
    } else if (diffHrs < 12) {
      state = 'stale'; statusLabel = 'Stale'; statusDot = '\u{1F7E1}';
    } else {
      state = 'down';  statusLabel = 'Down';  statusDot = '\u{1F534}';
    }
    return {
      agent_name: name,
      status: hb ? hb.status : 'never',
      current_task: hb ? (hb.current_task || '\u2014') : '\u2014',
      pinged_at: pingedAt,
      last_seen: hb ? timeAgo(hb.pinged_at) : 'never',
      token_cost_mtd: tokenCostMap[name] || 0,
      tokens_used_mtd: tokenCountMap[name] || 0,
      enabled: enabled,
      state: state,
      statusLabel: statusLabel,
      statusDot: statusDot
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
  var macMiniCheckedAgo = macMiniStatus.checkedAt ? timeAgo(new Date(macMiniStatus.checkedAt)) : null;

  // ── Paymob health (P1-PAY-1 commit 5) ─────────────────
  // Three metrics surfaced from payment_events. lastIntention /
  // lastWebhook are visibility signals (catches dead integrations);
  // hmacFailures24h is the HMAC-fraud counter complementing the
  // critical-alert WhatsApp ping (which is throttled 1/5min).
  var lastIntentionAt = ((await safeGet(
    "SELECT received_at FROM payment_events WHERE event_type = 'intention_created' ORDER BY received_at DESC LIMIT 1",
    [], { received_at: null }
  )) || {}).received_at || null;

  var lastWebhookAt = ((await safeGet(
    "SELECT received_at FROM payment_events WHERE event_type IN ('webhook_received','payment_succeeded','payment_failed') ORDER BY received_at DESC LIMIT 1",
    [], { received_at: null }
  )) || {}).received_at || null;

  var hmacFailures24h = ((await safeGet(
    "SELECT COUNT(*) as c FROM payment_events WHERE event_type = 'hmac_failure' AND received_at >= NOW() - INTERVAL '24 hours'",
    [], { c: 0 }
  )) || {}).c || 0;

  var paymobHealth = {
    lastIntentionAt: lastIntentionAt,
    lastIntentionAgo: lastIntentionAt ? timeAgo(new Date(lastIntentionAt)) : null,
    lastWebhookAt: lastWebhookAt,
    lastWebhookAgo: lastWebhookAt ? timeAgo(new Date(lastWebhookAt)) : null,
    hmacFailures24h: Number(hmacFailures24h)
  };

  // Theme 9 Sub-issue A: WhatsApp health card. Token-401 count in the last
  // 15min (the cron's own threshold) + total whatsapp_send failures in
  // 24h. Reads error_logs.context::jsonb so any caller writing through
  // logErrorToDb({ category:'whatsapp_send', statusCode:... }) surfaces.
  var waToken401Last15min = ((await safeGet(
    "SELECT COUNT(*)::int AS c FROM error_logs" +
    " WHERE category = 'whatsapp_send'" +
    "   AND created_at > NOW() - INTERVAL '15 minutes'" +
    "   AND (context::jsonb)->>'statusCode' = '401'",
    [], { c: 0 }
  )) || {}).c || 0;
  var waSendErrors24h = ((await safeGet(
    "SELECT COUNT(*)::int AS c FROM error_logs" +
    " WHERE category = 'whatsapp_send'" +
    "   AND created_at > NOW() - INTERVAL '24 hours'",
    [], { c: 0 }
  )) || {}).c || 0;
  var whatsappHealth = {
    token401Last15min: Number(waToken401Last15min),
    sendErrorsLast24h: Number(waSendErrors24h)
  };

  // ── Silent-failures total (Theme 8 Phase 5) ──
  //
  // One number for the dashboard card — sum of SKIPPED / FAILED / DROPPED /
  // NO_OP case_events in the last 7 days. Detail view at /ops/silent-failures
  // breaks this down by event_type. Threshold color is applied view-side.
  // safeGet returns the fallback if case_events doesn't exist (legacy envs).
  var silentFailures7d = ((await safeGet(
    "SELECT COUNT(*) AS c FROM case_events" +
    " WHERE created_at >= NOW() - INTERVAL '7 days'" +
    "   AND (event_type LIKE '%\\_SKIPPED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_FAILED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_DROPPED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_NO\\_OP' ESCAPE '\\')",
    [], { c: 0 }
  )) || {}).c || 0;

  // ── Theme 8 Phase 7 — six new widgets ──────────────────────────────

  // Widget 1: notification queue depth + oldest-stuck age.
  var notifQueueDepth = Number(((await safeGet(
    "SELECT COUNT(*) AS c FROM notifications WHERE status IN ('queued','retry')",
    [], { c: 0 }
  )) || {}).c) || 0;
  var notifOldestStuckSec = Number(((await safeGet(
    "SELECT EXTRACT(EPOCH FROM (NOW() - MIN(at))) AS s" +
    "  FROM notifications WHERE status IN ('queued','retry')",
    [], { s: 0 }
  )) || {}).s) || 0;

  // Widget 2: dispatched-vs-skipped split (this month). Phase 4-C unlock:
  // 'skipped' now distinguishes user-preference drops from real delivery.
  var notifStatusSplit = await safeAll(
    "SELECT status, COUNT(*) AS c FROM notifications" +
    " WHERE at >= date_trunc('month', NOW())" +
    " GROUP BY status",
    []
  );

  // Widget 3: cron last-run age per canonical worker name. Today's
  // codebase uses rollup names ('care-agent', 'ops-agent', 'growth-agent')
  // and the 2 newer workers don't ping at all — Widget 3 lists the 5
  // canonical names and shows "never run" for any missing row. Side
  // issue #48: update each worker to ping with its canonical name.
  var CRON_NAMES = [
    'case_sla_worker',
    'notification_worker',
    'video_scheduler',
    'instagram_scheduler',
    'acceptance_watcher'
  ];
  var cronHeartbeats = await safeAll(
    "SELECT agent_name, MAX(pinged_at) AS last_run FROM agent_heartbeats" +
    " WHERE agent_name = ANY($1::text[])" +
    " GROUP BY agent_name",
    [CRON_NAMES]
  );
  var cronByName = {};
  for (var ch = 0; ch < cronHeartbeats.length; ch++) {
    cronByName[cronHeartbeats[ch].agent_name] = cronHeartbeats[ch].last_run;
  }
  var cronWidget = CRON_NAMES.map(function (name) {
    var last = cronByName[name] || null;
    return {
      name: name,
      lastRun: last,
      lastRunAgo: last ? timeAgo(new Date(last)) : null
    };
  });

  // Widget 4: error rate baseline + current-hour count. Threshold check
  // (current >= 5x baseline AND >= 5 absolute) is read-only here — the
  // critical-alert fire belongs in the cron path that already runs on
  // error inserts. Widget surfaces the ratio for operator eyeballing.
  var errorRateRow = await safeGet(
    "WITH baseline AS (" +
    "  SELECT COALESCE(AVG(c), 0) AS avg_per_hour FROM (" +
    "    SELECT date_trunc('hour', created_at) AS h, COUNT(*) AS c" +
    "      FROM error_logs" +
    "     WHERE created_at >= NOW() - INTERVAL '7 days'" +
    "       AND created_at <  date_trunc('hour', NOW())" +
    "     GROUP BY 1" +
    "  ) sub" +
    ")," +
    " cur AS (" +
    "  SELECT COUNT(*) AS c FROM error_logs" +
    "   WHERE created_at >= date_trunc('hour', NOW())" +
    " )" +
    " SELECT cur.c AS current_hour, baseline.avg_per_hour AS baseline" +
    "   FROM cur, baseline",
    [], { current_hour: 0, baseline: 0 }
  );

  // Widget 5: critical-alert delivery health. Last attempt + status.
  var lastCriticalAlert = await safeGet(
    "SELECT sent_at, status_code, alert_key, error" +
    "  FROM critical_alert_log" +
    " ORDER BY sent_at DESC LIMIT 1",
    [], null
  );

  // Widget 6: Resend health — env presence + last successful email.
  var resendKeyPresent = !!String(process.env.RESEND_API_KEY || '').trim();
  var lastEmailSentRow = await safeGet(
    "SELECT MAX(at) AS at FROM notifications" +
    " WHERE channel = 'email' AND status = 'sent'",
    [], { at: null }
  );

  var phase7Widgets = {
    notifQueueDepth: notifQueueDepth,
    notifOldestStuckSec: notifOldestStuckSec,
    notifOldestStuckAgo: notifOldestStuckSec > 0
      ? (notifOldestStuckSec < 60 ? Math.round(notifOldestStuckSec) + 's'
        : notifOldestStuckSec < 3600 ? Math.round(notifOldestStuckSec / 60) + 'min'
        : Math.round(notifOldestStuckSec / 3600) + 'h')
      : null,
    notifStatusSplit: notifStatusSplit,
    cronWidget: cronWidget,
    errorRate: {
      currentHour: Number((errorRateRow || {}).current_hour) || 0,
      baseline: Number((errorRateRow || {}).baseline) || 0
    },
    lastCriticalAlert: lastCriticalAlert
      ? {
          sentAt: lastCriticalAlert.sent_at,
          ago: timeAgo(new Date(lastCriticalAlert.sent_at)),
          statusCode: lastCriticalAlert.status_code,
          ok: lastCriticalAlert.status_code != null
            && lastCriticalAlert.status_code >= 200
            && lastCriticalAlert.status_code < 300,
          alertKey: lastCriticalAlert.alert_key,
          error: lastCriticalAlert.error
        }
      : null,
    resend: {
      envPresent: resendKeyPresent,
      lastSentAt: (lastEmailSentRow || {}).at || null,
      lastSentAgo: ((lastEmailSentRow || {}).at)
        ? timeAgo(new Date(lastEmailSentRow.at))
        : null
    }
  };

  // ── Derived summaries for the Mission-Control layout ─────────────────
  // Computed server-side so the health rail, the worker-count cell, and the
  // "Needs attention" column all read from one source (shared by the HTML
  // render and /ops/stats.json). The attention list contains ONLY genuine
  // problems — stale/down workers and an uncleared critical alert. Zero
  // errors and 'off' (disabled-in-config) agents are NOT problems.
  var workersLive = 0, workersStale = 0, workersDown = 0, workersOff = 0;
  agents.forEach(function (a) {
    if (a.state === 'live') workersLive++;
    else if (a.state === 'stale') workersStale++;
    else if (a.state === 'down') workersDown++;
    else if (a.state === 'off') workersOff++;
  });
  var workersTotal = agents.length;
  var workersSubParts = [];
  if (workersStale) workersSubParts.push(workersStale + ' stale');
  if (workersDown) workersSubParts.push(workersDown + ' down');
  if (workersOff) workersSubParts.push(workersOff + ' off');
  var workersSubLabel = workersSubParts.length ? workersSubParts.join(' · ') : 'all healthy';
  var workersOk = (workersStale === 0 && workersDown === 0);

  var dbPoolActive = dbPoolTotal - dbPoolIdle;

  var attention = [];
  agents.forEach(function (a) {
    if (a.state === 'down') {
      attention.push({
        severity: 'down',
        title: a.agent_name + ' down — last seen ' + a.last_seen,
        detail: 'Should run on interval but has not pinged recently. Work it owns may be stalled.'
      });
    } else if (a.state === 'stale') {
      attention.push({
        severity: 'stale',
        title: a.agent_name + ' stale — last seen ' + a.last_seen,
        detail: 'Heartbeat is aging — may have stopped checking in.'
      });
    }
  });
  if (phase7Widgets.lastCriticalAlert && !phase7Widgets.lastCriticalAlert.ok) {
    var _lca = phase7Widgets.lastCriticalAlert;
    attention.push({
      severity: 'down',
      title: 'Critical alert FAIL (' + _lca.ago + ')',
      detail: 'Last critical-alert delivery failed (status ' + (_lca.statusCode || '—') + ')'
        + (_lca.alertKey ? ' · ' + _lca.alertKey : '') + ' — never cleared.'
    });
  }

  return {
    // Rail health booleans (drive ok/bad coloring; updated live).
    errorsOk: Number(errors24h) === 0 && Number(silentFailures7d) === 0,
    slaOk: Number(breachedCases) === 0,
    dbPoolOk: dbPoolWaiting === 0,
    payOk: Number(failedPayments) === 0 && Number(hmacFailures24h) === 0,
    macMiniOk: macMiniStatus.gateway === 'running',
    workersOk: workersOk,
    workersLive: workersLive,
    workersStale: workersStale,
    workersDown: workersDown,
    workersOff: workersOff,
    workersTotal: workersTotal,
    workersSubLabel: workersSubLabel,
    dbPoolActive: dbPoolActive,
    attention: attention,
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
    mode: process.env.MODE || process.env.NODE_ENV || 'development',
    macMiniStatus: macMiniStatus,
    macMiniCheckedAgo: macMiniCheckedAgo,
    paymobHealth: paymobHealth,
    whatsappHealth: whatsappHealth,
    silentFailures7d: Number(silentFailures7d),
    phase7Widgets: phase7Widgets
  };
}

router.get('/', requireOpsAuth, async function (req, res) {
  try {
    var stats = await gatherDashboardStats();
    stats.cspNonce = req.cspNonce || (res.locals && res.locals.cspNonce) || '';
    res.render('ops-dashboard', stats);
  } catch (e) {
    logMajor('ops dashboard render error: ' + e.message);
    res.status(500).send('Dashboard temporarily unavailable.');
  }
});

// Live-refresh data source. Same auth as the page; the client polls this
// every 5s and updates values in place instead of reloading the whole page.
router.get('/stats.json', requireOpsAuth, async function (req, res) {
  try {
    var stats = await gatherDashboardStats();
    res.set('Cache-Control', 'no-store');
    res.json(stats);
  } catch (e) {
    logMajor('ops stats.json error: ' + e.message);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ── Silent failures (Theme 8 Phase 5) ───────────────────
//
// Operator-facing surface for the case_events emitted by Phases 1-4.
// SKIPPED / FAILED / DROPPED suffix labels mean "code ran but did
// nothing useful" — silent no-ops that the original SLA_PAUSE_SKIPPED
// incident proved can hide in production for months without anyone
// noticing.
//
// Fixed 7-day window, default sort. No filtering UI in v1 — count the
// signal, surface it, iterate later. SILENT_FAILURE_EVENTS registry in
// case_lifecycle.js declares the canonical literals; the SQL uses
// suffix LIKE patterns so new entries are picked up automatically.

router.get('/silent-failures', requireOpsAuth, async function (req, res) {
  var counts = await safeAll(
    "SELECT event_type, COUNT(*) AS c FROM case_events" +
    " WHERE created_at >= NOW() - INTERVAL '7 days'" +
    "   AND (event_type LIKE '%\\_SKIPPED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_FAILED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_DROPPED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_NO\\_OP' ESCAPE '\\')" +
    " GROUP BY event_type ORDER BY c DESC",
    []
  );

  var recent = await safeAll(
    "SELECT case_id, event_type, event_payload, created_at FROM case_events" +
    " WHERE created_at >= NOW() - INTERVAL '7 days'" +
    "   AND (event_type LIKE '%\\_SKIPPED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_FAILED' ESCAPE '\\'" +
    "        OR event_type LIKE '%\\_DROPPED' ESCAPE '\\')" +
    " ORDER BY created_at DESC LIMIT 100",
    []
  );

  // Normalize: parse payload JSON (case_events.event_payload is stored as
  // TEXT) and pull out reason for display. Add time_ago. Tolerate non-JSON
  // legacy rows by falling back to the raw string.
  var totalCount = 0;
  for (var ci = 0; ci < counts.length; ci++) {
    counts[ci].c = Number(counts[ci].c) || 0;
    totalCount += counts[ci].c;
  }
  for (var ri = 0; ri < recent.length; ri++) {
    var r = recent[ri];
    var payload = null;
    if (r.event_payload) {
      try { payload = JSON.parse(r.event_payload); }
      catch (_) { payload = null; }
    }
    r.payload_parsed = payload;
    r.reason = (payload && payload.reason) ? String(payload.reason) : '';
    r.time_ago = timeAgo(r.created_at);
  }

  res.render('ops-silent-failures', {
    counts: counts,
    recent: recent,
    totalCount: totalCount,
    registry: Array.isArray(SILENT_FAILURE_EVENTS) ? SILENT_FAILURE_EVENTS.slice() : []
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
    errors[i].message_short = errors[i].message ? String(errors[i].message).slice(0, 100) : '';
    errors[i].row_num = offset + i + 1;
  }

  res.render('ops-errors', {
    errors: errors,
    page: page,
    totalPages: totalPages,
    totalCount: totalCount,
    perPage: perPage,
    offset: offset,
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
    return res.status(404).render('ops-error-detail', { err: null, similarErrors: [] });
  }

  err.time_ago = timeAgo(err.created_at);

  var contextParsed = null;
  if (err.context) {
    try {
      contextParsed = JSON.parse(err.context);
    } catch (e) {
      contextParsed = err.context;
    }
  }
  err.context_parsed = contextParsed;

  // Similar errors (same message, different id)
  var similarErrors = [];
  if (err.message) {
    similarErrors = await safeAll(
      'SELECT id, created_at FROM error_logs WHERE message = $1 AND id != $2 ORDER BY created_at DESC LIMIT 5',
      [err.message, errorId]
    );
    for (var si = 0; si < similarErrors.length; si++) {
      similarErrors[si].time_ago = timeAgo(similarErrors[si].created_at);
    }
  }

  res.render('ops-error-detail', { err: err, similarErrors: similarErrors });
});

// ── Agent toggle endpoint ───────────────────────────────

router.post('/agent/toggle', requireOpsAuth, async function (req, res) {
  var body = req.body || {};
  var agentName = String(body.agent_name || '').trim();
  if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

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

// ── Agent status (SSH check) ────────────────────────────

router.get('/agent/status', requireOpsAuth, function (req, res) {
  sshExec('pgrep -f openclaw > /dev/null && echo running || echo stopped', function (err, result) {
    if (err) return res.json({ ok: true, gateway: 'unknown', note: err.message });
    res.json({ ok: true, gateway: result === 'running' ? 'running' : 'stopped', checkedAt: new Date().toISOString() });
  });
});

// Diagnostic probe — confirms whether the running process sees
// UPLOADCARE_PUBLIC_KEY in process.env. Never returns the full value;
// only a boolean, the byte length, and the first 4 chars (a typical
// pubkey prefix is "pubkey_…" — enough to confirm the right value
// reached the process without leaking the secret).
router.get('/env-check', requireOpsAuth, function (req, res) {
  var raw = String(process.env.UPLOADCARE_PUBLIC_KEY || '');
  res.json({
    uploadcare_public_key_set: !!raw.trim().length,
    uploadcare_public_key_length: raw.length,
    uploadcare_public_key_prefix: raw.slice(0, 4),
    checkedAt: new Date().toISOString()
  });
});

// ── Agent API endpoints (no auth — called from server-side agents) ──

var MAX_FIELD_LEN = 200;

router.post('/agent/ping', requireAgentKeyOptional('ping'), async function (req, res) {
  try {
    var body = req.body || {};
    var agentName = String(body.agent_name || '').trim().slice(0, MAX_FIELD_LEN);
    if (!agentName) return res.status(400).json({ ok: false, error: 'agent_name required' });

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

router.post('/agent/log-tokens', requireAgentKeyOptional('log-tokens'), async function (req, res) {
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
module.exports.startMacMiniProbe = startMacMiniProbe;
module.exports.stopMacMiniProbe = stopMacMiniProbe;
