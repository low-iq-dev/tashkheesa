'use strict';

// Single source of truth for the public-facing catalog counts (visible
// specialties + visible services). Marketing/legal copy (homepage stat, terms,
// blog bodies) reads these instead of hardcoding numbers, so the figures can
// never drift from the live catalog.
//
// Each count is a live query + 5-minute in-memory cache; on a brief DB blip it
// falls back to the last good value (or a sane default) so a page never errors.

const { queryOne } = require('../pg');
const { serviceBookableClause } = require('./service_bookable');

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
    // 6 visible today (28 rows, 22 deliberately hidden). The old fallback of
    // 19 predates migrations 060/066 and would have printed a claim three
    // times the truth on the one request where the DB blipped.
    6
  );
}

async function getVisibleServiceCount() {
  // BOOKABLE, not merely is_visible.
  //
  // This counted `is_visible = true` alone, which on 2026-08-29 returned 146
  // while only 55 services could actually be ordered — the other 91 are either
  // coming_soon or sit under a specialty that is itself hidden. That number is
  // printed to the public in the blog bodies and in the /services meta
  // description, so the site was advertising 2.6x the catalogue a patient can
  // buy from.
  //
  // Uses the shared rule rather than a local JOIN. The two are not
  // interchangeable: a LEFT JOIN hands a service with a NULL or dangling
  // specialty_id a NULL is_visible, which COALESCE(...,true) then reads as
  // VISIBLE and counts. serviceBookableClause's EXISTS excludes it, matching
  // what the wizard will actually let a patient order. There are no such
  // services today (checked in production), which is exactly why the wrong
  // version would have looked correct until the day one appeared.
  return _cachedCount(
    'services',
    'SELECT count(*)::int AS n FROM services sv WHERE ' + serviceBookableClause('sv'),
    55
  );
}

module.exports = {
  getVisibleSpecialtyCount: getVisibleSpecialtyCount,
  getVisibleServiceCount: getVisibleServiceCount
};
