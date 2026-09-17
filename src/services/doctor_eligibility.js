'use strict';

/**
 * Tashkheesa — shared doctor-eligibility SQL fragment (spec §4.6).
 *
 * The single source of truth for the assignment safety gate. Emits the
 * approval + onboarding + service-level-matching predicates every assignment
 * site must apply. Callers KEEP their own specialty / tier / capacity
 * predicates and JOIN this fragment with AND.
 *
 * pending_approval lives HERE, not in the callers. It used to be documented as
 * the caller's job, and the two sweeps that matter never did it:
 * case_sla_worker.buildAlternateDoctorQuery (breach + doctor-timeout
 * reassignment) and workers/acceptance_watcher (missed-acceptance
 * reassignment). So a doctor sitting in the approval queue — signed up, not yet
 * approved by services/admin_doctor_approve.js — was a legal target for every
 * automated reassignment, on exactly the paths that fire when something has
 * already gone wrong with a paid case. Only auto_assign.js, which hand-rolls
 * its own query, had the predicate.
 *
 * (Migration 067_park_unapproved_doctors parks its nine accounts with
 * is_active=false, not pending_approval — that half is already covered by the
 * is_active line above. Its header explains why: the approve flow flips both
 * flags together and pushing those rows back to pending_approval=true would
 * erase approval history. This predicate covers the other population, the
 * genuinely not-yet-approved.)
 *
 * Re-adding it in a caller is harmless (`x = false AND x = false` plans
 * identically), but omitting it is not, so it is emitted unconditionally.
 * COALESCE(..., false): the column is nullable on old rows, and NULL there
 * means "predates the approval queue" = approved.
 *
 * Pure string builder: it does NOT allocate bind params. The caller owns its
 * own $n numbering and passes the placeholder token for the case's service_id
 * (serviceIdParam, e.g. '$3'). alias is the users-table alias (e.g. 'u').
 *
 * Returns a bare fragment — no leading/trailing AND, no outer paren wrapper —
 * so a caller can splice it via `clauses.push(eligibleDoctorClause(...))` or
 * interpolate it directly into a WHERE list.
 */
function eligibleDoctorClause({ alias, serviceIdParam }) {
  const a = String(alias || 'u');
  const p = String(serviceIdParam);
  return (
    `${a}.role = 'doctor' ` +
    `AND COALESCE(${a}.is_active, true) = true ` +
    `AND COALESCE(${a}.is_paused, false) = false ` +
    `AND COALESCE(${a}.pending_approval, false) = false ` +
    `AND COALESCE(${a}.onboarding_complete, false) = true ` +
    `AND EXISTS (SELECT 1 FROM doctor_services ds ` +
    `WHERE ds.doctor_id = ${a}.id AND ds.service_id = ${p})`
  );
}

// Launch gates 2026-09-15 (Task 1) — why a doctor may not take a NEW case.
// Listed in the order doctorNewCaseBlockReason names them.
const DOCTOR_ACCOUNT_BLOCK = Object.freeze({
  NOT_FOUND: 'not_found',
  REJECTED: 'rejected',
  PENDING_APPROVAL: 'pending_approval',
  INACTIVE: 'inactive',
  PAUSED: 'paused',
});

/**
 * The JS form of "may this doctor take a NEW case", for the places that decide
 * it on ONE users row rather than in a WHERE clause: the doctor's own pool
 * accept (routes/doctor.js POST /portal/doctor/case/:caseId/accept) and an
 * operator's hand-pick on POST /superadmin/orders.
 *
 * Account state only, and the same flags, with the same NULL defaults, as the
 * COALESCE predicates of eligibleDoctorClause above:
 *   * is_active is not false         — COALESCE(is_active, true) = true
 *   * is_paused is not true          — COALESCE(is_paused, false) = false
 *   * pending_approval is not true   — COALESCE(pending_approval, false) = false
 *   * not rejected: rejection_reason non-blank after trimming AND is_active IS
 *     NOT TRUE. An operator's explicit is_active = true overrides a stale
 *     reason. The SQL clause has no rejection predicate; both reject flows
 *     (services/admin_doctor_reject.js, superadmin POST .../reject) write
 *     is_active = false with the reason, so on rows they write the two agree —
 *     this adds the legacy is_active NULL + reason row.
 *
 * NOT here, on purpose: role, onboarding_complete, specialty, service match and
 * capacity stay with the caller (onboarding is not required at pool accept or
 * for a hand-pick). And this is never a login or request gate: a paused doctor
 * must still sign in to finish the cases they hold (services/login_gate.js).
 *
 * Only strict comparisons block, so a NULL flag reads as its column default.
 *
 * Which reason is named when several hold: rejected > pending_approval >
 * inactive > paused. This picks the message only; the refused set is the same
 * in any order. It matters because the live writers of the first two also
 * write is_active = false: doctor signup (routes/auth.js: pending_approval =
 * true, is_active = false) and both reject flows (is_active = false with the
 * reason). Checking inactive first told every real pending or rejected doctor,
 * and the operator hand-picking them, "deactivated".
 *
 * @param {object|null} row users row with is_active, is_paused, pending_approval, rejection_reason
 * @returns {string|null} a DOCTOR_ACCOUNT_BLOCK value, or null when the doctor may take a new case
 */
function doctorNewCaseBlockReason(row) {
  if (!row) return DOCTOR_ACCOUNT_BLOCK.NOT_FOUND;
  const reason = row.rejection_reason == null ? '' : String(row.rejection_reason).trim();
  if (reason !== '' && row.is_active !== true) return DOCTOR_ACCOUNT_BLOCK.REJECTED;
  if (row.pending_approval === true) return DOCTOR_ACCOUNT_BLOCK.PENDING_APPROVAL;
  if (row.is_active === false) return DOCTOR_ACCOUNT_BLOCK.INACTIVE;
  if (row.is_paused === true) return DOCTOR_ACCOUNT_BLOCK.PAUSED;
  return null;
}

module.exports = { eligibleDoctorClause, DOCTOR_ACCOUNT_BLOCK, doctorNewCaseBlockReason };
