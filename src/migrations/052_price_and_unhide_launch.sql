-- Migration 052: Apply prices + un-hide 38 launch SKUs
--
-- Generated: 2026-05-11  (side issue #48 — pricing v4 reset)
-- Source:    Tashkheesa_Canonical_Pricing_v4.xlsx — Launch Catalog
-- Reference: docs/pricing/PRICING_RECONCILIATION_v4_PROD.md §5b
--
-- WHAT:      For each of 38 prod services currently is_visible=false +
--            base_price IS NULL, UPDATE base_price + doctor_fee + flip
--            is_visible to true. Match by id (real prod id from §1 of
--            the reconciliation report).
-- WHY:       These 38 are matched-launch SKUs that the v4 sheet
--            prices for the first time. Together with the 57 still-hidden
--            Excluded matches, they account for all 95 currently-unpriced
--            services in prod (per issue #48).
-- INCLUDES:  All 5 sheet-defined 'Bumped (was below floor)' rows —
--            rad_cxr_review, card_ecg_12lead, card_rhythm_strip,
--            pulm_cxr_review, lab_cytology — go to 1,250 EGP /
--            250 EGP doctor fee.
-- SAFETY:    UPDATE only. Idempotent (re-applying same values is a
--            no-op).
-- POST:      Post-condition guard verifies 0 of the 38 ids remain
--            unpriced; aborts the txn otherwise.
--
-- Pre-flight (2026-05-11, against prod):
--   found=38, hidden=38, unpriced=38,
--   unexpected_priced=0, unexpected_visible=0
--
-- Breakdown by specialty:
--   lab_pathology                  : 9
--   spec-cardiology                : 9
--   spec-neurology                 : 7
--   spec-oncology                  : 2
--   spec-radiology                 : 11

BEGIN;

-- ── lab_pathology (9 rows) ──
UPDATE services SET base_price = 2530, doctor_fee = 506, is_visible = true WHERE id = 'lab_autoimmune_anca';  -- Autoimmune - ANCA
UPDATE services SET base_price = 1495, doctor_fee = 299, is_visible = true WHERE id = 'lab_autoimmune_anti_dna';  -- Autoimmune - Anti-DNA
UPDATE services SET base_price = 1495, doctor_fee = 299, is_visible = true WHERE id = 'lab_autoimmune_asma';  -- Autoimmune - ASMA
UPDATE services SET base_price = 11500, doctor_fee = 2300, is_visible = true WHERE id = 'lab_bone_marrow';  -- Bone Marrow Aspirate Review
UPDATE services SET base_price = 1250, doctor_fee = 250, is_visible = true WHERE id = 'lab_cytology';  -- Cytology  -- BUMP TO FLOOR
UPDATE services SET base_price = 2990, doctor_fee = 598, is_visible = true WHERE id = 'lab_histo_large';  -- Histopathology - Large Biopsy
UPDATE services SET base_price = 4255, doctor_fee = 851, is_visible = true WHERE id = 'lab_histo_organ';  -- Histopathology - Organ/Resection
UPDATE services SET base_price = 1668, doctor_fee = 334, is_visible = true WHERE id = 'lab_histo_small';  -- Histopathology - Small Biopsy
UPDATE services SET base_price = 6900, doctor_fee = 1380, is_visible = true WHERE id = 'lab_micro_sputum_cs';  -- Microbiology - Sputum C&S

-- ── spec-cardiology (9 rows) ──
UPDATE services SET base_price = 1250, doctor_fee = 250, is_visible = true WHERE id = 'card_ecg_12lead';  -- 12-Lead ECG Interpretation  -- BUMP TO FLOOR
UPDATE services SET base_price = 3680, doctor_fee = 736, is_visible = true WHERE id = 'card_calcium_score';  -- Calcium Score Review
UPDATE services SET base_price = 8395, doctor_fee = 1679, is_visible = true WHERE id = 'card_cmr';  -- Cardiac MR Review
UPDATE services SET base_price = 7935, doctor_fee = 1587, is_visible = true WHERE id = 'card_ctca';  -- CT Coronary Angiography Review
UPDATE services SET base_price = 1380, doctor_fee = 276, is_visible = true WHERE id = 'card_echo';  -- Echocardiogram Review
UPDATE services SET base_price = 3450, doctor_fee = 690, is_visible = true WHERE id = 'card_holter_24_72';  -- Holter Monitor (24-72h) Review
UPDATE services SET base_price = 1250, doctor_fee = 250, is_visible = true WHERE id = 'card_rhythm_strip';  -- Rhythm Strip Analysis  -- BUMP TO FLOOR
UPDATE services SET base_price = 2070, doctor_fee = 414, is_visible = true WHERE id = 'card_stress_echo';  -- Stress Echo Review
UPDATE services SET base_price = 1553, doctor_fee = 311, is_visible = true WHERE id = 'card_stress_treadmill';  -- Stress Treadmill Test Review

-- ── spec-neurology (7 rows) ──
UPDATE services SET base_price = 1553, doctor_fee = 311, is_visible = true WHERE id = 'neuro_brain_ct';  -- Brain CT Review
UPDATE services SET base_price = 3680, doctor_fee = 736, is_visible = true WHERE id = 'neuro_brain_mri';  -- Brain MRI Review
UPDATE services SET base_price = 13225, doctor_fee = 2645, is_visible = true WHERE id = 'neuro_eeg';  -- EEG Interpretation
UPDATE services SET base_price = 6900, doctor_fee = 1380, is_visible = true WHERE id = 'neuro_emg_ncs';  -- EMG/NCS Review
UPDATE services SET base_price = 9085, doctor_fee = 1817, is_visible = true WHERE id = 'neuro_cta';  -- Neuro CTA Review
UPDATE services SET base_price = 6210, doctor_fee = 1242, is_visible = true WHERE id = 'neuro_mra';  -- Neuro MRA Review
UPDATE services SET base_price = 9315, doctor_fee = 1863, is_visible = true WHERE id = 'neuro_spine_mri';  -- Neuro Spine MRI Review

-- ── spec-oncology (2 rows) ──
UPDATE services SET base_price = 11500, doctor_fee = 2300, is_visible = true WHERE id = 'onc_bone_marrow_biopsy';  -- Bone Marrow Biopsy Review
UPDATE services SET base_price = 17480, doctor_fee = 3496, is_visible = true WHERE id = 'onc_ct_mri_staging';  -- CT/MRI Staging Review

-- ── spec-radiology (11 rows) ──
UPDATE services SET base_price = 8050, doctor_fee = 1610, is_visible = true WHERE id = 'rad_abd_pelvis_ct_mri';  -- Abdomen/Pelvis CT/MRI Review
UPDATE services SET base_price = 7935, doctor_fee = 1587, is_visible = true WHERE id = 'rad_cardiac_ct';  -- Cardiac CT Review
UPDATE services SET base_price = 8395, doctor_fee = 1679, is_visible = true WHERE id = 'rad_cardiac_mri';  -- Cardiac MRI Review
UPDATE services SET base_price = 1250, doctor_fee = 250, is_visible = true WHERE id = 'rad_cxr_review';  -- Chest X-Ray Review  -- BUMP TO FLOOR
UPDATE services SET base_price = 9085, doctor_fee = 1817, is_visible = true WHERE id = 'rad_ct_review';  -- CT Scan Review
UPDATE services SET base_price = 17480, doctor_fee = 3496, is_visible = true WHERE id = 'rad_ct_mr_angio';  -- CT/MR Angiography Review
UPDATE services SET base_price = 8395, doctor_fee = 1679, is_visible = true WHERE id = 'rad_mri_review';  -- MRI Review
UPDATE services SET base_price = 1840, doctor_fee = 368, is_visible = true WHERE id = 'rad_msk_imaging';  -- Musculoskeletal Imaging Review
UPDATE services SET base_price = 5233, doctor_fee = 1047, is_visible = true WHERE id = 'rad_neuro_imaging';  -- Neuro Imaging Review
UPDATE services SET base_price = 9315, doctor_fee = 1863, is_visible = true WHERE id = 'rad_spine_mri';  -- Spine MRI Review
UPDATE services SET base_price = 1725, doctor_fee = 345, is_visible = true WHERE id = 'rad_us_review';  -- Ultrasound Review

-- Post-condition guard: all 38 must be priced and visible
DO $$
DECLARE
  still_unpriced integer;
  not_visible integer;
BEGIN
  SELECT COUNT(*) INTO still_unpriced FROM services
  WHERE id IN (
    'card_calcium_score',
    'card_cmr',
    'card_ctca',
    'card_ecg_12lead',
    'card_echo',
    'card_holter_24_72',
    'card_rhythm_strip',
    'card_stress_echo',
    'card_stress_treadmill',
    'lab_autoimmune_anca',
    'lab_autoimmune_anti_dna',
    'lab_autoimmune_asma',
    'lab_bone_marrow',
    'lab_cytology',
    'lab_histo_large',
    'lab_histo_organ',
    'lab_histo_small',
    'lab_micro_sputum_cs',
    'neuro_brain_ct',
    'neuro_brain_mri',
    'neuro_cta',
    'neuro_eeg',
    'neuro_emg_ncs',
    'neuro_mra',
    'neuro_spine_mri',
    'onc_bone_marrow_biopsy',
    'onc_ct_mri_staging',
    'rad_abd_pelvis_ct_mri',
    'rad_cardiac_ct',
    'rad_cardiac_mri',
    'rad_ct_mr_angio',
    'rad_ct_review',
    'rad_cxr_review',
    'rad_mri_review',
    'rad_msk_imaging',
    'rad_neuro_imaging',
    'rad_spine_mri',
    'rad_us_review'
  ) AND (base_price IS NULL OR base_price <= 0);
  IF still_unpriced <> 0 THEN
    RAISE EXCEPTION 'migration 052 failed: % launch ids remain unpriced (expected 0)', still_unpriced;
  END IF;

  SELECT COUNT(*) INTO not_visible FROM services
  WHERE id IN (
    'card_calcium_score',
    'card_cmr',
    'card_ctca',
    'card_ecg_12lead',
    'card_echo',
    'card_holter_24_72',
    'card_rhythm_strip',
    'card_stress_echo',
    'card_stress_treadmill',
    'lab_autoimmune_anca',
    'lab_autoimmune_anti_dna',
    'lab_autoimmune_asma',
    'lab_bone_marrow',
    'lab_cytology',
    'lab_histo_large',
    'lab_histo_organ',
    'lab_histo_small',
    'lab_micro_sputum_cs',
    'neuro_brain_ct',
    'neuro_brain_mri',
    'neuro_cta',
    'neuro_eeg',
    'neuro_emg_ncs',
    'neuro_mra',
    'neuro_spine_mri',
    'onc_bone_marrow_biopsy',
    'onc_ct_mri_staging',
    'rad_abd_pelvis_ct_mri',
    'rad_cardiac_ct',
    'rad_cardiac_mri',
    'rad_ct_mr_angio',
    'rad_ct_review',
    'rad_cxr_review',
    'rad_mri_review',
    'rad_msk_imaging',
    'rad_neuro_imaging',
    'rad_spine_mri',
    'rad_us_review'
  ) AND is_visible = false;
  IF not_visible <> 0 THEN
    RAISE EXCEPTION 'migration 052 failed: % launch ids still hidden (expected 0)', not_visible;
  END IF;
END $$;

COMMIT;
