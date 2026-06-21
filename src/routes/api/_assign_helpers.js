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
 * All functions are pure (no DB, no I/O) EXCEPT acceptByIso, which reads the
 * wall clock (Date.now) — same as it always did.
 */

'use strict';

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
// Doctor sla_tiers_supported uses standard/priority/urgent; an order's tier is
// standard/urgent/vip(/fast_track). Map for the ADVISORY tier flag (not a gate).
function doctorSupportsTier(slaTiers, orderTier) {
  const x = String(orderTier || 'standard').toLowerCase();
  const want = x === 'vip' || x === 'fast_track' ? 'priority' : x;
  let arr = slaTiers;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (_) { arr = null; }
  }
  if (!Array.isArray(arr)) arr = ['standard'];
  return arr.map((s) => String(s).toLowerCase()).includes(want);
}
// Capacity is by tier: urgent cases count against max_active_cases_urgent.
function capFor(doctor, orderTier) {
  const urgent = String(orderTier || '').toLowerCase() === 'urgent';
  const cap = Number(urgent ? doctor.max_active_cases_urgent : doctor.max_active_cases);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}
// Doctor acceptance window (mirrors case_lifecycle.assignDoctor): 30m urgent /
// 4h fast-track / 24h standard. Stored on the doctor_assignments row.
function acceptByIso(slaHours) {
  const h = Number(slaHours) || 72;
  const win = h <= 4 ? 0.5 : h <= 24 ? 4 : 24;
  return new Date(Date.now() + Math.max(1, Math.floor(win * 60)) * 60000).toISOString();
}

module.exports = {
  STATUS_ALIASES,
  STATUS_RAW,
  TIER_RAW,
  normalizeStatus,
  normalizeTier,
  doctorSupportsTier,
  capFor,
  acceptByIso,
};
