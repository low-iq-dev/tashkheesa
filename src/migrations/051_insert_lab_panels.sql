-- Migration 051: Insert 7 new lab panel SKUs
--
-- Generated: 2026-05-11  (side issue #48 — pricing v4 reset)
-- Source:    Tashkheesa_Canonical_Pricing_v4.xlsx — Launch Catalog,
--            rows with Category starting 'Panel: …'
-- Reference: docs/pricing/PRICING_RECONCILIATION_v4_PROD.md §3
--
-- WHAT:      INSERT 7 net-new Lab & Pathology panel services that
--            replace 38 individual lab tests (those 38 are hard-deleted
--            by migration 053).
-- WHY:       Canonical v4 pricing consolidates individual below-floor
--            lab tests into priced panels. All 7 panels are above the
--            250-EGP doctor-fee floor.
-- SAFETY:    INSERT only. ON CONFLICT (id) DO NOTHING for idempotency
--            (re-running is a no-op once rows exist).
-- PRE-FLIGHT (2026-05-11): 0 of 7 panel ids exist in prod today.
-- POST:      Post-condition guard inside the txn aborts if any of the
--            7 lab_panel_* rows fails to land.
--
-- IDs and prices (per canonical v4 sheet):
--   lab_panel_routine_bloods            | Routine Bloods Panel Review              |  1500 EGP | fee 300 | components: CBC, Urea, Creatinine, Uric Acid, AST, ALT, ALP, GGT, Albumin, Lipid P…
--   lab_panel_tumor_markers             | Tumor Markers Panel Review               |  1750 EGP | fee 350 | components: CEA, CA 15-3, CA 19-9, CA 125, PSA, AFP
--   lab_panel_hormones                  | Hormone Panel Review                     |  1750 EGP | fee 350 | components: DHEA-S, Estradiol (E2), Testosterone, LH, FSH, Prolactin
--   lab_panel_autoimmune                | Autoimmune Panel Review                  |  1750 EGP | fee 350 | components: ANA, ANCA, Anti-DNA, ASMA, Complement C3, Complement C4
--   lab_panel_urine_stool               | Urine & Stool Workup Review              |  1250 EGP | fee 250 | components: Urinalysis, Urine Culture, Stool Analysis, Stool Culture, Microbiology…
--   lab_panel_coag_electrolytes         | Coagulation & Electrolytes Review        |  1250 EGP | fee 250 | components: PT/INR, PTT, Sodium, Potassium
--   lab_panel_microbiology              | Microbiology Cultures Review             |  1500 EGP | fee 300 | components: Blood C&S, Sputum C&S, Sensitivity Testing

BEGIN;

INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, is_visible, currency)
VALUES
  ('lab_panel_routine_bloods', 'lab_pathology', 'Routine Bloods Panel Review', 1500, 300, true, 'EGP'),
  ('lab_panel_tumor_markers', 'lab_pathology', 'Tumor Markers Panel Review', 1750, 350, true, 'EGP'),
  ('lab_panel_hormones', 'lab_pathology', 'Hormone Panel Review', 1750, 350, true, 'EGP'),
  ('lab_panel_autoimmune', 'lab_pathology', 'Autoimmune Panel Review', 1750, 350, true, 'EGP'),
  ('lab_panel_urine_stool', 'lab_pathology', 'Urine & Stool Workup Review', 1250, 250, true, 'EGP'),
  ('lab_panel_coag_electrolytes', 'lab_pathology', 'Coagulation & Electrolytes Review', 1250, 250, true, 'EGP'),
  ('lab_panel_microbiology', 'lab_pathology', 'Microbiology Cultures Review', 1500, 300, true, 'EGP')
ON CONFLICT (id) DO NOTHING;

-- Post-condition guard
DO $$
DECLARE
  panel_count integer;
BEGIN
  SELECT COUNT(*) INTO panel_count FROM services WHERE id LIKE 'lab_panel_%';
  IF panel_count <> 7 THEN
    RAISE EXCEPTION 'migration 051 failed: expected 7 lab_panel_%% services, got %', panel_count;
  END IF;
END $$;

COMMIT;
