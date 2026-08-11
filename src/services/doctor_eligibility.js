'use strict';

/**
 * Tashkheesa — shared doctor-eligibility SQL fragment (spec §4.6).
 *
 * The single source of truth for the assignment safety gate. Emits the
 * onboarding + service-level-matching predicates every assignment site must
 * apply. Callers KEEP their own specialty / tier / capacity / pending_approval
 * predicates and JOIN this fragment with AND.
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
    `AND COALESCE(${a}.onboarding_complete, false) = true ` +
    `AND EXISTS (SELECT 1 FROM doctor_services ds ` +
    `WHERE ds.doctor_id = ${a}.id AND ds.service_id = ${p})`
  );
}

module.exports = { eligibleDoctorClause };
