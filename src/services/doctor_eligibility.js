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

module.exports = { eligibleDoctorClause };
