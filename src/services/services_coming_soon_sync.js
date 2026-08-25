// src/services/services_coming_soon_sync.js
//
// Re-sync helper — keeps services.coming_soon truthful. A service is
// coming_soon iff it has NO active doctor mapped to it. Keyed on
// users.is_active (NOT is_paused — pausing a doctor must not hide a service
// from the catalogue; see design §4.3 / §10). Idempotent: safe to call after
// any doctor_services change or any change to a doctor's is_active.
//
// 2026-08-25 — this was briefly widened to also require NOT pending_approval
// AND onboarding_complete, on the reasoning that those doctors cannot be
// assigned a case. That reasoning was WRONG and the change was reverted before
// it shipped. buildPortalCasesUnassigned (routes/doctor.js) filters the
// doctor's unassigned queue on users.specialty_id alone, and
// POST /portal/doctor/case/:id/accept never consults eligibleDoctorClause — so
// a doctor who has not finished onboarding still SEES paid cases in their
// specialty and can still accept them. Combined with case broadcast (which now
// matches on specialty_id too), those services are deliverable.
//
// Only auto_assign and the SLA workers apply the stricter gate, and
// auto_assign is disabled in production anyway. Withdrawing 50 of 79 bookable
// services — three of the six visible specialties, down to zero each — is a
// commercial decision about what to sell, not a correctness fix, and it does
// not belong in this helper.
//
// The real defect that prompted it is fixed where it lives: step 3 of the
// wizard rendered coming_soon services as clickable cards that its own POST
// then rejected. See routes/patient.js.

'use strict';

const { pool } = require('../pg');

// Runs the EXACT design §4.3 UPDATE, unchanged.
const RESYNC_SQL = `
  UPDATE public.services sv
  SET coming_soon = NOT EXISTS (
    SELECT 1 FROM public.doctor_services ds
    JOIN public.users u ON u.id = ds.doctor_id
    WHERE ds.service_id = sv.id
      AND u.role = 'doctor' AND u.is_active = true
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
