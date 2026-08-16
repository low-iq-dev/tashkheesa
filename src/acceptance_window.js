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
 * sla_hours, then to standard. `urgency_flag` forces urgent — it is the column
 * the intake form sets and it wins over a stale tier value.
 */
function acceptanceMinutesForOrder(order) {
  if (!order) return ACCEPTANCE_MINUTES_BY_TIER.standard;
  if (order.urgency_flag) return ACCEPTANCE_MINUTES_BY_TIER.urgent;
  const tier = order.tier || order.urgency_tier;
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
