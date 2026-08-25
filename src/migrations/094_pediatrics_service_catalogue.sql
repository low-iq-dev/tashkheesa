-- 094_pediatrics_service_catalogue.sql
-- ============================================================================
-- 2026-08-25 — give Pediatrics a catalogue, so its three doctors can onboard.
--
-- Ahmed Hegazy, Reem Sabry and Yomna Mohsen are active Pediatrics doctors with
-- welcome invites pending. spec-pediatrics had ZERO service rows — not hidden
-- ones, none — so their catalogue union was empty, resolveDoctorLanding sent
-- them to the dashboard instead of the services page, and the services page
-- rendered "your services are being finalised" with no form. onboarding_complete
-- is only ever written by that form's POST, so all three were structurally
-- incapable of finishing onboarding, and no invite copy could fix it.
--
-- ── PRICING: NO service_regional_prices ROWS, AND THAT IS THE PATTERN ───────
--
-- Of the six live specialties, only Cardiology (9 of 9) and Radiology (11 of
-- 11) carry EG rows. Internal Medicine, OB/GYN, Orthopedics and Urology — 35
-- visible services — carry none, and their Egyptian patients pay
-- services.base_price via the COALESCE in routes/patient.js.
--
-- The split is not arbitrary. Where an EG row exists, hospital_cost is the
-- price of the underlying investigation (Chest X-Ray 550, Brain MRI 3200,
-- Echo 1200) and the patient pays that x 1.15. That only means something for
-- IMAGING and TRACING reads, where a scan with its own price exists. Pediatrics
-- as catalogued here is consultative — growth charts, asthma management, whole
-- case review — with no underlying priced investigation to mark up, exactly
-- like Internal Medicine.
--
-- So: base_price only, on the platform's three standard bands, which carry the
-- international ladder already (1600 -> USD 120 / GBP 150 / AED-SAR-QAR 449 /
-- KWD 35 / BHD-OMR 45; 2400 -> 200 / 250 / 749 / 59 / 75; 3500 -> 350 / 400 /
-- 1199 / 95 / 119). Those come from the band, not from a per-service row, so
-- nothing further is needed for the eight non-EGP currencies.
--
-- doctor_fee is 20% of base_price throughout, matching every other service.
-- Note doctor_commission_pct defaults to 80 and is NOT what pays the doctor:
-- earnings_writer.js reads the absolute services.doctor_fee, copied onto the
-- order at checkout. Setting it here only to keep the column uniform.
--
-- ── DELIBERATELY DOES NOT MAKE PEDIATRICS SELLABLE ─────────────────────────
--
-- specialties.is_visible stays FALSE for spec-pediatrics. This migration
-- unblocks the DOCTORS; opening a sixth specialty to patients is a commercial
-- decision with a date attached, and it is one UPDATE when Ziad wants it:
--
--     UPDATE specialties SET is_visible = true WHERE id = 'spec-pediatrics';
--
-- ── SERVICE IDS ────────────────────────────────────────────────────────────
--
-- Readable peds_* slugs, as Cardiology uses (card_echo, card_ctca). The newer
-- specialties use UUIDs, which are unreadable in exactly the migrations and
-- support queries where you most need to know what you are looking at.
--
-- IDEMPOTENT: untargeted ON CONFLICT DO NOTHING on the services insert (see
-- the note above it), anti-join + ON CONFLICT on the mapping. Re-running changes nothing and never reprices a
-- service someone has since edited in the admin UI.
-- ============================================================================

INSERT INTO services (
  id, specialty_id, name, base_price, doctor_fee, currency, sla_hours,
  is_visible, coming_soon, doctor_commission_pct, vip_multiplier,
  urgent_multiplier, urgency_uplift_doctor_pct, sla_24hr_price, appointment_price
)
VALUES
  -- Band 1600 (USD 120) — single-question reviews
  ('peds_growth_development',   'spec-pediatrics', 'Growth Chart & Development Review',            1600,  320, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_vaccination_schedule', 'spec-pediatrics', 'Childhood Vaccination Schedule Review',        1600,  320, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_cbc_anaemia',          'spec-pediatrics', 'Paediatric CBC & Anaemia Panel Review',        1600,  320, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),

  -- Band 2400 (USD 200) — focused workups
  ('peds_fever_infection',      'spec-pediatrics', 'Paediatric Fever & Infection Workup Review',   2400,  480, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_asthma_wheeze',        'spec-pediatrics', 'Childhood Asthma & Wheeze Management Review',  2400,  480, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_allergy_eczema',       'spec-pediatrics', 'Paediatric Allergy & Eczema Review',           2400,  480, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_neonatal_jaundice',    'spec-pediatrics', 'Neonatal Jaundice & Newborn Screening Review', 2400,  480, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_feeding_nutrition',    'spec-pediatrics', 'Paediatric Feeding & Nutrition Review',        2400,  480, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),

  -- Band 3500 (USD 350) — whole-case and sub-specialty
  ('peds_general_case',         'spec-pediatrics', 'General Paediatric Case Review',               3500,  700, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_developmental_delay',  'spec-pediatrics', 'Developmental Delay & Milestone Assessment',   3500,  700, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_nicu_course',          'spec-pediatrics', 'Neonatal Intensive Care Course Review',        3500,  700, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_metabolic_inherited',  'spec-pediatrics', 'Inherited Metabolic Disorder Review',          3500,  700, 'EGP', 48, true, false, 80, 1.30, 1.60, 30, 100, 0)
-- Bare ON CONFLICT, NOT ON CONFLICT (id). services carries TWO unique
-- constraints — services_pkey (id) and services_specialty_name_unique
-- (specialty_id, name) — and an inference target only arbitrates the one it
-- names. If anyone adds a Pediatrics service by one of these names through the
-- admin UI before this deploys, it lands with a UUID, ON CONFLICT (id) would
-- not see it, and the insert would raise 23505 -> migrate() rejects ->
-- server.js exit(1) -> permanent boot loop. Untargeted DO NOTHING covers both.
ON CONFLICT DO NOTHING;

-- Pre-tick all twelve for the three Pediatrics doctors, same reasoning as 093:
-- they are about to be invited, and a filled-in form gets confirmed where an
-- empty one gets postponed. Still does NOT set onboarding_complete — pressing
-- Save is the thing we are asking them to do.
INSERT INTO doctor_services (doctor_id, service_id)
SELECT u.id, sv.id
  FROM users u
  JOIN services sv
    ON sv.specialty_id = u.specialty_id
   AND COALESCE(sv.is_visible, true) = true
 WHERE u.role = 'doctor'
   AND u.specialty_id = 'spec-pediatrics'
   AND COALESCE(u.is_active, true)  = true
   AND COALESCE(u.is_paused, false) = false
   AND NOT EXISTS (
         SELECT 1 FROM doctor_services ds
          WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
       )
ON CONFLICT DO NOTHING;

-- coming_soon is set to false in the INSERT above because these services will
-- have three active doctors mapped by the time this statement finishes, which
-- is what services_coming_soon_sync.js computes. Recompute for just these rows
-- rather than trusting the literal, so a doctor deactivated between now and
-- deploy cannot leave the flag lying.
UPDATE services sv
   SET coming_soon = NOT EXISTS (
         SELECT 1 FROM doctor_services ds
           JOIN users u ON u.id = ds.doctor_id
          WHERE ds.service_id = sv.id
            AND u.role = 'doctor' AND u.is_active = true
       )
 WHERE sv.specialty_id = 'spec-pediatrics';

-- Visibility only — WARNING, never EXCEPTION. db.js wraps this file in a
-- transaction, so a raise would roll back the migration AND its
-- schema_migrations row, and the next boot would fail identically: a permanent
-- boot loop over a catalogue that is merely incomplete.
DO $$
DECLARE svc integer; mapped integer; docs integer;
BEGIN
  SELECT count(*) INTO svc
    FROM services WHERE specialty_id = 'spec-pediatrics' AND COALESCE(is_visible, true) = true;

  SELECT count(*) INTO docs
    FROM users WHERE role = 'doctor' AND specialty_id = 'spec-pediatrics'
     AND COALESCE(is_active, true) = true AND COALESCE(is_paused, false) = false;

  SELECT count(*) INTO mapped
    FROM users u
   WHERE u.role = 'doctor' AND u.specialty_id = 'spec-pediatrics'
     AND COALESCE(u.is_active, true) = true AND COALESCE(u.is_paused, false) = false
     AND NOT EXISTS (
           SELECT 1 FROM services sv
            WHERE sv.specialty_id = 'spec-pediatrics'
              AND COALESCE(sv.is_visible, true) = true
              AND NOT EXISTS (
                    SELECT 1 FROM doctor_services ds
                     WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
                  )
         );

  RAISE NOTICE '094: Pediatrics now has % visible service(s); % of % active doctor(s) hold all of them', svc, mapped, docs;

  IF svc < 12 THEN
    RAISE WARNING '094: expected 12 visible Pediatrics services, found %', svc;
  END IF;
  IF mapped < docs THEN
    RAISE WARNING '094: % of % Pediatrics doctor(s) are still short a service', docs - mapped, docs;
  END IF;
END $$;
