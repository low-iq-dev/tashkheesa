/**
 * Tashkheesa Command — shared pure helpers for the admin /cases endpoints.
 *
 * Extracted verbatim from routes/api/admin.js so the single-assign write
 * (POST /cases/:id/assign), the candidates picker, the queue/detail readers,
 * and the bulk-auto-assign write (services/admin_bulk_assign.js) all share ONE
 * source of truth for status/tier normalization, tier-support, capacity, and
 * the doctor acceptance window. No behavior change — these are the exact
 * definitions that previously lived inline in admin.js.
 *
 * All functions are pure (no DB, no I/O) EXCEPT acceptByIsoForOrder, which
 * reads the wall clock (Date.now) — same as it always did.
 */

'use strict';

const { acceptanceMinutesForOrder, acceptanceDeadlineIso } = require('../../acceptance_window');

// ── status normalization ───────────────────────────────────────
// Prod stores legacy LOWERCASE statuses (e.g. 'in_progress'); case_lifecycle's
// canonical set is uppercase (IN_REVIEW). Fold both to one canonical lowercase
// key so the queue's filters + badge system have a single vocabulary.
const STATUS_ALIASES = {
  draft: 'draft',
  submitted: 'submitted',
  paid: 'paid',
  assigned: 'assigned',
  in_progress: 'in_review',
  in_review: 'in_review',
  rejected_files: 'rejected_files',
  completed: 'completed',
  sla_breach: 'sla_breach',
  breached: 'sla_breach',
  reassigned: 'reassigned',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired_unpaid: 'expired_unpaid',
  expired: 'expired_unpaid',
};
function normalizeStatus(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return STATUS_ALIASES[k] || k || 'unknown';
}
// canonical key -> the raw DB values that fold into it (for status filtering).
const STATUS_RAW = Object.entries(STATUS_ALIASES).reduce((m, [raw, canon]) => {
  (m[canon] = m[canon] || []).push(raw);
  return m;
}, {});

const TIER_RAW = { standard: ['standard'], urgent: ['urgent'], vip: ['vip', 'fast_track'] };
function normalizeTier(raw) {
  const t = String(raw || 'standard').trim().toLowerCase();
  return t === 'fast_track' ? 'vip' : t || 'standard';
}

// ── AUDIT-PREDICATE-PARITY (2026-08-29) — the status sets, defined ONCE ─────
//
// THE RECURRING BUG IN THIS CODEBASE IS "A CHIP COUNTS ONE THING AND THE LIST
// IT OPENS FILTERS ANOTHER". Every instance found so far has the same shape: a
// status tuple written inline in one query and re-typed, slightly differently,
// in the query behind the tile that links to it. Verified pairs, all live:
//
//   * GET /cases `breached` FACET used 5 statuses; the ?breached=1 LIST and the
//     /pulse tile used the 9 below. Badge said 0, the list it opened showed 2.
//   * GET /cases `unassigned` FACET used ('paid','reassigned'); the list used
//     the 9. Badge said 0, the list showed 1.
//   * Doctor "load" had THREE spellings in routes/api/admin.js alone
//     (/doctors, /cases/:id, /cases/:id/candidates), one of them missing
//     'refunded', and all three written as an EXCLUSION list — so a 'draft' or
//     'DRAFT' row (production has one) counted against a doctor's capacity.
//
// The cure is not to re-type them more carefully. It is that there is exactly
// one definition and every facet, list and tile interpolates it. Everything
// below is that definition; tests/lint/kpi-predicates-shared.test.js fails the
// build if a partial status tuple is hand-written next to one of these again.
//
// ACTIVE_STATUS_LIST is the RAW lowercase spellings as they appear in
// orders.status — including both spellings of SLA breach ('sla_breach' is
// canonical, 'breached' is the legacy one still in the table) and
// 'in_progress'/'in_review'. Comparisons ALWAYS fold case: orders.status is
// written in BOTH cases by different paths (see
// tests/lint/status-comparisons-fold-case.test.js).
const ACTIVE_STATUS_LIST = Object.freeze([
  'paid', 'in_progress', 'in_review', 'submitted', 'assigned',
  'rejected_files', 'sla_breach', 'breached', 'reassigned',
]);

// The same set expressed as the canonical keys normalizeStatus() produces, for
// the JS side of a payload (a row flag must agree with the SQL facet that
// counts it, and the row's status has already been normalized by then).
const ACTIVE_STATUS_KEYS = Object.freeze(
  new Set(ACTIVE_STATUS_LIST.map(normalizeStatus))
);

// SQL tuple literal, e.g. ('paid','in_progress',…). Safe to interpolate: the
// values are this module's own constants and never carry user text.
function sqlTuple(list) {
  return '(' + list.map((s) => "'" + s + "'").join(',') + ')';
}
const ACTIVE_STATUSES = sqlTuple(ACTIVE_STATUS_LIST);

// Case-folded reference to orders.status. `p` is the column prefix — 'o.' when
// the query aliases the table, '' when it does not.
function statusExpr(p) {
  return `LOWER(COALESCE(${p || ''}status, ''))`;
}

// "Open work": not finished, and in one of the active statuses. This is the
// /pulse "Active cases" definition, the ?active=1 filter, and the base of every
// predicate below — so a case can never be inside one and outside another.
function activeCaseSql(p) {
  const c = p || '';
  return `${c}completed_at IS NULL AND ${statusExpr(c)} IN ${ACTIVE_STATUSES}`;
}

// Active AND past its SLA deadline. ::timestamptz makes it an INSTANT
// comparison regardless of whether the column is naive on a given deploy.
function breachedCaseSql(p) {
  const c = p || '';
  return `${activeCaseSql(c)} AND ${c}deadline_at IS NOT NULL AND ${c}deadline_at::timestamptz < NOW()`;
}

// Active AND nobody is holding it.
function unassignedCaseSql(p) {
  const c = p || '';
  return `${c}doctor_id IS NULL AND ${activeCaseSql(c)}`;
}

// A doctor's CURRENT LOAD, i.e. the open cases counted against their cap.
//
// Deliberately an INCLUSION list built from ACTIVE_STATUS_LIST, replacing the
// three hand-written `NOT IN ('completed','cancelled','expired_unpaid'[,
// 'refunded'])` exclusions. An exclusion list counts every status nobody
// remembered to exclude — which is how an abandoned 'draft' cart (and the
// uppercase 'DRAFT' spelling, which the old lists did not even fold) came to
// occupy a slot in a doctor's capacity. The load a picker SHOWS and the load
// the assign gate ENFORCES are now the same expression.
function doctorLoadSql(p) {
  return activeCaseSql(p);
}

// ── SLA hit-rate, numerator and denominator from ONE predicate ──────────────
//
// The denominator used to be every row with completed_at. services/
// refund_closure.js stamps completed_at when it closes a REFUNDED order, so
// every refund landed in a doctor's SLA denominator as a missed deadline —
// verified in production: one doctor's denominator was 2, of which one row was
// status='refunded'. The numerator additionally required deadline_at IS NOT
// NULL while the denominator did not, so a completion with no SLA clock was
// counted as a miss it could not possibly have hit.
//
// Both sides are now the SAME predicate — a genuine completion, with a real
// deadline — and the numerator is that predicate AND on-time. They cannot drift
// apart because the numerator is literally built from the denominator.
const COMPLETED_STATUSES = sqlTuple(['completed']);
function slaCountableCompletionSql(p) {
  const c = p || '';
  return `${c}completed_at IS NOT NULL AND ${c}deadline_at IS NOT NULL`
    + ` AND ${statusExpr(c)} IN ${COMPLETED_STATUSES}`;
}
function slaHitRatioSql(p) {
  const c = p || '';
  const den = slaCountableCompletionSql(c);
  return `COUNT(*) FILTER (WHERE ${den}`
    + ` AND ${c}completed_at::timestamptz <= ${c}deadline_at::timestamptz)::float`
    + ` / NULLIF(COUNT(*) FILTER (WHERE ${den}), 0)`;
}

// ── /assign helpers (pure) ─────────────────────────────────────
// 2026-08-24 — accepts BOTH spellings of the middle tier.
//
// This used to translate the order's tier one way only: vip → 'priority',
// because that is what users.sla_tiers_supported held. Migration 086
// normalises the column to 'vip', which would have inverted the bug — a
// freshly normalised doctor would stop matching here even though the
// assignment gate matched them fine. And it was already broken in the other
// direction before that: the doctor signup form has always POSTed 'vip'
// (views/doctor_signup.ejs:326) and validators/doctor_signup.js rejects
// 'priority' outright, so every doctor who signed up through the live form was
// shown as NOT supporting a VIP case they were perfectly eligible for.
//
// Matching the synonym set rather than translating means the badge stays
// correct whichever spelling a row happens to carry, before or after the
// migration. Mirrors tierSpellings() in src/auto_assign.js — keep the two in
// sync if a tier is ever added.
const TIER_SPELLINGS = {
  vip:        ['vip', 'priority', 'fast_track'],
  fast_track: ['vip', 'priority', 'fast_track'],
  priority:   ['vip', 'priority', 'fast_track'],
  standard:   ['standard'],
  urgent:     ['urgent']
};
function doctorSupportsTier(slaTiers, orderTier) {
  const x = String(orderTier || 'standard').trim().toLowerCase() || 'standard';
  const accepted = TIER_SPELLINGS[x] || [x];
  let arr = slaTiers;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (_) { arr = null; }
  }
  if (!Array.isArray(arr)) arr = ['standard'];
  const have = arr.map((s) => String(s).toLowerCase());
  return accepted.some((want) => have.includes(want));
}
// Capacity is by tier: urgent cases count against max_active_cases_urgent.
function capFor(doctor, orderTier) {
  const urgent = String(orderTier || '').toLowerCase() === 'urgent';
  const cap = Number(urgent ? doctor.max_active_cases_urgent : doctor.max_active_cases);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}
// AUDIT-2026-08-22 — this was `acceptByIso(slaHours)`, carrying its own
// 30m / 4h / 24h table plus a `|| 72` default. It was the FOURTH live answer to
// "how long does a doctor have to accept?", and the one that mattered most: it
// writes doctor_assignments.accept_by_at, the column case_sla_worker's
// fetchDoctorTimeouts actually enforces. It disagreed with the consolidated
// src/acceptance_window.js on every tier — urgent 30m vs 15m, VIP 4h vs 45m,
// standard 24h vs 2h — so a case assigned from the Command app was held to a
// window nothing else in the system agreed with. VIP was the worst: a 4-hour
// acceptance window bolted onto an 18-hour SLA, against a 45-minute policy.
//
// It takes the whole ORDER rather than a bare sla_hours because the tier is the
// honest signal and it lives in `tier || urgency_tier` (notify/broadcast.js
// writes `tier`; the wizard and the mobile API write `urgency_tier`); sla_hours
// is only the fallback bucket. Callers MUST select tier, urgency_tier and
// sla_hours — selecting fewer silently degrades every case to `standard`
// (120 min), which is 8× policy on an urgent case.
function acceptByIsoForOrder(order) {
  return acceptanceDeadlineIso(acceptanceMinutesForOrder(order));
}

module.exports = {
  STATUS_ALIASES,
  STATUS_RAW,
  TIER_RAW,
  normalizeStatus,
  normalizeTier,
  doctorSupportsTier,
  capFor,
  acceptByIsoForOrder,
  // AUDIT-PREDICATE-PARITY — the one definition of each status set, plus the
  // SQL fragments built from it. Every facet, list and tile interpolates these.
  ACTIVE_STATUS_LIST,
  ACTIVE_STATUS_KEYS,
  ACTIVE_STATUSES,
  statusExpr,
  activeCaseSql,
  breachedCaseSql,
  unassignedCaseSql,
  doctorLoadSql,
  slaCountableCompletionSql,
  slaHitRatioSql,
};
