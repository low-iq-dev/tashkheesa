-- 092_pretick_specialty_services_for_reconfirmation.sql
-- ============================================================================
-- 2026-08-25 — pre-tick every service in a doctor's own specialty, so the
-- welcome invite asks them to CONFIRM a filled-in form rather than build one.
--
-- Same reasoning as 089 did for turnaround tiers: an empty form is a task, a
-- pre-filled one is a confirmation, and the second gets answered. The doctor
-- still has to log in and press Save — that is what sets onboarding_complete
-- and what makes them assignable — but they arrive at a page that already
-- reflects what they do.
--
-- ── WHAT THIS ACTUALLY CHANGES (measured before writing) ────────────────────
--
-- Very little, because it is mostly already true. Of the 22 active,
-- non-onboarded doctors, 18 already carry every visible service in their
-- specialty. The real backlog is not missing service rows — it is that nobody
-- has pressed Save.
--
--   Cardiology   1 doctor  · 9 of 9   already complete
--   OB/GYN       4 doctors · 9 of 9   already complete
--   Orthopedics  2 doctors · 11 of 11 already complete
--   Radiology    2 doctors · 11 of 11 already complete
--   Urology      6 doctors · 9 of 9   already complete
--
-- This migration inserts 26 rows across 4 doctors — chiefly Hassan Hossam
-- (Internal Medicine, holding 1 of 6) and the three Internal Medicine doctors
-- whose lists are large but skip some of their own specialty's services.
--
-- So the lever here is the INVITE COPY, not the data: "your services are
-- already set up, just confirm them" is now true for every doctor with a
-- staffed specialty.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- Does not set onboarding_complete. That flag means the doctor has confirmed
-- their details, specialty and sub-specialties, and it is not ours to assert
-- on their behalf — it is the entire point of asking them to log in. They
-- remain unassignable by auto_assign until they save.
--
-- Does not remove anything. Three Internal Medicine doctors hold services from
-- OTHER specialties (14, 20 and 22 rows against a 6-service specialty) — the
-- Lab & Pathology cross-mapping. Those rows can never produce an assignment
-- (auto_assign requires u.specialty_id = the order's specialty_id), but a
-- migration that quietly deletes a doctor's service list is not the place to
-- resolve that. Raised separately.
--
-- Does not touch paused, deactivated or pending-approval accounts, or the
-- three Pediatrics doctors — their specialty has no visible services at all,
-- so there is nothing to tick and no form for them to confirm.
--
-- Does not touch services outside the doctor's own specialty, or hidden ones.
--
-- ── COMING_SOON ─────────────────────────────────────────────────────────────
--
-- services.coming_soon is derived from doctor_services joined to ACTIVE
-- doctors (services_coming_soon_sync.js), so adding rows can flip a service
-- from coming_soon to bookable. Measured: ZERO services flip, because every
-- service these rows touch already has another active doctor mapped to it.
-- No catalogue change, so no resync is triggered here.
--
-- IDEMPOTENT via the anti-join — doctor_services has a unique constraint on
-- (doctor_id, service_id), and the NOT EXISTS keeps a re-run from relying on it.
-- ============================================================================

INSERT INTO doctor_services (doctor_id, service_id)
SELECT u.id, sv.id
  FROM users u
  JOIN services sv
    ON sv.specialty_id = u.specialty_id
   AND COALESCE(sv.is_visible, true) = true
 WHERE u.role = 'doctor'
   AND COALESCE(u.is_active, true)  = true
   AND COALESCE(u.is_paused, false) = false
   AND u.specialty_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM doctor_services ds
          WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
       )
ON CONFLICT DO NOTHING;

-- Guard: every active, unpaused doctor whose specialty HAS visible services
-- must now hold all of them. A doctor left short would open a half-ticked form
-- and be asked to "confirm" a list that is not what they do — worse than the
-- empty form this replaces.
DO $$
DECLARE short integer;
BEGIN
  SELECT count(*) INTO short
    FROM users u
   WHERE u.role = 'doctor'
     AND COALESCE(u.is_active, true)  = true
     AND COALESCE(u.is_paused, false) = false
     AND u.specialty_id IS NOT NULL
     AND EXISTS (
           SELECT 1 FROM services sv
            WHERE sv.specialty_id = u.specialty_id
              AND COALESCE(sv.is_visible, true) = true
              AND NOT EXISTS (
                    SELECT 1 FROM doctor_services ds
                     WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
                  )
         );
  IF short > 0 THEN
    RAISE EXCEPTION
      '092: % doctor(s) are still missing at least one visible service in their own specialty', short;
  END IF;
END $$;
