'use strict';

// Single source of truth for the public-facing catalog counts (visible
// specialties + visible services). Marketing/legal copy (homepage stat, terms,
// blog bodies) reads these instead of hardcoding numbers, so the figures can
// never drift from the live catalog.
//
// Each count is a live query + 5-minute in-memory cache; on a brief DB blip it
// falls back to the last good value (or a sane default) so a page never errors.

const { queryOne, queryAll } = require('../pg');
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
    // 7 visible today (2026-09-17: Cardiology, Internal Medicine, OB/GYN,
    // Orthopedics, Pediatrics, Radiology, Urology). The old fallback of
    // 19 predates migrations 060/066 and would have printed a claim three
    // times the truth on the one request where the DB blipped.
    7
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

/**
 * Everything the public pages need to describe the catalogue, in one query.
 *
 * The site now LISTS the whole catalogue and marks what is not yet orderable
 * with a Coming Soon pill, so two different numbers are on the page at once and
 * they must not be computed in two different places:
 *
 *   bookable  — what a patient can actually buy today (the shared rule)
 *   total     — what the page displays, coming-soon included
 *
 * The price range is deliberately BOOKABLE-ONLY. Listing coming-soon services
 * must never move the advertised range, or the site quotes a price for
 * something nobody can buy. Today the two ranges happen to be identical
 * (1,600-5,500 either way), which is exactly the situation in which a
 * range computed over the wrong set would look correct and stay wrong.
 *
 * Zero rows is treated as a failed read, not as an empty catalogue: the
 * fallbacks below are production's real figures as of 2026-08-30.
 */
async function getCatalogueStats() {
  var now = _now();
  var c = _cache.catalogue;
  if (c && c.value && (now - c.ts) < TTL_MS) return c.value;

  var FALLBACK = {
    bookable: 55, total: 183,
    liveSpecialties: 6, totalSpecialties: 23,
    minPrice: 1600, maxPrice: 5500
  };
  try {
    var row = await queryOne(
      'SELECT ' +
      '  count(*) FILTER (WHERE ' + serviceBookableClause('sv') + ')::int         AS bookable, ' +
      '  count(*)::int                                                            AS total, ' +
      '  count(DISTINCT sv.specialty_id) FILTER (WHERE ' + serviceBookableClause('sv') + ')::int AS live_specialties, ' +
      '  count(DISTINCT sv.specialty_id)::int                                     AS total_specialties, ' +
      '  min(sv.base_price) FILTER (WHERE ' + serviceBookableClause('sv') + ')     AS min_price, ' +
      '  max(sv.base_price) FILTER (WHERE ' + serviceBookableClause('sv') + ')     AS max_price ' +
      '  FROM services sv ' +
      ' WHERE sv.base_price IS NOT NULL AND sv.base_price > 0'
    );
    if (row && Number(row.total) > 0) {
      var value = {
        bookable: Number(row.bookable) || 0,
        total: Number(row.total) || 0,
        liveSpecialties: Number(row.live_specialties) || 0,
        totalSpecialties: Number(row.total_specialties) || 0,
        minPrice: Number(row.min_price) || FALLBACK.minPrice,
        maxPrice: Number(row.max_price) || FALLBACK.maxPrice
      };
      _cache.catalogue = { value: value, ts: now };
      return value;
    }
  } catch (_) {
    // Fall through to the last good value, then the fallback.
  }
  return (_cache.catalogue && _cache.catalogue.value) || FALLBACK;
}

// The id services.ejs gives a live specialty's section (`sectionId` there).
// The homepage links its specialty cards to /services#<this>, so the two must
// stay the same expression — tests/core/home-laptop-reveal.test.js renders
// both pages and checks every homepage link lands on a real section.
function specialtyAnchor(name) {
  return String(name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

/**
 * Rows of { name, name_ar, bookable } (one or more per specialty name) → the
 * two lists the homepage draws.
 *
 *   open — at least one BOOKABLE service; `services` is that bookable count.
 *          Ordered by that count, largest first, then by name.
 *   soon — listed in the catalogue, nothing bookable yet. By name.
 *
 * This is /services' own split (static-pages.js: "a specialty is LIVE if any
 * of its services is bookable"), keyed by name as that page keys it, and
 * `services` is the number /services prints beside the same heading. Pure, so
 * the test harness can run fixtures through the real thing.
 */
function shapeSpecialtyList(rows) {
  var byName = {};
  (rows || []).forEach(function (r) {
    var name = r && r.name ? String(r.name) : '';
    if (!name) return;
    var e = byName[name] || (byName[name] = { name: name, nameAr: null, services: 0 });
    if (r.name_ar && !e.nameAr) e.nameAr = String(r.name_ar);
    e.services += Number(r.bookable) || 0;
  });
  var all = Object.keys(byName).sort().map(function (k) { return byName[k]; });
  return {
    open: all.filter(function (e) { return e.services > 0; }).sort(function (a, b) {
      return (b.services - a.services) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    }).map(function (e) {
      return { name: e.name, nameAr: e.nameAr, services: e.services, anchor: specialtyAnchor(e.name) };
    }),
    soon: all.filter(function (e) { return e.services === 0; }).map(function (e) {
      return { name: e.name, nameAr: e.nameAr };
    })
  };
}

/**
 * The homepage specialty grid: which specialties can be booked today, each
 * with its bookable-service count, and which are listed but not yet open.
 *
 * Same 5-minute cache and same failure rule as the counts above — a failed or
 * empty read keeps the last good list. With no good list at all it returns
 * EMPTY lists rather than a typed-in fallback: the homepage then draws no
 * cards, which is better than naming a specialty nobody can book.
 */
async function getSpecialtyList() {
  var now = _now();
  var c = _cache.specialtyList;
  if (c && c.value && (now - c.ts) < TTL_MS) return c.value;
  try {
    var rows = await queryAll(
      'SELECT sp.name AS name, sp.name_ar AS name_ar, ' +
      '       count(*) FILTER (WHERE ' + serviceBookableClause('sv') + ')::int AS bookable ' +
      '  FROM services sv ' +
      '  JOIN specialties sp ON sv.specialty_id = sp.id ' +
      ' WHERE sv.base_price IS NOT NULL AND sv.base_price > 0 ' +
      ' GROUP BY sp.id, sp.name, sp.name_ar'
    );
    if (rows && rows.length) {
      var value = shapeSpecialtyList(rows);
      _cache.specialtyList = { value: value, ts: now };
      return value;
    }
  } catch (_) {
    // Fall through to the last good list, then to empty.
  }
  return (_cache.specialtyList && _cache.specialtyList.value) || { open: [], soon: [] };
}

module.exports = {
  getVisibleSpecialtyCount: getVisibleSpecialtyCount,
  getVisibleServiceCount: getVisibleServiceCount,
  getCatalogueStats: getCatalogueStats,
  getSpecialtyList: getSpecialtyList,
  shapeSpecialtyList: shapeSpecialtyList,
  specialtyAnchor: specialtyAnchor
};
