// tests/lint/kpi-predicates-shared.test.js
//
// AUDIT-PREDICATE-PARITY (2026-08-29) — a chip must count what its list filters.
//
// THE RECURRING BUG. This codebase has produced the same defect four separate
// times, always the same way: a status tuple is written inline in the query
// behind a badge, and re-typed — slightly differently — in the query behind the
// list that badge opens. Verified pairs, all live before this change:
//
//   * GET /cases `breached` facet used 5 statuses; the ?breached=1 list, the
//     /pulse tile and the row-level `breached` flag used 9. Badge 0, list 2.
//   * GET /cases `unassigned` facet used ('paid','reassigned'); the list used
//     the 9. Badge 0, list 1.
//   * Doctor "load" had three spellings in routes/api/admin.js alone, one of
//     them missing 'refunded', all three written as EXCLUSION lists — so an
//     abandoned 'draft' cart occupied a slot in a doctor's capacity, and the
//     load the picker SHOWED differed from the load the assign gate ENFORCED.
//   * Doctor SLA% counted every row with completed_at in the denominator.
//     services/refund_closure.js stamps completed_at when it closes a REFUNDED
//     order, so refunds were counted as missed deadlines. Production had a
//     doctor whose denominator was 2 with one genuine completion in it.
//
// THE RULE. The status sets live in exactly ONE place —
// src/routes/api/_assign_helpers.js — and every facet, list, tile and capacity
// gate interpolates the fragments built from them. This lint fails the build if
// a partial active-status tuple, a doctor-load exclusion list, or a bare
// completed_at SLA denominator is hand-written next to one of them again.
//
// Comments are stripped first (tests/_helpers/strip-comments), so the prose
// above and the prose in admin.js explaining WHY these spellings are banned
// cannot itself trip the lint. Three tests in this repo have been caught by
// that trap already.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments, stripSqlComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🎯 KPI predicates come from ONE shared definition\n');

const ROOT = path.join(__dirname, '..', '..');
const HELPERS_REL = path.join('src', 'routes', 'api', '_assign_helpers.js');
const helpers = require(path.join(ROOT, HELPERS_REL));

// The files allowed to compute a caseload / active-case / SLA predicate at all.
// _assign_helpers.js is the definition; the other two are its only consumers on
// these surfaces.
const CONSUMERS = [
  path.join('src', 'routes', 'api', 'admin.js'),
  path.join('src', 'services', 'admin_bulk_assign.js'),
];

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

function readCode(rel) {
  return stripSqlComments(stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
}

// ── 1. The definition exists, and is the set we think it is ─────────────────
const EXPECTED_ACTIVE = [
  'paid', 'in_progress', 'in_review', 'submitted', 'assigned',
  'rejected_files', 'sla_breach', 'breached', 'reassigned',
];

check('_assign_helpers exports the shared status sets + SQL builders', function () {
  const required = [
    'ACTIVE_STATUS_LIST', 'ACTIVE_STATUS_KEYS', 'ACTIVE_STATUSES',
    'activeCaseSql', 'breachedCaseSql', 'unassignedCaseSql',
    'doctorLoadSql', 'slaCountableCompletionSql', 'slaHitRatioSql',
  ];
  const missing = required.filter((k) => helpers[k] === undefined);
  if (missing.length) {
    throw new Error(
      'src/routes/api/_assign_helpers.js no longer exports: ' + missing.join(', ') +
      '. These are the single definition every facet/list/tile interpolates; without them the ' +
      'call sites go back to hand-written tuples and the badge/list drift returns.'
    );
  }
});

check('ACTIVE_STATUS_LIST holds every raw spelling an open case can carry', function () {
  const got = Array.from(helpers.ACTIVE_STATUS_LIST).slice().sort();
  const want = EXPECTED_ACTIVE.slice().sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      'ACTIVE_STATUS_LIST changed.\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want) +
      '\nIf a status was deliberately added or removed, update EXPECTED_ACTIVE here in the SAME ' +
      'commit — that is the point of this assertion. Both SLA_BREACH spellings must stay: prod ' +
      "carries the canonical 'sla_breach' AND the legacy 'breached'."
    );
  }
});

check('the SQL builders fold case and are built from the shared list', function () {
  const active = helpers.activeCaseSql('o.');
  if (!/LOWER\(COALESCE\(o\.status/.test(active)) {
    throw new Error(
      'activeCaseSql no longer folds case. orders.status is written in BOTH cases by different ' +
      "paths (production holds a 'draft' row and the canonical writer stores 'PAID'), so an " +
      'unfolded comparison is a coin flip on which writer touched the row last.'
    );
  }
  EXPECTED_ACTIVE.forEach((s) => {
    if (active.indexOf("'" + s + "'") === -1) {
      throw new Error(`activeCaseSql() does not include '${s}' — it is no longer built from ACTIVE_STATUS_LIST.`);
    }
  });
  // The narrower predicates must be supersets of the active one, by construction.
  ['breachedCaseSql', 'unassignedCaseSql'].forEach((fn) => {
    if (helpers[fn]('o.').indexOf(active) === -1) {
      throw new Error(
        `${fn}() is no longer built ON TOP of activeCaseSql(). That containment is what makes it ` +
        'impossible for the breached/unassigned count to exceed the active count it is a subset of.'
      );
    }
  });
  // Doctor load is the active predicate, so what the picker shows and what the
  // assign gate enforces are literally the same string.
  if (helpers.doctorLoadSql('o.') !== active) {
    throw new Error('doctorLoadSql() no longer equals activeCaseSql() — the picker and the capacity gate can drift again.');
  }
});

check('slaHitRatioSql builds its numerator FROM its denominator', function () {
  const den = helpers.slaCountableCompletionSql('o.');
  const ratio = helpers.slaHitRatioSql('o.');
  if (ratio.split(den).length - 1 < 2) {
    throw new Error(
      'slaHitRatioSql no longer uses slaCountableCompletionSql on BOTH sides of the ratio. The ' +
      'original bug was exactly this asymmetry: the numerator required deadline_at IS NOT NULL ' +
      'and the denominator did not, so a completion with no SLA clock counted as a miss it could ' +
      'not have hit.'
    );
  }
  if (!/completed_at IS NOT NULL/.test(den) || !/deadline_at IS NOT NULL/.test(den)
      || den.indexOf("'completed'") === -1) {
    throw new Error(
      'The SLA denominator no longer restricts to a genuine completion with a real deadline. ' +
      'services/refund_closure.js stamps completed_at when it closes a REFUNDED order, so a bare ' +
      "completed_at test counts every refund against the doctor as a missed deadline."
    );
  }
});

// ── 2. No consumer re-types a partial active-status tuple ───────────────────
//
// Trigger: any SQL `IN (...)` tuple that pairs 'paid' with another ORDER status.
// That shape is only ever an attempt to spell the active set by hand. Refund and
// payment tuples ('paid','approved','auto_approved'), ('paid','denied'),
// ('paid','captured') do not trip it — none of their companions is an order
// status — which is what keeps this lint narrow enough to be worth having.
const ORDER_STATUS_COMPANIONS = [
  'assigned', 'reassigned', 'in_progress', 'in_review',
  'sla_breach', 'breached', 'submitted', 'rejected_files',
];

CONSUMERS.forEach((rel) => {
  check(`${rel} hand-writes no partial active-status tuple`, function () {
    const src = readCode(rel);
    const offenders = [];
    const re = /IN\s*\(((?:\s*'[a-z_]+'\s*,?)+)\)/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const members = m[1].match(/'([a-z_]+)'/gi).map((s) => s.replace(/'/g, '').toLowerCase());
      if (members.indexOf('paid') === -1) continue;
      const companion = members.find((s) => ORDER_STATUS_COMPANIONS.indexOf(s) !== -1);
      if (!companion) continue;
      offenders.push(`line ${src.slice(0, m.index).split('\n').length}: IN (${m[1].trim()})`);
    }
    if (offenders.length) {
      throw new Error(
        `${rel} spells the active-status set inline:\n  ` + offenders.join('\n  ') +
        '\n\nUse activeCaseSql/breachedCaseSql/unassignedCaseSql from ' + HELPERS_REL + '. Every ' +
        'time this set has been re-typed, a badge and the list it opens have ended up counting ' +
        'different rows.'
      );
    }
  });
});

// ── 3. No consumer re-types the doctor-load EXCLUSION list ──────────────────
CONSUMERS.forEach((rel) => {
  check(`${rel} computes doctor load from the shared expression only`, function () {
    const src = readCode(rel);
    const bad = /NOT\s+IN\s*\(\s*'completed'\s*,\s*'cancelled'\s*,\s*'expired_unpaid'/i;
    if (bad.test(src)) {
      throw new Error(
        `${rel} still derives a caseload from a NOT IN exclusion list. An exclusion list counts ` +
        "every status nobody remembered to exclude — which is how an abandoned 'draft' cart came " +
        "to occupy a slot in a doctor's capacity, and how one of the three copies silently " +
        "omitted 'refunded'. Use doctorLoadSql() from " + HELPERS_REL + '.'
      );
    }
    // Every `AS load` subquery must be the shared one.
    const loads = src.match(/AS\s+load\b/gi) || [];
    const shared = src.match(/doctorLoadSql\(/g) || [];
    if (loads.length && shared.length < loads.length) {
      throw new Error(
        `${rel} has ${loads.length} "AS load" subquery/ies but only ${shared.length} doctorLoadSql() ` +
        'call(s). One of them is computing load some other way.'
      );
    }
  });
});

// ── 4. No consumer re-types the SLA hit-rate ratio ──────────────────────────
check('admin.js computes every SLA hit-rate through slaHitRatioSql()', function () {
  const rel = path.join('src', 'routes', 'api', 'admin.js');
  const src = readCode(rel);
  if (/COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+o\.completed_at\s+IS\s+NOT\s+NULL\s*\)/i.test(src)) {
    throw new Error(
      'admin.js still uses a bare `COUNT(*) FILTER (WHERE o.completed_at IS NOT NULL)` as an SLA ' +
      'denominator. services/refund_closure.js stamps completed_at on a REFUNDED order, so that ' +
      'denominator counts refunds as missed deadlines. Use slaHitRatioSql() from ' + HELPERS_REL + '.'
    );
  }
  const uses = (src.match(/AS\s+sla_hit\b/gi) || []).length;
  const shared = (src.match(/slaHitRatioSql\(/g) || []).length;
  if (uses !== shared) {
    throw new Error(
      `admin.js exposes sla_hit ${uses} time(s) but calls slaHitRatioSql() ${shared} time(s). ` +
      'The doctors roster and the case-detail card must report the same percentage.'
    );
  }
});

// ── 5. The JS row flag agrees with the SQL facet that counts it ─────────────
check('the /cases row `unassigned` flag reads ACTIVE_STATUS_KEYS', function () {
  const src = readCode(path.join('src', 'routes', 'api', 'admin.js'));
  if (!/unassigned:\s*!r\.doctor_id[^\n]*ACTIVE_STATUS_KEYS\.has\(norm\)/.test(src)) {
    throw new Error(
      "The per-row `unassigned` flag no longer tests ACTIVE_STATUS_KEYS. It used to be " +
      "`norm === 'paid' || norm === 'reassigned'` — a third spelling of the same set, on the same " +
      'screen as the facet and the list.'
    );
  }
  // ACTIVE_STATUS_KEYS must be the normalized image of ACTIVE_STATUS_LIST.
  const keys = Array.from(helpers.ACTIVE_STATUS_KEYS).sort();
  const want = Array.from(new Set(helpers.ACTIVE_STATUS_LIST.map(helpers.normalizeStatus))).sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) {
    throw new Error('ACTIVE_STATUS_KEYS is not normalizeStatus() applied to ACTIVE_STATUS_LIST.');
  }
});

// ── 6. The Payments tiles and the lists beneath them value refunds alike ────
check('refund money uses COALESCE(approved_amount, amount_egp) on both tile and list', function () {
  const src = readCode(path.join('src', 'routes', 'api', 'admin.js'));
  if (/SUM\(\s*(?:r\.)?amount_egp\s*\)/i.test(src)) {
    throw new Error(
      'A refund total is still summed as SUM(amount_egp). amount_egp is what the patient ASKED ' +
      'for; a partial approval in the web console (routes/superadmin.js) writes the settled ' +
      'figure to approved_amount and leaves amount_egp alone. The tile then reads 1250 over a ' +
      'list of 400. Use SETTLED_REFUND_EGP_R.'
    );
  }
  if (!/const\s+SETTLED_REFUND_EGP_R\s*=\s*'COALESCE\(r\.approved_amount,\s*r\.amount_egp\)'/.test(src)) {
    throw new Error('SETTLED_REFUND_EGP_R is gone or changed shape — the tiles and lists lose their shared definition.');
  }
  if (!/settledAmount:/.test(src)) {
    throw new Error(
      'The refund row no longer ships `settledAmount`. Without it the app has to derive ' +
      '`approvedAmount ?? amountEgp` itself, which is the second copy this fix removed.'
    );
  }
});

// ── 7. "Refunded MTD" buckets in Cairo, like every sibling on the screen ────
check('refundedMTD buckets on the Cairo month, not the UTC month', function () {
  const src = readCode(path.join('src', 'routes', 'api', 'admin.js'));
  if (/refunded_at\s*>=\s*date_trunc\('month',\s*NOW\(\)\)/i.test(src)) {
    throw new Error(
      "A refund window still buckets on date_trunc('month', NOW()) — the UTC month — while every " +
      'other money figure on the Payments screen buckets in Cairo. refunds.refunded_at is ' +
      '`timestamp WITHOUT time zone` holding UTC digits, so it needs the TWO-step ' +
      "AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Cairo' that REFUNDED_AT_CAIRO_R already provides."
    );
  }
});

// ── 8. The manual queue's total is a real COUNT, not the post-LIMIT length ──
check('/manual-queue reports a COUNT(*) total, not cases.length', function () {
  const src = readCode(path.join('src', 'routes', 'api', 'admin.js'));
  const start = src.indexOf("router.get('/manual-queue'");
  const end = src.indexOf("router.post('/manual-queue/:id/approve'");
  const body = src.slice(start, end);
  if (/total:\s*cases\.length/.test(body)) {
    throw new Error(
      'GET /manual-queue still reports `total: cases.length`. The row query is LIMIT 200, so that ' +
      'is the count AFTER the limit — the screen would report exactly 200 forever while the queue ' +
      'kept growing. Run a real COUNT(*) over the same WHERE, as /cases and /events already do.'
    );
  }
  if (!/COUNT\(\*\)::int AS total/.test(body)) {
    throw new Error('GET /manual-queue no longer runs a COUNT(*) for its total.');
  }
  if (!/QUEUE_WHERE/.test(body)) {
    throw new Error(
      'The list and the COUNT no longer share one WHERE fragment. Two copies of the predicate is ' +
      'how the count and the list come to describe different sets — the bug this whole file exists for.'
    );
  }
});
