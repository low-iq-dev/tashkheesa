-- 094_pediatrics_service_catalogue.sql
-- ============================================================================
-- 2026-08-25 — give Pediatrics a catalogue so its three doctors can onboard,
-- WITHOUT putting a sixth specialty on sale.
--
-- spec-pediatrics had ZERO service rows. Not hidden ones — none. So Ahmed
-- Hegazy, Reem Sabry and Yomna Mohsen had an empty catalogue union,
-- resolveDoctorLanding sent them to the dashboard instead of the services page,
-- and that page rendered "your services are being finalised" with no form.
-- onboarding_complete is only ever written by that form's POST, so all three
-- were structurally incapable of finishing onboarding and no invite copy could
-- have fixed it. That is the ONLY problem this migration solves.
--
-- ── DORMANT BY CONSTRUCTION: is_visible = false ────────────────────────────
--
-- The first draft of this file left the services visible and relied on
-- specialties.is_visible = false to keep them off the storefront. That does not
-- hold. servicesBookableClause (routes/patient.js) is:
--
--     COALESCE(sv.is_visible,true)=true AND COALESCE(sv.coming_soon,false)=false
--
-- Specialty visibility is not in it, and is joined at only SOME call sites —
-- the wizard's step-3 POST checks it; POST /patient/new-case, POST
-- /api/v1/cases, GET /api/v1/services and the unauthenticated
-- POST /api/help-me-choose do not. (Nephrology already sits in that gap with 8
-- bookable services under a hidden specialty. Not this migration's bug, but
-- not a gap to add twelve more services to either.)
--
-- coming_soon is no better as a gate: resyncComingSoon runs inside EVERY doctor
-- Save, and it sets coming_soon = false for any service with an active mapped
-- doctor. The first Pediatrics doctor to confirm their list would flip the
-- whole specialty live.
--
-- services.is_visible is the one flag nothing recomputes. So it is false here,
-- and these twelve rows are unreachable from every patient path.
--
-- The doctors still see them. loadDoctorServiceCatalog unions (a) visible
-- services in the doctor's specialty with (b) EVERY service the doctor already
-- holds a row for, ANY specialty, ANY visibility. The mapping below puts these
-- in branch (b), so the form renders all fifteen — each with the "Coming Soon"
-- chip portal_doctor_services.ejs already shows for is_visible === false — and
-- Save sets onboarding_complete. Which is the entire point.
--
-- GO-LIVE is therefore one statement, when the platform is ready for it (see
-- the safety note at the bottom — it is not ready today):
--
--     UPDATE services SET is_visible = true WHERE specialty_id = 'spec-pediatrics';
--     UPDATE specialties SET is_visible = true WHERE id = 'spec-pediatrics';
--
-- ── PRICING: BAND base_price + THE EIGHT INTERNATIONAL ROWS ────────────────
--
-- The first draft claimed the international ladder "comes from the band, not
-- from a per-service row". That was wrong and would have cost real money.
-- There is no band table anywhere in src/. The ladder IS per-service rows, and
-- OB/GYN (9/9), Orthopedics (11/11) and Urology (9/9) all carry full eight-
-- market ladders — they merely lack EG rows. With no row at all the resolver
-- COALESCE(cp.tashkheesa_price, sv.base_price) hands a US patient 3500 EGP for
-- a service meant to be USD 350: a ~80% undercharge, locked into orders.price
-- at creation. (Internal Medicine's six services have no rows in any market and
-- are undercharging internationally right now. Raised separately — copying it
-- is not the same as it being the pattern.)
--
-- So this file writes the eight non-EG rows per service, generated from the
-- band. Verified against production: the ladder is perfectly uniform, one price
-- per currency per band, no per-service variation:
--
--     band   USD   GBP   AED/QAR/SAR   KWD   BHD/OMR
--     1600   120   150       449        35      45
--     2400   200   250       749        59      75
--     3500   350   400      1199        95     119
--     5500   550   600      1899       149     189
--
-- NO EG rows, deliberately, matching Internal Medicine, OB/GYN, Orthopedics and
-- Urology. Where an EG row exists its hospital_cost is the price of the
-- underlying investigation and the patient pays a markup on it — that only
-- means something for imaging and tracing reads (Cardiology, Radiology).
-- Pediatrics here is consultative, with no priced scan to mark up, so Egyptians
-- pay base_price: 1600 / 2400 / 3500 / 5500.
--
-- (The first draft also said that markup is "exactly 1.1500 across all 57 rows".
-- It is 1.15 on 30 of them; Chest X-Ray is 550 -> 1250, ECG 500 -> 1250. Only
-- the conclusion survived, not the arithmetic.)
--
-- doctor_fee is 20% of base_price, matching all 168 existing services. Note it
-- is NOT what pays the doctor: orders.doctor_fee is computed at checkout from
-- fx.DOCTOR_SPLIT_PCT (0.20) against the EGP charge base, and earnings_writer
-- reads that. Same number here by construction, not by mechanism.
--
-- ── THE LIST ────────────────────────────────────────────────────────────────
--
-- Fifteen lines, shaped to the three doctors on file (General Pediatrics x2,
-- Neonatology, Metabolic & Genetics) and to a clinical safety review. Changes
-- from the twelve first drafted:
--
--   DROPPED  "Neonatal Jaundice & Newborn Screening Review". Jaundice is
--            managed against HOUR-specific bilirubin nomograms; a 48-hour
--            written opinion is stale before it is sent and a 4-hour "urgent"
--            tier actively sells delay to the families who must go in now. The
--            safe half survives as Newborn Screening Result Review.
--   DROPPED  standalone "Childhood Vaccination Schedule Review" at 1600 —
--            minutes of consultant time, and the line most likely to attract a
--            vaccine-refusal consult. Folded into the growth line.
--   RESHAPED "Fever & Infection Workup" -> "Recurrent or Prolonged Fever".
--            Fever under 28 days is a sepsis workup and under 90 days is a
--            risk-stratified emergency; an async read of a currently febrile
--            infant is a delay mechanism. This line is now a records question.
--   RESHAPED "Asthma & Wheeze Management" -> "Asthma Control Plan Review".
--            "Wheeze" pulls in the acute toddler and the under-1 with
--            bronchiolitis; "Management" promises what §4.4 of the Specialist
--            Code of Conduct forbids the doctor from doing.
--   RESHAPED "Developmental Delay & Milestone Assessment" -> "Records Review".
--            No assessment happens anywhere on this platform.
--   REPRICED NICU 3500 -> 5500. A 28-weeker's admission is a discharge summary
--            plus daily notes, serial cranial ultrasounds and ROP screening:
--            hours of work. At 3500 the doctor got 700 and the only
--            neonatologist on the platform would have declined it.
--   RENAMED  the CBC line, which duplicated Internal Medicine's identically
--            named, identically priced service.
--   ADDED    Genetic Test Report Review, Consanguinity & Recurrence Risk
--            Review, Pre-Surgical Second Opinion, Recurrent Infections.
--            Hegazy is the rarest asset on the platform and had one saleable
--            line; consanguinity risk in particular is high-value and, in this
--            market, high-demand.
--
-- US spelling ("Pediatric") throughout, matching the specialty name. No
-- existing service uses either spelling, so there is nothing else to match.
--
-- services.name_ar does not exist as a column, so these render in English on
-- the Arabic form too. Platform-wide gap, noted not solved.
--
-- IDEMPOTENT: untargeted ON CONFLICT DO NOTHING on the services insert —
-- services carries TWO unique constraints (services_pkey and
-- services_specialty_name_unique on (specialty_id, name)) plus a redundant
-- unique index on the same pair, and an inference target arbitrates only the
-- one it names. A same-named row added through the admin UI would land with a
-- UUID, ON CONFLICT (id) would miss it, and 23505 would reach migrate() and
-- exit(1) on every boot.
-- ============================================================================

INSERT INTO services (
  id, specialty_id, name, base_price, doctor_fee, currency, sla_hours,
  is_visible, coming_soon, doctor_commission_pct, vip_multiplier,
  urgent_multiplier, urgency_uplift_doctor_pct, sla_24hr_price, appointment_price
)
VALUES
  -- 1600 — one artefact, one question
  ('peds_growth_vaccination',   'spec-pediatrics', 'Pediatric Growth Chart & Vaccination Record Review', 1600,  320, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_blood_count',          'spec-pediatrics', 'Pediatric Blood Count & Anaemia Review',             1600,  320, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),

  -- 2400 — focused records questions
  ('peds_recurrent_fever',      'spec-pediatrics', 'Recurrent or Prolonged Fever Records Review',        2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_asthma_control',       'spec-pediatrics', 'Childhood Asthma Control Plan Review',               2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_allergy_eczema',       'spec-pediatrics', 'Pediatric Allergy & Eczema Review',                  2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_newborn_screening',    'spec-pediatrics', 'Newborn Screening Result Review',                    2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_feeding_nutrition',    'spec-pediatrics', 'Pediatric Feeding & Nutrition Review',               2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_recurrent_infections', 'spec-pediatrics', 'Recurrent Infections & Antibiotic Use Review',       2400,  480, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),

  -- 3500 — whole file, open question
  ('peds_general_case',         'spec-pediatrics', 'General Pediatric Case Review',                      3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_developmental',        'spec-pediatrics', 'Developmental Milestones Records Review',            3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_presurgical',          'spec-pediatrics', 'Pediatric Pre-Surgical Second Opinion',              3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_genetic_report',       'spec-pediatrics', 'Genetic Test Report Review',                         3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_consanguinity_risk',   'spec-pediatrics', 'Consanguinity & Recurrence Risk Review',             3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),
  ('peds_metabolic_inherited',  'spec-pediatrics', 'Inherited Metabolic Disorder Review',                3500,  700, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0),

  -- 5500 — multi-week record sets
  ('peds_nicu_stay',            'spec-pediatrics', 'NICU Stay & Discharge Summary Review',               5500, 1100, 'EGP', 48, false, true, 80, 1.30, 1.60, 30, 100, 0)
ON CONFLICT DO NOTHING;

-- The eight international rows per service, generated from the band so they
-- cannot drift from the ladder. doctor_commission is 20% of the local price,
-- as every existing row is.
--
-- id is text NOT NULL with NO DEFAULT on this table — omitting it raises 23502,
-- which is what nearly boot-looped the platform in 091. gen_random_uuid() is
-- built in on PG 13+; production is 17.6.
INSERT INTO service_regional_prices
  (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, created_at, updated_at)
SELECT gen_random_uuid()::text, sv.id, m.country_code, m.currency, NULL,
       m.price, ROUND((m.price * 0.20)::numeric, 2), 'active', NOW(), NOW()
  FROM services sv
  JOIN (VALUES
      (1600,'US','USD',120.0), (1600,'GB','GBP',150.0), (1600,'AE','AED',449.0), (1600,'SA','SAR',449.0),
      (1600,'QA','QAR',449.0), (1600,'KW','KWD', 35.0), (1600,'BH','BHD', 45.0), (1600,'OM','OMR', 45.0),
      (2400,'US','USD',200.0), (2400,'GB','GBP',250.0), (2400,'AE','AED',749.0), (2400,'SA','SAR',749.0),
      (2400,'QA','QAR',749.0), (2400,'KW','KWD', 59.0), (2400,'BH','BHD', 75.0), (2400,'OM','OMR', 75.0),
      (3500,'US','USD',350.0), (3500,'GB','GBP',400.0), (3500,'AE','AED',1199.0), (3500,'SA','SAR',1199.0),
      (3500,'QA','QAR',1199.0),(3500,'KW','KWD', 95.0), (3500,'BH','BHD',119.0), (3500,'OM','OMR',119.0),
      (5500,'US','USD',550.0), (5500,'GB','GBP',600.0), (5500,'AE','AED',1899.0), (5500,'SA','SAR',1899.0),
      (5500,'QA','QAR',1899.0),(5500,'KW','KWD',149.0), (5500,'BH','BHD',189.0), (5500,'OM','OMR',189.0)
    ) AS m(band, country_code, currency, price)
    ON m.band = sv.base_price
 WHERE sv.specialty_id = 'spec-pediatrics'
ON CONFLICT (service_id, country_code) DO NOTHING;

-- Pre-tick all of them for the three Pediatrics doctors — same reasoning as
-- 093: a filled-in form gets confirmed, an empty one gets postponed. This is
-- also what puts the rows in branch (b) of the catalogue union, which is the
-- only reason an is_visible = false service appears on their form at all.
--
-- Still does NOT set onboarding_complete. Pressing Save is the thing we are
-- asking them to do.
INSERT INTO doctor_services (doctor_id, service_id)
SELECT u.id, sv.id
  FROM users u
  JOIN services sv ON sv.specialty_id = u.specialty_id
 WHERE u.role = 'doctor'
   AND u.specialty_id = 'spec-pediatrics'
   AND COALESCE(u.is_active, true)  = true
   AND COALESCE(u.is_paused, false) = false
   AND NOT EXISTS (
         SELECT 1 FROM doctor_services ds
          WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
       )
ON CONFLICT DO NOTHING;

-- Visibility only — WARNING, never EXCEPTION. db.js wraps this file in a
-- transaction, so a raise would roll back the migration AND its
-- schema_migrations row, and every subsequent boot would fail identically.
--
-- Note these RAISEs are not read by anything: node-postgres delivers them as
-- 'notice' events and src/ registers no handler. They are here for someone
-- running the file by hand. The real check is the SELECTs in the deploy notes.
DO $$
DECLARE svc integer; prices integer; short integer; docs integer;
BEGIN
  SELECT count(*) INTO svc FROM services WHERE specialty_id = 'spec-pediatrics';

  SELECT count(*) INTO prices
    FROM service_regional_prices rp
    JOIN services sv ON sv.id = rp.service_id
   WHERE sv.specialty_id = 'spec-pediatrics' AND rp.country_code <> 'EG';

  SELECT count(*) INTO docs
    FROM users WHERE role = 'doctor' AND specialty_id = 'spec-pediatrics'
     AND COALESCE(is_active, true) = true AND COALESCE(is_paused, false) = false;

  SELECT count(*) INTO short
    FROM users u
   WHERE u.role = 'doctor' AND u.specialty_id = 'spec-pediatrics'
     AND COALESCE(u.is_active, true) = true AND COALESCE(u.is_paused, false) = false
     AND EXISTS (
           SELECT 1 FROM services sv
            WHERE sv.specialty_id = 'spec-pediatrics'
              AND NOT EXISTS (
                    SELECT 1 FROM doctor_services ds
                     WHERE ds.doctor_id = u.id AND ds.service_id = sv.id
                  )
         );

  RAISE NOTICE '094: % Pediatrics services, % international price rows, % of % doctor(s) hold the full list',
    svc, prices, docs - short, docs;

  IF svc  < 15 THEN RAISE WARNING '094: expected 15 Pediatrics services, found %', svc; END IF;
  IF prices < 120 THEN RAISE WARNING '094: expected 120 international price rows (15 x 8), found %', prices; END IF;
  IF short > 0 THEN RAISE WARNING '094: % Pediatrics doctor(s) still short a service', short; END IF;
END $$;

-- ── NOT A GO-LIVE ───────────────────────────────────────────────────────────
--
-- Do not flip is_visible until the platform can safely sell paediatrics. A
-- clinical review of this catalogue raised three things SQL cannot fix, and
-- they are all in the existing issue register:
--
--   * The child's age is not captured, and cases_intake.js writes an AGE into
--    date_of_birth ("3" becomes the year 2003). Every safety rule below depends
--    on knowing whether the patient is three weeks or thirteen years old.
--   * There is no guardian-consent step and no record of who the account holder
--    is to the child. That is a PDPL 151/2020 exposure on a minor's health data
--    and a safeguarding one.
--   * There is no way to escalate an urgent finding faster than the SLA clock.
--    A pediatric CBC is how leukaemia presents.
--
-- Before go-live this specialty also needs a pre-payment red-flag screen
-- (under 3 months / fever now / laboured breathing / not feeding / drowsy /
-- seizure), the Urgent 4-hour tier disabled for infants, and a standing
-- paediatric footer on every report. See the readiness doc.
