// src/services/services_coming_soon_sync.js
//
// Re-sync helper — keeps services.coming_soon truthful. A service is
// coming_soon iff NO doctor who could actually be ASSIGNED it is mapped to it.
//
// 2026-08-25 — this used to test is_active alone, which is a weaker condition
// than the one assignment actually applies. eligibleDoctorClause (see
// services/doctor_eligibility.js, used by auto_assign, case_sla_worker and
// acceptance_watcher) also requires NOT pending_approval AND
// onboarding_complete. Only 8 of 31 doctors are onboarded, so the catalogue
// advertised 79 bookable services while just 29 had anyone who could take
// them. A patient could pay for any of the other 50 — including at the VIP and
// Urgent surcharge — and the case would land in the manual queue with nobody
// notified.
//
// is_paused stays OUT, deliberately: pausing is a short absence, and yanking a
// doctor's whole service list out of the public catalogue every time they take
// a week off would thrash the storefront. That is the documented design §4.3 /
// §10 decision and it is still right. pending_approval and onboarding_complete
// are different in kind — a doctor in either state has never been able to
// receive a case at all, and there is no "they'll be back on Monday" about it.
//
// SELF-HEALING, which is the point: the moment a doctor finishes onboarding and
// ticks their services, this recomputes and the affected services come back on
// sale automatically. Nobody has to remember to unhide anything.
//
// Idempotent: safe to call after any doctor_services change, any change to a
// doctor's is_active / pending_approval / onboarding_complete, and on a
// schedule.
//
// Runs the EXACT design §4.3 UPDATE, unchanged. Accepts an optional pg client
// so a caller can fold the re-sync into its own transaction (atomic with the
// status flip); when omitted it runs a single autocommit statement on the pool.
//
// Callers that own a txn (the Command services admin_doctor_approve /
// admin_doctor_pause) pass their client so the recompute commits/rolls-back
// atomically with the write. Web routes (superadmin.js, execute()/pool
// autocommit) call it with no client, post-commit + best-effort.

'use strict';

const { pool } = require('../pg');

// Mirrors eligibleDoctorClause() minus the is_paused test — see the note above
// for why that one is deliberately absent. COALESCE on every nullable column
// for the same reason the shared clause does it: NULL on an old row means the
// column predates the gate, i.e. "not blocked".
const RESYNC_SQL = `
  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id
      AND u.role = 'doctor'
      AND COALESCE(u.is_active, true) = true
      AND COALESCE(u.pending_approval, false) = false
      AND COALESCE(u.onboarding_complete, false) = true
  )`;

/**
 * Recompute services.coming_soon for every service.
 * @param {import('pg').PoolClient} [client] optional txn client; pool if omitted
 * @returns {Promise<import('pg').QueryResult>}
 */
async function resyncComingSoon(client) {
  const runner = client || pool;
  return runner.query(RESYNC_SQL);
}

module.exports = { resyncComingSoon };
