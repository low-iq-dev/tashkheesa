// src/services/ai_health.js
//
// AI-layer health flag. A $0 Anthropic balance returns HTTP 400 "credit
// balance is too low" and silently degrades EVERY AI feature (classifier,
// case-intelligence). This module turns that into one durable, surfaced
// signal:
//
//   - recordAiHealth(false, err, ctx) — when an AI call fails, trip the flag
//     IF (and only if) it is a billing failure (isAnthropicBillingError). The
//     first detection of an outage logs ONE loud warning; repeats only refresh
//     the timestamp (no log spam).
//   - recordAiHealth(true)            — when an AI call succeeds, clear the
//     flag (logs once on recovery). No-op when already healthy, so there is no
//     write per successful call.
//   - getAiHealth()                   — read the flag for the ops dashboards.
//
// The flag is a single admin_settings row: key='ai_billing_status',
// value=JSON {ok, lastFailAt, lastOkAt, lastError, context}. Absence = healthy
// (no detected outage). Every path is wrapped so health-recording can never
// break or block the caller.

'use strict';

var { queryOne, execute } = require('../pg');
var { fatal: logFatal, major: logMajor } = require('../logger');
var { isAnthropicBillingError, modelHaiku } = require('../config/anthropic');

var FLAG_KEY = 'ai_billing_status';

// Staleness threshold (hours). If no successful canary ping has landed in this
// long, the banner flags STALE regardless of error TYPE — catching a total AI
// outage for any reason (network, API down, revoked key) that the billing-only
// trip would miss. Default 6h against the 3h canary cadence = 2 missed cycles
// before flagging (no flapping on a single transient miss).
function _staleHours() {
  var h = Number(process.env.AI_CANARY_STALE_HOURS);
  return (isFinite(h) && h > 0) ? h : 6;
}

// Injectable deps (test seam — mirrors admin_settings.js).
var _deps = { queryOne: queryOne, execute: execute, logFatal: logFatal, logMajor: logMajor, now: function () { return Date.now(); } };
function _setDepsForTests(d) { if (d) Object.assign(_deps, d); }
function _resetDepsForTests() {
  _deps = { queryOne: queryOne, execute: execute, logFatal: logFatal, logMajor: logMajor, now: function () { return Date.now(); } };
}

function _nowIso() { return new Date(_deps.now()).toISOString(); }

// STALE only when a canary HAS succeeded before and then went quiet (> the
// threshold). A null lastCanaryOkAt (dev / no pg-boss / cold-start) is NOT
// stale — we have no basis to claim it, and the flag persists across deploys
// so a restart never trips it.
function _isStale(lastCanaryOkAt) {
  if (!lastCanaryOkAt) return false;
  var t = Date.parse(lastCanaryOkAt);
  if (!isFinite(t)) return false;
  return (_deps.now() - t) > _staleHours() * 3600 * 1000;
}

async function getAiHealth() {
  try {
    var row = await _deps.queryOne("SELECT value FROM admin_settings WHERE key = $1", [FLAG_KEY]);
    if (!row || !row.value) return { ok: true, stale: false, degraded: false, lastCanaryOkAt: null };
    var v = JSON.parse(row.value);
    var lastCanaryOkAt = v.lastCanaryOkAt || null;
    var ok = v.ok !== false;
    var stale = _isStale(lastCanaryOkAt);
    return {
      ok: ok,
      stale: stale,
      degraded: (!ok || stale),                             // billing-tripped OR heartbeat-stale
      lastFailAt: v.lastFailAt || null,
      lastOkAt: v.lastOkAt || null,
      lastCanaryOkAt: lastCanaryOkAt,
      lastError: v.lastError || null,
      context: v.context || null
    };
  } catch (_) {
    return { ok: true, stale: false, degraded: false, lastCanaryOkAt: null }; // unreadable → don't block dashboards
  }
}

async function _writeFlag(obj) {
  await _deps.execute(
    "INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES ($1, $2, 'ai-health', $3) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
    [FLAG_KEY, JSON.stringify(obj), _nowIso()]
  );
}

// ok=true on any successful AI call; ok=false on a failure (err is the SDK
// error, ctx={context} the call site). Never throws.
async function recordAiHealth(ok, err, ctx) {
  try {
    var current = await getAiHealth();

    if (ok) {
      if (current.ok === false) {
        await _writeFlag({ ok: true, lastOkAt: _nowIso() });
        _deps.logMajor('[ai-health] Anthropic AI layer recovered — billing OK; classifier + case-intelligence restored.');
      }
      return;
    }

    // A failure only trips the flag when it is specifically a BILLING failure.
    if (!isAnthropicBillingError(err)) return;

    var msg = String((err && err.message) || 'credit balance too low').slice(0, 300);
    await _writeFlag({
      ok: false,
      lastFailAt: _nowIso(),
      lastError: msg,
      context: (ctx && ctx.context) || null
    });

    if (current.ok !== false) {
      // First detection of this outage → one loud, greppable warning.
      _deps.logFatal('[ai-health] Anthropic BILLING failure — ALL AI features degraded (classifier, case-intelligence). ' + msg);
    }
  } catch (_) {
    // Health recording must never break or block the AI call site.
  }
}

// Called on every SUCCESSFUL canary ping. Always stamps lastCanaryOkAt (the
// staleness heartbeat — ~8 writes/day at the 3h cadence, no amplification) and
// clears the billing flag on recovery. Never throws.
async function recordCanaryHealthy() {
  try {
    var current = await getAiHealth();
    var nowIso = _nowIso();
    var recovered = current.ok === false;
    await _writeFlag({
      ok: true,
      lastOkAt: recovered ? nowIso : (current.lastOkAt || null),
      lastCanaryOkAt: nowIso
    });
    if (recovered) {
      _deps.logMajor('[ai-health] Anthropic AI layer recovered (canary) — billing OK; classifier + case-intelligence restored.');
    }
  } catch (_) { /* never break the canary */ }
}

// The scheduled probe body: the cheapest possible Anthropic call (1 output
// token), then record the result. The client is injected so this is testable
// without the SDK. Returns true on success, false on any failure. A billing
// failure trips the flag; other failures are left for the staleness check.
async function runCanary(client) {
  try {
    await client.messages.create({
      model: modelHaiku(),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    });
    await recordCanaryHealthy();
    return true;
  } catch (err) {
    await recordAiHealth(false, err, { context: 'ai-canary' });
    return false;
  }
}

module.exports = {
  recordAiHealth: recordAiHealth,
  recordCanaryHealthy: recordCanaryHealthy,
  runCanary: runCanary,
  getAiHealth: getAiHealth,
  FLAG_KEY: FLAG_KEY,
  _setDepsForTests: _setDepsForTests,
  _resetDepsForTests: _resetDepsForTests
};
