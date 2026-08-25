-- 090_resync_coming_soon_against_real_eligibility.sql
-- ============================================================================
-- 2026-08-25 — stop selling 50 services nobody can be assigned.
--
-- services.coming_soon is recomputed by services/services_coming_soon_sync.js,
-- which until today tested `u.is_active = true` and nothing else. The gate that
-- decides whether a doctor can actually RECEIVE a case — eligibleDoctorClause
-- in services/doctor_eligibility.js, used by auto_assign, case_sla_worker and
-- acceptance_watcher — additionally requires NOT pending_approval AND
-- onboarding_complete.
--
-- Only 8 of 31 doctors are onboarded, so the two conditions disagree wildly:
-- the storefront advertised 79 bookable services while just 29 had anyone who
-- could take them. A patient could pay for any of the other 50 — including at
-- the VIP (18h) or Urgent (4h) surcharge — and auto_assign would answer
-- no_doctors_available, parking the paid order at manual_pending with no
-- notification to anyone.
--
-- The accompanying commit fixes the recompute. This migration applies it once,
-- because nothing recomputes on boot: the sync only runs when a doctor is
-- approved, paused, edited, or saves their own services. Without this the 50
-- stay on sale until somebody happens to trigger one of those.
--
-- EXPECT 79 → 29 BOOKABLE. That is not a regression, it is the catalogue
-- finally telling the truth. And it reverses itself: the moment a doctor
-- finishes onboarding and ticks their services, POST /portal/doctor/services
-- re-runs the sync in the same transaction and their services come back on
-- sale automatically. Nobody has to remember to unhide anything.
--
-- is_paused is deliberately NOT part of the test — pausing is a short absence
-- and should not thrash the public catalogue. Design §4.3 / §10.
--
-- IDEMPOTENT: a plain recompute, safe to re-run at any time.
-- ============================================================================

UPDATE public.services sv
   SET coming_soon = NOT EXISTS (
         SELECT 1
           FROM public.doctor_services ds
           JOIN public.users u ON u.id = ds.doctor_id
          WHERE ds.service_id = sv.id
            AND u.role = 'doctor'
            AND COALESCE(u.is_active, true)          = true
            AND COALESCE(u.pending_approval, false)  = false
            AND COALESCE(u.onboarding_complete, false) = true
       );

-- Guard: no service may be bookable without at least one assignable doctor.
-- This is the whole invariant — if it does not hold after the UPDATE, the
-- recompute and the assignment gate have drifted apart again and patients can
-- buy something nobody can deliver.
DO $$
DECLARE orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned
    FROM public.services sv
   WHERE COALESCE(sv.is_visible, true) = true
     AND COALESCE(sv.coming_soon, false) = false
     AND NOT EXISTS (
           SELECT 1
             FROM public.doctor_services ds
             JOIN public.users u ON u.id = ds.doctor_id
            WHERE ds.service_id = sv.id
              AND u.role = 'doctor'
              AND COALESCE(u.is_active, true)            = true
              AND COALESCE(u.pending_approval, false)    = false
              AND COALESCE(u.onboarding_complete, false) = true
         );
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      '090: % visible service(s) are still bookable with no assignable doctor', orphaned;
  END IF;
END $$;
