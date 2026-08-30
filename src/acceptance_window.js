'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE WINDOW — how long a doctor has to accept a case before it is
// taken off them and offered to someone else.
//
// THE SINGLE SOURCE OF TRUTH. Before this file existed there were three
// independent answers to the same question, and none of them agreed:
//
//   notify/broadcast.js TIER_CONFIG   urgent 10m  / vip 60m / standard 240m
//   case_lifecycle.js   (inline)      urgent 30m  / vip  4h / standard 24h
//   case_sla_worker.js  (env default) —                       standard 24h
//
// A case broadcast under the first table and assigned under the second had two
// different acceptance deadlines live at once, so which one won depended on
// which worker happened to sweep first.
//
// ── Why these numbers ────────────────────────────────────────────────────────
//
// The SLA clock starts at ACCEPTANCE (deadline_at is NULL until a doctor
// accepts). So the acceptance window is NOT taken out of the doctor's working
// time — it is added, in full, to the patient's total wait on top of the
// turnaround they paid for. That is the constraint that sets these values:
//
//   tier      SLA     accept window   worst-case patient wait
//   urgent     4h        15 min             4h 15m
//   vip       18h        45 min            18h 45m
//   standard  48h         2h               50h
//
// Standard = 2h is the business decision (Ziad, 2026-08-16). Urgent and VIP are
// scaled from it against the promise each tier makes: a 2h window on a 4h
// urgent case would add 50% to a turnaround the patient paid a premium to
// compress, which defeats the product. 15 minutes is the practical floor — a
// doctor has to see a WhatsApp and open the app.
//
// If you widen these, widen the patient-facing turnaround copy with them.
// ─────────────────────────────────────────────────────────────────────────────

const ACCEPTANCE_MINUTES_BY_TIER = Object.freeze({
  urgent: 15,
  vip: 45,
  standard: 120,
});

// Legacy tier spellings that still appear on un-migrated rows.
const TIER_ALIASES = Object.freeze({
  fast_track: 'vip',
  fasttrack: 'vip',
  '24hr': 'vip',
  normal: 'standard',
  regular: 'standard',
  '': 'standard',
});

function normalizeTier(tier) {
  const key = String(tier || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const resolved = TIER_ALIASES[key] || key;
  return Object.prototype.hasOwnProperty.call(ACCEPTANCE_MINUTES_BY_TIER, resolved)
    ? resolved
    : 'standard';
}

/** Minutes a doctor has to accept a case of this tier. */
function acceptanceMinutesForTier(tier) {
  return ACCEPTANCE_MINUTES_BY_TIER[normalizeTier(tier)];
}

/**
 * Same, derived from the case's SLA hours when the tier column is missing or
 * junk. Buckets on the canonical tiers (urgent 4h / vip 18h / standard 48h).
 */
function acceptanceMinutesForSlaHours(slaHours) {
  const h = Number(slaHours);
  if (!Number.isFinite(h) || h <= 0) return ACCEPTANCE_MINUTES_BY_TIER.standard;
  if (h <= 4) return ACCEPTANCE_MINUTES_BY_TIER.urgent;
  if (h <= 24) return ACCEPTANCE_MINUTES_BY_TIER.vip;
  return ACCEPTANCE_MINUTES_BY_TIER.standard;
}

/**
 * Resolve from a whole order row: prefer the explicit tier, fall back to
 * sla_hours, then to standard.
 *
 * DO NOT re-add an `if (order.urgency_flag) return ...urgent` short-circuit.
 * `urgency_flag` does NOT mean "urgent tier" — every writer sets it to mean
 * "not standard" (services/wizard_pricing.js:118 sets it for vip AND urgent;
 * routes/api/cases.js does the same). While that line existed, the tier branch
 * below was unreachable for every non-standard order and VIP cases were given
 * the 15-minute urgent window instead of 45 — a 16× tightening against the
 * pre-change 4h, on the tier that pays a premium for attention.
 *
 * The tier columns are the only honest signal: `urgency_tier` is written by the
 * wizard and the mobile API at order creation — the moment the patient chooses
 * and pays for the tier — while `tier` is written LATER, and only by
 * notify/broadcast.js. When both are missing, sla_hours buckets to the same
 * three tiers.
 *
 * ── ORDER OF PREFERENCE: urgency_tier FIRST. ────────────────────────────────
 *
 * AUDIT 2026-08-30. This read `order.tier || order.urgency_tier`. orders.tier
 * carries DEFAULT 'standard' from migration 010 and is only overwritten once a
 * case has been broadcast — so on every order in production (39 of 39, none
 * NULL) it read 'standard', which is TRUTHY, so the `||` never reached
 * urgency_tier at all. An urgent case that had not yet been broadcast was
 * handed the STANDARD acceptance window instead of the 15-minute urgent one,
 * on the tier that pays the largest premium for speed.
 *
 * The earlier fix (F6, in workers/acceptance_watcher.js) assumed the failure
 * mode was `tier` arriving NULL and fell through correctly for that. A DEFAULT
 * makes it non-null and wrong instead of null and absent, which no `||` can
 * detect. Preferring the creation-time column removes the whole class:
 * urgency_tier is written when the money is taken, tier is a later derivative
 * of it, and migration 105 backfills the rows where they already disagree.
 */
function acceptanceMinutesForOrder(order) {
  if (!order) return ACCEPTANCE_MINUTES_BY_TIER.standard;
  const tier = order.urgency_tier || order.tier;
  if (tier) return acceptanceMinutesForTier(tier);
  return acceptanceMinutesForSlaHours(order.sla_hours);
}

/** ISO deadline `minutes` from now (or from `fromMs`). */
function acceptanceDeadlineIso(minutes, fromMs) {
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  return new Date(base + Math.max(1, Math.floor(minutes)) * 60 * 1000).toISOString();
}

module.exports = {
  ACCEPTANCE_MINUTES_BY_TIER,
  normalizeTier,
  acceptanceMinutesForTier,
  acceptanceMinutesForSlaHours,
  acceptanceMinutesForOrder,
  acceptanceDeadlineIso,
};
