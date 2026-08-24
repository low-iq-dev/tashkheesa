-- 087_hide_nephrology_no_doctors.sql
-- ============================================================================
-- 2026-08-24 — Nephrology is bookable and has no doctor.
--
-- Not "no onboarded doctor" — no user row with role='doctor' and
-- specialty_id='spec-nephrology' exists at all. Meanwhile the specialty is
-- is_visible=true with 8 visible services, so the wizard offers all eight, the
-- patient completes it, pays, and auto_assign returns no_doctors_available
-- (src/auto_assign.js). The order parks at assignment_status='manual_pending'
-- and nobody is notified. The patient has paid for a review that cannot happen.
--
-- Every other specialty in this position is already hidden — Dermatology,
-- Endocrinology, Gastroenterology, Hematology, Neurology, Ophthalmology and
-- Pulmonology all carry visible services behind is_visible=false for exactly
-- this reason. Nephrology is the one that was left on.
--
-- The services stay as they are. Hiding the specialty removes it from the
-- wizard (routes/patient.js filters the specialty list on is_visible), which is
-- the whole fix; touching the service rows would mean undoing it service by
-- service later.
--
-- REVERSIBLE, and intended to be reversed: the moment a nephrologist is
-- onboarded, flip this back with
--     UPDATE specialties SET is_visible = true WHERE id = 'spec-nephrology';
--
-- IDEMPOTENT — re-running matches nothing once applied.
-- ============================================================================

UPDATE specialties
   SET is_visible = false
 WHERE id = 'spec-nephrology'
   AND is_visible = true
   AND NOT EXISTS (
         SELECT 1 FROM users u
          WHERE u.role = 'doctor'
            AND u.specialty_id = specialties.id
       );

-- Deliberately NOT a hard guard: if someone onboards a nephrologist between
-- this file being written and it being applied, the NOT EXISTS above makes the
-- statement a no-op and the specialty correctly stays visible. That is the
-- desired outcome, not a failure.
