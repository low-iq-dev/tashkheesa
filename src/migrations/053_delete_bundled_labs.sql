-- Migration 053: Hard-delete 38 lab services replaced by panels
--
-- Generated: 2026-05-11  (side issue #48 — pricing v4 reset)
-- Source:    Tashkheesa_Canonical_Pricing_v4.xlsx — Excluded tab,
--            rows with Status = '📦 Bundled into Panel'
-- Reference: docs/pricing/PRICING_RECONCILIATION_v4_PROD.md §4.1
--
-- WHAT:      Hard-DELETE 38 individual lab tests that the v4 sheet
--            replaces with 7 lab panel SKUs (inserted by migration 051).
-- WHY:       Sheet explicitly authorises hard-delete (replacement is
--            already in place; these rows are dead inventory).
-- SAFETY:    All 38 rows are already is_visible=false in prod (verified).
--            ZERO orders reference any of the 38 ids (verified —
--            SELECT COUNT(*) FROM orders WHERE service_id IN (…) = 0).
--            No FK cascade risk; no order-history impact.
-- IDEMPOTENT: DELETE of already-deleted rows is a no-op.
-- POST:      Post-condition guard verifies 0 of the 38 ids remain in
--            services after the DELETE.
--
-- IDs to delete (38 — all currently is_visible=false in prod):
--   lab_autoimmune_ana                  | Autoimmune - ANA
--   lab_autoimmune_c3                   | Autoimmune - Complement C3
--   lab_autoimmune_c4                   | Autoimmune - Complement C4
--   lab_coag_pt                         | Coagulation - PT/INR
--   lab_coag_ptt                        | Coagulation - PTT
--   lab_cbc                             | Complete Blood Count (CBC)
--   lab_diabetes                        | Diabetes Panel (HbA1c/FBS)
--   lab_electrolytes_k                  | Electrolytes - Potassium
--   lab_electrolytes_na                 | Electrolytes - Sodium
--   lab_hormone_dhea                    | Hormone - DHEA-S
--   lab_hormone_e2                      | Hormone - Estradiol (E2)
--   lab_hormone_fsh                     | Hormone - FSH
--   lab_hormone_lh                      | Hormone - LH
--   lab_hormone_prl                     | Hormone - Prolactin
--   lab_hormone_testo                   | Hormone - Testosterone
--   lab_kidney_creat                    | Kidney Function - Creatinine
--   lab_kidney_urea                     | Kidney Function - Urea
--   lab_kidney_uric_acid                | Kidney Function - Uric Acid
--   lab_lipid_profile                   | Lipid Profile
--   lab_liver_albumin                   | Liver Function - Albumin
--   lab_liver_alp                       | Liver Function - ALP
--   lab_liver_alt                       | Liver Function - ALT
--   lab_liver_ast                       | Liver Function - AST
--   lab_liver_ggt                       | Liver Function - GGT
--   lab_micro_blood_cs                  | Microbiology - Blood C&S
--   lab_micro_stool_cs                  | Microbiology - Stool C&S
--   lab_micro_urine_cs                  | Microbiology - Urine C&S
--   lab_stool_analysis                  | Stool Analysis
--   lab_stool_culture                   | Stool Culture
--   lab_thyroid_panel                   | Thyroid Panel
--   lab_tumor_afp                       | Tumor Marker - AFP
--   lab_tumor_ca125                     | Tumor Marker - CA 125
--   lab_tumor_ca153                     | Tumor Marker - CA 15-3
--   lab_tumor_ca199                     | Tumor Marker - CA 19-9
--   lab_tumor_cea                       | Tumor Marker - CEA
--   lab_tumor_psa                       | Tumor Marker - PSA
--   lab_urinalysis                      | Urinalysis
--   lab_urine_culture                   | Urine Culture

BEGIN;

DELETE FROM services WHERE id IN (
  'lab_autoimmune_ana',
  'lab_autoimmune_c3',
  'lab_autoimmune_c4',
  'lab_cbc',
  'lab_coag_pt',
  'lab_coag_ptt',
  'lab_diabetes',
  'lab_electrolytes_k',
  'lab_electrolytes_na',
  'lab_hormone_dhea',
  'lab_hormone_e2',
  'lab_hormone_fsh',
  'lab_hormone_lh',
  'lab_hormone_prl',
  'lab_hormone_testo',
  'lab_kidney_creat',
  'lab_kidney_urea',
  'lab_kidney_uric_acid',
  'lab_lipid_profile',
  'lab_liver_albumin',
  'lab_liver_alp',
  'lab_liver_alt',
  'lab_liver_ast',
  'lab_liver_ggt',
  'lab_micro_blood_cs',
  'lab_micro_stool_cs',
  'lab_micro_urine_cs',
  'lab_stool_analysis',
  'lab_stool_culture',
  'lab_thyroid_panel',
  'lab_tumor_afp',
  'lab_tumor_ca125',
  'lab_tumor_ca153',
  'lab_tumor_ca199',
  'lab_tumor_cea',
  'lab_tumor_psa',
  'lab_urinalysis',
  'lab_urine_culture'
);

-- Post-condition guard: all 38 must be gone
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO remaining FROM services WHERE id IN (
    'lab_autoimmune_ana',
    'lab_autoimmune_c3',
    'lab_autoimmune_c4',
    'lab_cbc',
    'lab_coag_pt',
    'lab_coag_ptt',
    'lab_diabetes',
    'lab_electrolytes_k',
    'lab_electrolytes_na',
    'lab_hormone_dhea',
    'lab_hormone_e2',
    'lab_hormone_fsh',
    'lab_hormone_lh',
    'lab_hormone_prl',
    'lab_hormone_testo',
    'lab_kidney_creat',
    'lab_kidney_urea',
    'lab_kidney_uric_acid',
    'lab_lipid_profile',
    'lab_liver_albumin',
    'lab_liver_alp',
    'lab_liver_alt',
    'lab_liver_ast',
    'lab_liver_ggt',
    'lab_micro_blood_cs',
    'lab_micro_stool_cs',
    'lab_micro_urine_cs',
    'lab_stool_analysis',
    'lab_stool_culture',
    'lab_thyroid_panel',
    'lab_tumor_afp',
    'lab_tumor_ca125',
    'lab_tumor_ca153',
    'lab_tumor_ca199',
    'lab_tumor_cea',
    'lab_tumor_psa',
    'lab_urinalysis',
    'lab_urine_culture'
  );
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'migration 053 failed: % bundled ids still in services (expected 0)', remaining;
  END IF;
END $$;

COMMIT;
