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
};
