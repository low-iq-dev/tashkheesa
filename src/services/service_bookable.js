// src/services/service_bookable.js
//
// ONE definition of "a patient may order this service".
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
//
// 2026-08-25. "Bookable" was two predicates on `services` — is_visible AND NOT
// coming_soon — and specialty visibility was a JOIN that each call site
// remembered or forgot on its own. Most forgot.
//
// Measured against production the day this was written: 24 services passed the
// service-level check while sitting under a specialty an operator had
// deliberately hidden. Nephrology was 8 of them — hidden in migration 087
// precisely BECAUSE it has no doctor — fully priced and orderable through
// POST /api/v1/cases, listed by GET /api/v1/services, and named to anonymous
// visitors by the unauthenticated /api/help-me-choose. A patient could pay for
// a nephrology second opinion that could never reach a doctor. The other 16
// were Lab & Pathology, Pulmonology, Endocrinology, Clinical Nutrition,
// Dermatology, Gastroenterology and Neurology.
//
// Only the web wizard's step-3 POST had the join. Hiding a specialty therefore
// worked on exactly one of the paths that can create a paid order.
//
// So the specialty check moved INTO the predicate, as a correlated EXISTS
// rather than a JOIN. A JOIN has to be remembered in the FROM clause; an EXISTS
// travels with the WHERE fragment, so a caller cannot take the bookability rule
// and leave the specialty rule behind.
//
// ── NULL HANDLING ───────────────────────────────────────────────────────────
//
// COALESCE(is_visible, true) on both tables, matching what the wizard already
// did — an unset flag means visible, because that is what every older row that
// predates the column means.
//
// A service whose specialty_id is NULL or dangling fails the EXISTS and is NOT
// bookable. That is deliberate: auto_assign matches on specialty_id, so such a
// service could be paid for and never routed. Production has zero of them
// (checked: 0 null specialty_id, 0 orphans), so this changes nothing today.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not an eligibility check. Whether a DOCTOR can take the case is
// doctor_eligibility.js, which is a different and stricter question
// (onboarding_complete, capacity, tier). A service can be perfectly bookable
// and still have no one to serve it — coming_soon keys on is_active alone, not
// on onboarding.
'use strict';

/**
 * SQL fragment for "a patient may order this service".
 *
 * Inline it in a WHERE clause. Requires no JOIN — the specialty test is a
 * correlated subquery, and it aliases the specialties table `sp_bookable_` so
 * it cannot collide with a caller that already joins `sp`.
 *
 * @param {string} [alias] table alias for `services` in the caller's query
 * @returns {string} SQL boolean expression, safe to concatenate (no user input)
 */
function serviceBookableClause(alias) {
  const sv = alias ? `${alias}.` : '';
  // Parenthesised as a whole. Every caller today concatenates with AND, where
  // it would be fine bare — but one future `WHERE ${BOOKABLE} OR ...` would
  // silently bind only the last conjunct and lose the rule, which is the exact
  // class of failure this module exists to end.
  return (
    `(COALESCE(${sv}is_visible,true)=true` +
    ` AND COALESCE(${sv}coming_soon,false)=false` +
    ` AND EXISTS (SELECT 1 FROM specialties sp_bookable_` +
    ` WHERE sp_bookable_.id = ${sv}specialty_id` +
    ` AND COALESCE(sp_bookable_.is_visible, true) = true))`
  );
}

/**
 * NEARLY the same rule, applied to rows already in hand.
 *
 * For callers that have fetched the row and want the decision in JS —
 * case_intake_pricing.js does this so it can distinguish which half failed.
 *
 * IT IS NOT IDENTICAL TO THE SQL, and the difference matters. The SQL EXISTS
 * fails a service whose specialty_id is NULL or dangling; this function cannot
 * see that, because a LEFT JOIN that misses hands it `null`, which COALESCE
 * semantics read as visible. A caller using this MUST test for a missing
 * specialty row itself — case_intake_pricing.js does, via specialty_exists.
 *
 * `specialtyIsVisible` is REQUIRED. Passing undefined throws rather than
 * quietly skipping the specialty rule: the entire point of this module is that
 * the rule cannot be left behind, and an optional argument is precisely how it
 * would be. Pass the value from the specialties row, or null if the row is
 * genuinely absent — and handle absence yourself before calling.
 *
 * @param {{is_visible?: any, coming_soon?: any}|null} service
 * @param {boolean|null} specialtyIsVisible
 * @returns {{bookable: boolean, reason: string|null}}
 * @throws {TypeError} when specialtyIsVisible is omitted
 */
function isServiceBookable(service, specialtyIsVisible) {
  if (arguments.length < 2 || specialtyIsVisible === undefined) {
    throw new TypeError(
      'isServiceBookable(service, specialtyIsVisible): specialtyIsVisible is ' +
      'required — pass the specialties row value, or null if there is no row'
    );
  }
  if (!service) return { bookable: false, reason: 'missing' };
  const visible = service.is_visible == null ? true : !!service.is_visible;
  if (!visible) return { bookable: false, reason: 'service_hidden' };
  const comingSoon = service.coming_soon == null ? false : !!service.coming_soon;
  if (comingSoon) return { bookable: false, reason: 'coming_soon' };
  const specVisible = specialtyIsVisible == null ? true : !!specialtyIsVisible;
  if (!specVisible) return { bookable: false, reason: 'specialty_hidden' };
  return { bookable: true, reason: null };
}

module.exports = { serviceBookableClause, isServiceBookable };
