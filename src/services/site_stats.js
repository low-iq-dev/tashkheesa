'use strict';

// Single source of truth for the public-facing catalog counts (visible
// specialties + visible services). Marketing/legal copy (homepage stat, terms,
// blog bodies) reads these instead of hardcoding numbers, so the figures can
// never drift from the live catalog.
//
// Each count is a live query + 5-minute in-memory cache; on a brief DB blip it
// falls back to the last good value (or a sane default) so a page never errors.

const { queryOne } = require('../pg');

var TTL_MS = 5 * 60 * 1000;
var _cache = {}; // key -> { count, ts }

function _now() { return Date.now(); }

async function _cachedCount(key, sql, fallback) {
  var now = _now();
  var c = _cache[key];
  if (c && c.count != null && (now - c.ts) < TTL_MS) return c.count;
  try {
    var row = await queryOne(sql);
    if (row && Number.isFinite(Number(row.n))) {
      _cache[key] = { count: Number(row.n), ts: now };
    }
  } catch (_) {
    // Keep the last cached value; if there is none, the fallback below applies.
  }
  return (_cache[key] && _cache[key].count != null) ? _cache[key].count : fallback;
}

async function getVisibleSpecialtyCount() {
  return _cachedCount(
    'specialties',
    "SELECT count(*)::int AS n FROM specialties WHERE COALESCE(is_visible, true) = true",
    19
  );
}

async function getVisibleServiceCount() {
  return _cachedCount(
    'services',
    "SELECT count(*)::int AS n FROM services WHERE COALESCE(is_visible, true) = true",
    140
  );
}

module.exports = {
  getVisibleSpecialtyCount: getVisibleSpecialtyCount,
  getVisibleServiceCount: getVisibleServiceCount
};
