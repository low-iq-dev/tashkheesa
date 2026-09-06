'use strict';

// src/services/login_gate.js
//
// AUDIT 2026-09-06 (BLOCKER 1) — one place that decides whether a verified
// identity is allowed to become a session.
//
// THE BUG THIS EXISTS TO PREVENT
// ------------------------------
// The portal had the gate written out twice, correctly, at
// src/routes/auth.js:350 (password login) and :529 (web OTP verify) — the
// second one carrying the comment "Replay the SAME post-auth gates as password
// login", which is the tell that this was already known to be copy-paste.
// The two MOBILE paths in src/routes/api/auth.js never got a copy. They went
// straight from "the credential checks out" to generateTokens().
//
// That was not a mobile-only hole. src/auth.js:59 accepts `Authorization:
// Bearer` on the PORTAL, verified with the same JWT_SECRET, and
// src/routes/doctor.js:162 is a bare requireRole('doctor') with no per-request
// status lookup. So a doctor who had been deactivated or rejected could OTP
// into /api/v1/auth/otp/verify, take the returned accessToken, present it as a
// Bearer header to /portal/doctor/*, and have the full doctor portal —
// queue, case detail, accept, diagnosis, report signing, patient PII — with a
// 30-day refresh token to re-mint it indefinitely.
//
// A gate that has to be remembered at four call sites is a gate that will be
// missed at the fifth. Hence one function, one truth, and a test
// (tests/core/login-gate-coverage.test.js) that fails if any handler mints
// tokens or a session without consulting it.
//
// WHY is_paused IS DELIBERATELY NOT HERE
// --------------------------------------
// It looks like an omission and it is not. migrations/040 defines is_paused as
// "active but excluded from open-pool broadcasts. Distinct from is_active
// (which gates login entirely)", and case_sla_worker.js:127 says the same:
// "is_paused gates new-assignment routing only". A paused doctor MUST still be
// able to sign in — that is how they finish the cases already assigned to them
// and how they get themselves unpaused. Blocking login on is_paused would turn
// an automatic SLA-breach pause (3 breaches in 30 days, set with no human in
// the loop) into a silent account lockout. Do not "fix" this.
//
// NULL SEMANTICS
// --------------
// Every check is a STRICT comparison against the blocking value, never a
// truthiness test. users.is_active is `BOOLEAN DEFAULT true` and rows predating
// the column carry NULL, which the routing SQL reads as active via
// COALESCE(u.is_active, true) (doctor.js:125, assign.js:20, auto_assign.js:74).
// A truthy test here would read those NULLs as blocked and lock out the oldest
// doctors on the platform — the opposite failure, and a worse one.

const LOGIN_BLOCKED = Object.freeze({
  PENDING_APPROVAL: 'pending_approval',
  INACTIVE: 'inactive',
});

/**
 * Why this user may not open a session, or null if they may.
 *
 * Call AFTER the credential has been verified (password compared, OTP code
 * confirmed) and BEFORE any token is minted or cookie is set.
 *
 * @param {object|null} user a row from `users`
 * @returns {string|null} a LOGIN_BLOCKED value, or null when login is allowed
 */
function loginBlockReason(user) {
  // No row is not a status decision — it is a failed lookup, and the caller
  // already has its own "invalid credentials" branch for that. Returning a
  // block reason here would let a caller conflate the two and leak which
  // phone numbers and emails exist.
  if (!user) return null;

  // Patients and staff have no approval lifecycle: a patient row is live from
  // the moment OTP signup creates it, and admin/superadmin sign in with a
  // password against rows an operator made by hand. Only doctors carry
  // pending_approval / approved_at / rejection_reason, so only doctors are
  // gated — matching what auth.js:350 and :529 have always done.
  if (String(user.role || '').toLowerCase() !== 'doctor') return null;

  if (user.pending_approval === true) return LOGIN_BLOCKED.PENDING_APPROVAL;
  if (user.is_active === false) return LOGIN_BLOCKED.INACTIVE;

  return null;
}

/** Convenience predicate for call sites that do not need the reason. */
function isLoginAllowed(user) {
  return loginBlockReason(user) === null;
}

module.exports = { LOGIN_BLOCKED, loginBlockReason, isLoginAllowed };
