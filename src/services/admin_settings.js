// src/services/admin_settings.js
//
// Theme 14 Phase 4 piece 2 — helper module for reading live-tunable
// settings from the `admin_settings` table (key/value/updated_by/
// updated_at, key is PK). Today it surfaces the three classifier
// confidence thresholds seeded by migration 061; the same module is
// the natural home if more admin-tunable knobs land later (the existing
// `auto_assign_enabled` flag is intentionally NOT migrated here yet —
// its inline read at src/auto_assign.js:63-74 is out of Phase 4 scope).
//
// Contract:
//   - getThreshold(key)  → Promise<number>  in [0, 1]
//   - getThresholds()    → Promise<{lock, auto, min}>
//   - invalidateCache()  → void   (called by the superadmin POST handler)
//
// Cache semantics:
//   - 60s TTL (Ziad-locked). Other processes pick up edits within 60s
//     of any superadmin write.
//   - Same-process explicit invalidation via invalidateCache() — the
//     superadmin POST handler calls this so the admin sees their edit
//     reflected on the next page render without waiting for TTL.
//
// Failure posture (Ziad Q1):
//   - DB error  → log via logErrorToDb (category='admin_settings') and
//                 return DEFAULTS. Wizard stays up under DB hiccups.
//   - Malformed value (non-finite, out-of-[0,1]) → log + fall through
//                 to the per-key default.
//   - Missing row → silent fall-through to default. (Migration 061
//                   seeds all three keys; this branch only fires if a
//                   superadmin DELETEs a row by hand.)
//
// Defaults intentionally match the hardcoded literals at
// patient_new_case.ejs:339-341 and patient.js:1717 — the helper-swap
// commit (piece 3) is a behavioural no-op.

'use strict';

var { queryAll } = require('../pg');
var { logErrorToDb } = require('../logger');

// ── Constants ──────────────────────────────────────────────────────────
var DEFAULTS = Object.freeze({
  classifier_threshold_locked:  0.95,
  classifier_threshold_auto:    0.85,
  classifier_threshold_minimum: 0.55
});

var CACHE_TTL_MS = 60 * 1000;

// ── Module-private state ───────────────────────────────────────────────
var _cache = null;            // Map<key, number> | null   (null = unset)
var _cacheExpiresAt = 0;       // epoch ms

// ── Test seams (no production caller touches these) ────────────────────
var _queryAllFn = queryAll;
var _logErrorFn = logErrorToDb;
var _nowFn = function () { return Date.now(); };

function _setQueryAllForTests(fn)   { _queryAllFn  = fn || queryAll; }
function _setErrorLoggerForTests(fn){ _logErrorFn  = fn || logErrorToDb; }
function _setClockForTests(fn)      { _nowFn       = fn || function () { return Date.now(); }; }
function _resetForTests() {
  _queryAllFn = queryAll;
  _logErrorFn = logErrorToDb;
  _nowFn = function () { return Date.now(); };
  invalidateCache();
}

// ── Loader ─────────────────────────────────────────────────────────────
async function _load() {
  var map = {};
  var rows;
  try {
    rows = await _queryAllFn(
      "SELECT key, value FROM admin_settings WHERE key LIKE 'classifier_threshold_%'"
    );
  } catch (err) {
    // DB error — fire-and-forget log, return empty map → defaults used.
    try {
      await _logErrorFn(err, {
        context: 'admin_settings._load',
        category: 'admin_settings',
        level: 'warn'
      });
    } catch (_) { /* logger itself failed; nothing more we can do */ }
    return map;
  }

  for (var i = 0; i < (rows || []).length; i++) {
    var row = rows[i];
    var key = row && row.key;
    var raw = row && row.value;
    var parsed = Number(raw);
    if (!isFinite(parsed) || parsed < 0 || parsed > 1) {
      // Malformed row — log and skip; the per-key default will be used.
      try {
        await _logErrorFn(new Error('admin_settings row malformed: ' + key + '=' + JSON.stringify(raw)), {
          context: 'admin_settings._load',
          category: 'admin_settings',
          level: 'warn'
        });
      } catch (_) { /* see above */ }
      continue;
    }
    map[key] = parsed;
  }
  return map;
}

async function _ensureFresh() {
  var now = _nowFn();
  if (_cache !== null && now < _cacheExpiresAt) return;
  _cache = await _load();
  _cacheExpiresAt = now + CACHE_TTL_MS;
}

// ── Public API ─────────────────────────────────────────────────────────
async function getThreshold(key) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error('admin_settings.getThreshold: unknown key "' + key + '"');
  }
  await _ensureFresh();
  if (Object.prototype.hasOwnProperty.call(_cache, key)) return _cache[key];
  return DEFAULTS[key];
}

async function getThresholds() {
  await _ensureFresh();
  return {
    lock: Object.prototype.hasOwnProperty.call(_cache, 'classifier_threshold_locked')
      ? _cache.classifier_threshold_locked  : DEFAULTS.classifier_threshold_locked,
    auto: Object.prototype.hasOwnProperty.call(_cache, 'classifier_threshold_auto')
      ? _cache.classifier_threshold_auto    : DEFAULTS.classifier_threshold_auto,
    min:  Object.prototype.hasOwnProperty.call(_cache, 'classifier_threshold_minimum')
      ? _cache.classifier_threshold_minimum : DEFAULTS.classifier_threshold_minimum
  };
}

function invalidateCache() {
  _cache = null;
  _cacheExpiresAt = 0;
}

module.exports = {
  getThreshold,
  getThresholds,
  invalidateCache,
  DEFAULTS,
  CACHE_TTL_MS,
  // Test seams
  _setQueryAllForTests,
  _setErrorLoggerForTests,
  _setClockForTests,
  _resetForTests
};
