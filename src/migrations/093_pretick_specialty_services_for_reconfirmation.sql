-- 093_pretick_specialty_services_for_reconfirmation.sql
-- ============================================================================
-- Renumbered from 092 on 2026-08-25: origin/main already had a
-- 092_normalise_user_phones.sql that this branch (cut from 3a66298) never saw,
-- and it ran in production at 10:43. Two files sharing a number is not a
-- functional problem — the runner tracks whole filenames — but it is exactly
-- the confusion that hid the fact this file had not run at all.
--
-- 2026-08-25 — pre-tick every service in a doctor's own specialty, so the
-- welcome invite asks them to CONFIRM a filled-in form rather than build one.
--
-- Same reasoning as 089 did for turnaround tiers: an empty form is a task, a
-- pre-filled one is a confirmation, and the second gets answered. The doctor
-- still has to log in and press Save — that is what sets onboarding_complete
-- and what makes them assignable — but they arrive at a page that already
-- reflects what they do.
--
-- ── WHAT THIS ACTUALLY CHANGES (measured against production) ────────────────
--
-- 18 rows across 3 doctors, all Internal Medicine:
--
--     Hassan Hossam            held 0 of 6 own-specialty services  → 6
--     Ahmed Medhat Abdelaziz   held 0 of 6                         → 6
--     Nancy Zakaria Ghoneim    held 0 of 6                         → 6
--
-- Everyone else in a staffed specialty is already complete:
--
--     Cardiology   1 doctor  · 9 of 9
--     OB/GYN       4 doctors · 9 of 9
--     Orthopedics  2 doctors · 11 of 11
--     Radiology    2 doctors · 11 of 11
--     Urology      6 doctors · 9 of 9
--     Internal Med 1 doctor  · 6 of 6   (Ahmed Hamed Gharib)
--
-- So of the 22 active, non-onboarded doctors: 16 were already complete, 3 are
-- fixed here, and 3 are Pediatrics — whose specialty has no service rows at
-- all, so "complete" is vacuous and there is nothing to tick. The backlog was
-- never missing rows. It is that nobody has pressed Save, and only the doctor
-- can do that.
--
-- The lever is therefore the INVITE COPY, not the data: "your services are
-- already set up, just confirm them" is true for every doctor whose specialty
-- is staffed once this runs.
--
-- ── THE THREE DOCTORS THIS FIXES ARE THE INTERESTING ONES ───────────────────
--
-- Two of them hold NONE of their own specialty while holding a large
-- cross-specialty list — Ahmed Medhat 22 rows (Nephrology 8, Lab & Pathology 7,
-- Cardiology 2, Pulmonology 2, Endocrinology 2, Gastro 1) and Nancy Ghoneim 20
-- rows (Lab & Pathology 7, Pulmonology 3, Cardiology 2, Endocrinology 2,
-- Nephrology 2, and one each of Clinical Nutrition, Dermatology, Gastro,
-- Neurology). Hassan Hossam holds a single row.
--
-- Without this migration those three open a form whose FIRST group — their own
-- specialty — is entirely unticked, followed by six foreign groups that are
-- ticked. Confirm what is shown and they are marked onboarding_complete
-- holding zero Internal Medicine services: permanently unassignable for their
-- own specialty, with the nudge banner gone and nothing left to flag it.
-- Every assignment path pairs the doctor_services row with
-- u.specialty_id = order.specialty_id, so those cross-specialty rows can never
-- produce an assignment.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- Does not set onboarding_complete. That flag means the doctor has confirmed
-- their details, specialty and sub-specialties, and it is not ours to assert
-- on their behalf — it is the entire point of asking them to log in.
--
-- Does not remove the cross-specialty rows. Note they are NOT protected by the
-- form's allowed-set logic: loadDoctorServiceCatalog builds allowedIds as
-- (own-specialty-visible ∪ everything already held), so held cross-specialty
-- rows are INSIDE the allowed set, and diffServiceSelection deletes
-- allowed ∩ held ∩ unticked. What actually keeps them is that the loader
-- renders them pre-ticked. Anyone narrowing that union later will silently
-- delete them on the next Save. Raised separately — cleaning them up is a
-- conversation with each doctor, not a migration.
--
-- Does not touch paused or deactivated accounts, or the three Pediatrics
-- doctors — their specialty has zero service rows, so there is nothing to tick
-- and no form for them to confirm. They cannot reach onboarding_complete at
-- all; that is a launch decision, not something SQL can fix.
--
-- pending_approval is NOT in the predicate. It does not need to be today —
-- production has zero doctors in that state, and the self-signup path
-- (routes/auth.js) sets pending_approval together with is_active = false, so
-- the is_active line covers it incidentally. Stated so nobody reads the
-- absence as an oversight.
--
-- ── THE EXCLUDED ACCOUNT ────────────────────────────────────────────────────
--
-- 15821672-… "Test Doctor Ortho" <notreallydrake@gmail.com> is excluded by id.
-- It is a live, active, ONBOARDED Urology account created 2026-08-23 for
-- end-to-end testing, holding one Urology service. Because it is already
-- onboarding_complete, the doctor_services row is the LAST gate in front of
-- it — so pre-ticking would take it from 1 assignable service to 9 and make it
-- the second candidate (of two) on eight real Urology services, reachable by
-- auto_assign, both SLA workers, admin assign and bulk assign.
--
-- Excluding it is the conservative half of the fix. The other half is Ziad's
-- call: this account must be deactivated before launch, or it will be handed a
-- paying patient's case. Not done here because it may still be in use for
-- pre-launch testing, and deactivating a doctor mid-test is not a migration's
-- decision to make.
--
-- ── COMING_SOON ─────────────────────────────────────────────────────────────
--
-- services.coming_soon is derived from doctor_services joined to ACTIVE
-- doctors (services_coming_soon_sync.js), so adding rows can flip a service
-- from coming_soon to bookable. Recomputed the full RESYNC_SQL before and
-- after these rows and diffed: ZERO services change value. Every service they
-- touch already has another active doctor mapped. No catalogue change, so no
-- resync is triggered here.
--
-- IDEMPOTENT via the anti-join. doctor_services is (doctor_id, service_id) PK
-- with no surrogate id column and created_at defaulted — verified against
-- production before writing this, because omitting a NOT NULL id is exactly
-- what nearly boot-looped the platform in 091.
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
   AND u.id <> '15821672-a53a-4fcb-b49a-49e48074b47a'  -- Test Doctor Ortho; see above
   AND NOT EXISTS (
         SELECT 1 FROM doctor_services ds
          WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
       )
ON CONFLICT DO NOTHING;

-- Visibility only — RAISE WARNING, never RAISE EXCEPTION.
--
-- The condition this detects is "a doctor's form shows some boxes unticked."
-- The penalty an EXCEPTION would impose is a permanent boot loop: db.js wraps
-- this file in a transaction (_managesOwnTransaction only matches a literal
-- `BEGIN;` statement, not a PL/pgSQL block opener), so a raise rolls back the
-- INSERT *and* the schema_migrations row, migrate() rejects, server.js exits 1,
-- and the next boot fails identically. There is no version of a half-ticked
-- form that is worse than the platform not booting during launch week.
--
-- It is also racy by construction: READ COMMITTED gives this SELECT a newer
-- snapshot than the INSERT, so any doctor activated by a concurrent
-- admin_doctor_approve in that window counts as short through no fault of the
-- statement above. Expected output on production: 1 (the excluded test
-- account). Anything higher is worth a look, not an outage.
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
    RAISE WARNING
      '093: % doctor(s) still missing at least one visible service in their own specialty (1 expected: the excluded test account)', short;
  END IF;
END $$;
