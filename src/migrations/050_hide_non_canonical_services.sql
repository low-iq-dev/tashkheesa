-- Migration 050: Hide non-canonical v4 services
--
-- Generated: 2026-05-11  (side issue #48 — pricing v4 reset)
-- Source:    docs/pricing/PRICING_TRIAGE_144_DB_ONLY.md (rows marked HIDE)
-- See also:  docs/pricing/PRICING_RECONCILIATION_v4.md §4
--
-- WHAT:  Sets is_visible=false on 126 services that the canonical v4 pricing
--        sheet does not reference (neither Launch Catalog nor Excluded tab).
-- WHY:   These are seed-data leftovers and legacy duplicates from earlier
--        migrations. They have ZERO historical orders (verified via
--        SELECT COUNT(*) FROM orders WHERE service_id IN (…) — all 126 = 0).
-- SAFETY: UPDATE only (no DELETE). is_visible is the soft-hide flag —
--        no FK risk, no data loss, fully reversible.
-- IDEMPOTENT: UPDATE is naturally idempotent. Re-running is a no-op.
--
-- PRE-FLIGHT VERIFICATION (run 2026-05-11 against live DB):
--   - 126/126 ids exist in services table
--   - 94 currently is_visible=true  → this migration flips them to false
--   - 32 currently is_visible=false → this migration is a no-op for these
--   - 0 rows have any orders.service_id reference → no ABORT triggered
--
-- POST-DEPLOY VERIFICATION:
--   SELECT COUNT(*) FROM services WHERE is_visible = false;
--   -- Expected: prev_count + 94 (NOT +126 — 32 were already hidden)
--   -- Pre-migration baseline: 126 hidden → post: 220 hidden
--
-- WHAT THIS MIGRATION DOES NOT TOUCH:
--   - Prices (no base_price / doctor_fee changes)
--   - Service rows (no INSERT / DELETE)
--   - The 18 NEEDS_DECISION rows from triage (require manual Ziad review)
--   - The 66 matched rows from reconciliation §1 (price update migration TBD)
--   - The 71 sheet-only rows from reconciliation §3 (insert migration TBD)
--   - The 38 Bundled-into-Panel rows from reconciliation §4.1 (hard-delete migration TBD)
--
-- IDS, GROUPED BY specialty_id (with current is_visible state in parens):
--
-- lab_pathology (21 rows)
--   hidden  | lab_autoimmune                                          | fee=  1065 | Autoimmune panels
--   hidden  | 00a85f9d-313a-4905-aa2d-50e9c4beafd1                    | fee=   720 | Biopsy / Histopathology Review
--   visible | 02e935a9-fb3b-46e2-831b-b1e31a9494f9                    | fee=   250 | Blood Work Review
--   hidden  | lab_bm_smear_biopsy                                     | fee=  1800 | Bone marrow smear & biopsy reports
--   hidden  | lab_coag                                                | fee=    90 | Coagulation studies
--   hidden  | lab_cytology_fluids                                     | fee=   158 | Cytology: Body fluids
--   hidden  | lab_cytology_fna                                        | fee=   255 | Cytology: Fine needle aspiration (FNA)
--   hidden  | lab_cytology_pap                                        | fee=   158 | Cytology: Pap smear
--   hidden  | lab_electrolytes                                        | fee=    83 | Electrolytes
--   hidden  | lab_histopath_biopsy                                    | fee=   668 | Histopathology reports (biopsies)
--   hidden  | lab_hormones                                            | fee=   233 | Hormonal profiles
--   visible | svc-lab-pathology-infectious-disease-panel-review       | fee=   300 | Infectious Disease Panel Review
--   hidden  | lab_kidney                                              | fee=    98 | Kidney function
--   visible | svc-lab-pathology-lipid-panel-review                    | fee=   250 | Lipid Panel Review
--   hidden  | lab_liver                                               | fee=   135 | Liver function
--   visible | svc-lab-pathology-metabolic-panel-review                | fee=   250 | Metabolic Panel Review
--   hidden  | lab_micro_cultures                                      | fee=   150 | Microbiology: Bacterial cultures
--   hidden  | lab_micro_sensitivity                                   | fee=   150 | Microbiology: Sensitivity results
--   visible | svc-lab-pathology-thyroid-panel-review                  | fee=   250 | Thyroid Panel Review
--   hidden  | 004e845e-7a96-4818-8bb7-7a9804c9bbe5                    | fee=   480 | Tumor Marker Review
--   hidden  | lab_tumor_markers                                       | fee=   495 | Tumor markers
--
-- spec-cardiology (7 rows)
--   visible | 0096b0ce-98dc-4211-a45d-b36dbd4eb867                    | fee=   276 | Cardiac Catheterization Review
--   visible | svc-cardiology-cardiac-ct-angiography-review            | fee=   230 | Cardiac CT Angiography Review
--   visible | svc-cardiology-cardiac-mri-review                       | fee=   230 | Cardiac MRI Review
--   visible | svc-cardiology-coronary-angiogram-review                | fee=   276 | Coronary Angiogram Review
--   visible | 0178b4b3-998c-4f22-b8ad-244e527cf32c                    | fee=   250 | ECG Review
--   visible | 01734b45-bf72-43d3-8ed8-0840ae256ae3                    | fee=   300 | Holter Monitor Review
--   visible | svc-cardiology-stress-test-review                       | fee=   300 | Stress Test Review
--
-- spec-dermatology (7 rows)
--   visible | 023495cb-67d6-43b8-9f3a-f6accdaf3f39                    | fee=    92 | Dermoscopy Image Review
--   visible | svc-dermatology-hair-loss-investigation-review          | fee=   104 | Hair Loss Investigation Review
--   visible | svc-dermatology-melanoma-staging-review                 | fee=   184 | Melanoma Staging Review
--   visible | svc-dermatology-psoriasis-case-review                   | fee=   115 | Psoriasis Case Review
--   visible | svc-dermatology-skin-allergy-panel-review               | fee=    92 | Skin Allergy Panel Review
--   visible | 002f73f4-39c5-4e10-8027-a572f02cc18d                    | fee=   115 | Skin Biopsy Review
--   visible | svc-dermatology-wound-assessment-review                 | fee=    92 | Wound Assessment Review
--
-- spec-endocrinology (6 rows)
--   visible | svc-endocrinology-adrenal-gland-mri-review              | fee=   207 | Adrenal Gland MRI Review
--   hidden  | 0167d79b-1ac6-49e8-9d36-14d6cf410fb6                    | fee=   400 | Hormonal Profile Review
--   visible | svc-endocrinology-hormone-panel-review                  | fee=   250 | Hormone Panel Review
--   visible | svc-endocrinology-parathyroid-scan-review               | fee=   161 | Parathyroid Scan Review
--   visible | svc-endocrinology-thyroid-biopsy-fna-review             | fee=   161 | Thyroid Biopsy (FNA) Review
--   visible | 00a5d1c9-6616-4595-b9f1-cf5730a97520                    | fee=   250 | Thyroid Panel Review
--
-- spec-ent (10 rows)
--   hidden  | 01d596fd-16ec-472f-bed0-25ae8993d165                    | fee=   320 | Audiogram Review
--   visible | svc-ent-ct-sinuses-review                               | fee=   138 | CT Sinuses Review
--   visible | svc-ent-hearing-test-audiogram-review                   | fee=    92 | Hearing Test (Audiogram) Review
--   visible | svc-ent-laryngoscopy-report-review                      | fee=   161 | Laryngoscopy Report Review
--   visible | svc-ent-neck-mri-review                                 | fee=   207 | Neck MRI Review
--   visible | svc-ent-salivary-gland-ultrasound-review                | fee=   115 | Salivary Gland Ultrasound Review
--   hidden  | 020abdf1-b8f6-444e-8bde-27d86103e2e7                    | fee=   560 | Sinus CT Review
--   visible | svc-ent-temporal-bone-ct-review                         | fee=   161 | Temporal Bone CT Review
--   visible | svc-ent-thyroid-ultrasound-review                       | fee=   115 | Thyroid Ultrasound Review
--   visible | svc-ent-tympanometry-review                             | fee=    80 | Tympanometry Review
--
-- spec-gastroenterology (7 rows)
--   hidden  | 005a6fd5-2ac0-4bc7-9edd-7a5092b1b896                    | fee=   640 | Abdominal CT Review
--   visible | svc-gastroenterology-abdominal-ct-scan-review           | fee=   161 | Abdominal CT Scan Review
--   hidden  | 0052a110-1ddc-4639-9e50-d88a5ab99f22                    | fee=   400 | Abdominal Ultrasound Review
--   visible | svc-gastroenterology-celiac-disease-panel-review        | fee=    92 | Celiac Disease Panel Review
--   visible | svc-gastroenterology-h-pylori-test-review               | fee=    69 | H. pylori Test Review
--   visible | svc-gastroenterology-inflammatory-bowel-disease-review  | fee=   207 | Inflammatory Bowel Disease Review
--   visible | svc-gastroenterology-liver-biopsy-review                | fee=   230 | Liver Biopsy Review
--
-- spec-general-surgery (10 rows)
--   visible | svc-general-surgery-abdominal-ct-review                 | fee=   161 | Abdominal CT Review
--   visible | svc-general-surgery-appendix-ct-review                  | fee=   138 | Appendix CT Review
--   visible | svc-general-surgery-gallbladder-ultrasound-review       | fee=   115 | Gallbladder Ultrasound Review
--   visible | svc-general-surgery-hernia-assessment-review            | fee=   138 | Hernia Assessment Review
--   visible | svc-general-surgery-post-op-complication-review         | fee=   207 | Post-Op Complication Review
--   hidden  | 005ef4aa-01f2-4566-a418-8c9882542e6f                    | fee=   560 | Post-operative Imaging Review
--   visible | svc-general-surgery-pre-op-surgical-report-review       | fee=   184 | Pre-Op Surgical Report Review
--   hidden  | 00395421-722c-4994-8f87-c503b04a3896                    | fee=   640 | Pre-operative Assessment Review
--   visible | svc-general-surgery-surgical-biopsy-review              | fee=   207 | Surgical Biopsy Review
--   visible | svc-general-surgery-wound-care-assessment-review        | fee=   115 | Wound Care Assessment Review
--
-- spec-hematology (2 rows)
--   visible | svc-hematology-cbc-differential-review                  | fee=   250 | CBC & Differential Review
--   visible | svc-hematology-coagulation-disorder-review              | fee=   300 | Coagulation Disorder Review
--
-- spec-internal-medicine (3 rows)
--   hidden  | 00850a2b-4d53-4866-877b-f2c3414b288a                    | fee=   560 | Chronic Disease Management Review
--   hidden  | 0086d55b-0c1b-49c2-ae8c-97d0d70584ce                    | fee=   400 | Comprehensive Blood Panel Review
--   hidden  | 0123e5ba-4525-4df1-8d9f-0ab218b22627                    | fee=   480 | General Second Opinion
--
-- spec-neurology (6 rows)
--   visible | svc-neurology-brain-ct-scan-review                      | fee=   300 | Brain CT Scan Review
--   visible | svc-neurology-cerebral-angiography-review               | fee=   230 | Cerebral Angiography Review
--   visible | 017c2399-6059-4696-96d2-dc478906a097                    | fee=   300 | EEG Review
--   visible | svc-neurology-emg-review                                | fee=   300 | EMG Review
--   visible | 0273d7cd-d88d-4978-9d94-cc8a9da18e9b                    | fee=   300 | Nerve Conduction Study Review
--   visible | svc-neurology-spine-mri-review                          | fee=   230 | Spine MRI Review
--
-- spec-oncology (5 rows)
--   hidden  | 01f0a353-fe1e-4ba7-aa59-2310b0c8b3d6                    | fee=   960 | Oncology Case Review
--   hidden  | 009e6a67-91ad-470e-84de-db95b157a461                    | fee=  1200 | PET Scan Review
--   visible | svc-oncology-post-treatment-mri-review                  | fee=   230 | Post-Treatment MRI Review
--   visible | svc-oncology-staging-ct-scan-review                     | fee=   230 | Staging CT Scan Review
--   visible | svc-oncology-tumor-biopsy-review                        | fee=   276 | Tumor Biopsy Review
--
-- spec-ophthalmology (4 rows)
--   visible | svc-ophthalmology-corneal-topography-review             | fee=   161 | Corneal Topography Review
--   visible | svc-ophthalmology-orbital-mri-review                    | fee=   207 | Orbital MRI Review
--   visible | svc-ophthalmology-retinal-oct-review                    | fee=   161 | Retinal OCT Review
--   hidden  | 035bdd2a-030d-4f5b-8283-59afb8b68b9f                    | fee=   480 | Retinal Scan Review
--
-- spec-orthopedics (8 rows)
--   visible | svc-orthopedics-arthroscopy-report-review               | fee=   184 | Arthroscopy Report Review
--   visible | 025cbbde-ebb1-47f5-9c6d-b812c9bff781                    | fee=    80 | Bone X-Ray Review
--   visible | 003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057                    | fee=   250 | DEXA Scan Review
--   visible | 014ad203-f858-404d-af30-8168a4779522                    | fee=   207 | Joint MRI Review
--   visible | svc-orthopedics-joint-replacement-pre-op-review         | fee=   230 | Joint Replacement Pre-Op Review
--   visible | svc-orthopedics-scoliosis-x-ray-review                  | fee=   115 | Scoliosis X-Ray Review
--   visible | 00a4fdbc-8bc7-42b2-a35d-af5823b477de                    | fee=   207 | Spine MRI Review
--   visible | svc-orthopedics-sports-injury-mri-review                | fee=   207 | Sports Injury MRI Review
--
-- spec-pediatrics (9 rows)
--   visible | svc-pediatrics-adhd-neuro-assessment-review             | fee=   161 | ADHD/Neuro Assessment Review
--   visible | 02a67b4e-c42d-49b7-a2fc-518b3aac938f                    | fee=   138 | Growth & Development Review
--   visible | svc-pediatrics-neonatal-screening-review                | fee=   138 | Neonatal Screening Review
--   visible | svc-pediatrics-pediatric-abdominal-ultrasound-review    | fee=   115 | Pediatric Abdominal Ultrasound Review
--   visible | 01e95f20-aabc-4fcb-9583-c1a0ffba5a8d                    | fee=    80 | Pediatric Blood Work Review
--   visible | svc-pediatrics-pediatric-brain-mri-review               | fee=   207 | Pediatric Brain MRI Review
--   visible | svc-pediatrics-pediatric-echo-review                    | fee=   161 | Pediatric Echo Review
--   visible | 0260e565-52c4-4256-a93f-ab6c46d9bc14                    | fee=    80 | Pediatric X-Ray Review
--   visible | svc-pediatrics-vaccination-immunology-review            | fee=    92 | Vaccination & Immunology Review
--
-- spec-pulmonology (7 rows)
--   hidden  | 013748a2-439f-4a12-b283-a6da145ee5d4                    | fee=   640 | Chest CT Review
--   visible | svc-pulmonology-chest-ct-scan-review                    | fee=   161 | Chest CT Scan Review
--   visible | svc-pulmonology-ctpa-pe-protocol-review                 | fee=   184 | CTPA (PE Protocol) Review
--   visible | svc-pulmonology-high-resolution-ct-hrct-review          | fee=   184 | High-Resolution CT (HRCT) Review
--   visible | svc-pulmonology-lung-biopsy-review                      | fee=   230 | Lung Biopsy Review
--   visible | svc-pulmonology-pleural-fluid-analysis-review           | fee=   138 | Pleural Fluid Analysis Review
--   visible | svc-pulmonology-sleep-study-review                      | fee=   300 | Sleep Study Review
--
-- spec-radiology (5 rows)
--   visible | svc-radiology-dexa-scan-review                          | fee=   250 | DEXA Scan Review
--   visible | svc-radiology-interventional-radiology-case-review      | fee=   230 | Interventional Radiology Case Review
--   visible | 011cacad-5ec7-4c6b-ab01-3919081796e2                    | fee=   300 | Mammogram Review
--   visible | svc-radiology-nuclear-medicine-scan-review              | fee=   184 | Nuclear Medicine Scan Review
--   visible | svc-radiology-pet-ct-scan-review                        | fee=   276 | PET-CT Scan Review
--
-- spec-urology (9 rows)
--   visible | svc-urology-bladder-ct-review                           | fee=   161 | Bladder CT Review
--   visible | svc-urology-kidney-biopsy-review                        | fee=   230 | Kidney Biopsy Review
--   visible | svc-urology-prostate-mri-review                         | fee=   207 | Prostate MRI Review
--   hidden  | 0566e90d-bf71-46fb-bbab-7480c2e7552f                    | fee=   400 | PSA / Prostate Review
--   visible | svc-urology-psa-test-review                             | fee=    58 | PSA Test Review
--   visible | svc-urology-renal-ct-scan-review                        | fee=   161 | Renal CT Scan Review
--   visible | svc-urology-testicular-ultrasound-review                | fee=   115 | Testicular Ultrasound Review
--   hidden  | 00a89f90-6d8f-4ffe-9208-b90dd324cd17                    | fee=   240 | Urinalysis Review
--   visible | svc-urology-urodynamics-review                          | fee=   161 | Urodynamics Review

BEGIN;

UPDATE services
SET is_visible = false
WHERE id IN (
  '002f73f4-39c5-4e10-8027-a572f02cc18d',
  '00395421-722c-4994-8f87-c503b04a3896',
  '003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057',
  '004e845e-7a96-4818-8bb7-7a9804c9bbe5',
  '0052a110-1ddc-4639-9e50-d88a5ab99f22',
  '005a6fd5-2ac0-4bc7-9edd-7a5092b1b896',
  '005ef4aa-01f2-4566-a418-8c9882542e6f',
  '00850a2b-4d53-4866-877b-f2c3414b288a',
  '0086d55b-0c1b-49c2-ae8c-97d0d70584ce',
  '0096b0ce-98dc-4211-a45d-b36dbd4eb867',
  '009e6a67-91ad-470e-84de-db95b157a461',
  '00a4fdbc-8bc7-42b2-a35d-af5823b477de',
  '00a5d1c9-6616-4595-b9f1-cf5730a97520',
  '00a85f9d-313a-4905-aa2d-50e9c4beafd1',
  '00a89f90-6d8f-4ffe-9208-b90dd324cd17',
  '011cacad-5ec7-4c6b-ab01-3919081796e2',
  '0123e5ba-4525-4df1-8d9f-0ab218b22627',
  '013748a2-439f-4a12-b283-a6da145ee5d4',
  '014ad203-f858-404d-af30-8168a4779522',
  '0167d79b-1ac6-49e8-9d36-14d6cf410fb6',
  '01734b45-bf72-43d3-8ed8-0840ae256ae3',
  '0178b4b3-998c-4f22-b8ad-244e527cf32c',
  '017c2399-6059-4696-96d2-dc478906a097',
  '01d596fd-16ec-472f-bed0-25ae8993d165',
  '01e95f20-aabc-4fcb-9583-c1a0ffba5a8d',
  '01f0a353-fe1e-4ba7-aa59-2310b0c8b3d6',
  '020abdf1-b8f6-444e-8bde-27d86103e2e7',
  '023495cb-67d6-43b8-9f3a-f6accdaf3f39',
  '025cbbde-ebb1-47f5-9c6d-b812c9bff781',
  '0260e565-52c4-4256-a93f-ab6c46d9bc14',
  '0273d7cd-d88d-4978-9d94-cc8a9da18e9b',
  '02a67b4e-c42d-49b7-a2fc-518b3aac938f',
  '02e935a9-fb3b-46e2-831b-b1e31a9494f9',
  '035bdd2a-030d-4f5b-8283-59afb8b68b9f',
  '0566e90d-bf71-46fb-bbab-7480c2e7552f',
  'lab_autoimmune',
  'lab_bm_smear_biopsy',
  'lab_coag',
  'lab_cytology_fluids',
  'lab_cytology_fna',
  'lab_cytology_pap',
  'lab_electrolytes',
  'lab_histopath_biopsy',
  'lab_hormones',
  'lab_kidney',
  'lab_liver',
  'lab_micro_cultures',
  'lab_micro_sensitivity',
  'lab_tumor_markers',
  'svc-cardiology-cardiac-ct-angiography-review',
  'svc-cardiology-cardiac-mri-review',
  'svc-cardiology-coronary-angiogram-review',
  'svc-cardiology-stress-test-review',
  'svc-dermatology-hair-loss-investigation-review',
  'svc-dermatology-melanoma-staging-review',
  'svc-dermatology-psoriasis-case-review',
  'svc-dermatology-skin-allergy-panel-review',
  'svc-dermatology-wound-assessment-review',
  'svc-endocrinology-adrenal-gland-mri-review',
  'svc-endocrinology-hormone-panel-review',
  'svc-endocrinology-parathyroid-scan-review',
  'svc-endocrinology-thyroid-biopsy-fna-review',
  'svc-ent-ct-sinuses-review',
  'svc-ent-hearing-test-audiogram-review',
  'svc-ent-laryngoscopy-report-review',
  'svc-ent-neck-mri-review',
  'svc-ent-salivary-gland-ultrasound-review',
  'svc-ent-temporal-bone-ct-review',
  'svc-ent-thyroid-ultrasound-review',
  'svc-ent-tympanometry-review',
  'svc-gastroenterology-abdominal-ct-scan-review',
  'svc-gastroenterology-celiac-disease-panel-review',
  'svc-gastroenterology-h-pylori-test-review',
  'svc-gastroenterology-inflammatory-bowel-disease-review',
  'svc-gastroenterology-liver-biopsy-review',
  'svc-general-surgery-abdominal-ct-review',
  'svc-general-surgery-appendix-ct-review',
  'svc-general-surgery-gallbladder-ultrasound-review',
  'svc-general-surgery-hernia-assessment-review',
  'svc-general-surgery-post-op-complication-review',
  'svc-general-surgery-pre-op-surgical-report-review',
  'svc-general-surgery-surgical-biopsy-review',
  'svc-general-surgery-wound-care-assessment-review',
  'svc-hematology-cbc-differential-review',
  'svc-hematology-coagulation-disorder-review',
  'svc-lab-pathology-infectious-disease-panel-review',
  'svc-lab-pathology-lipid-panel-review',
  'svc-lab-pathology-metabolic-panel-review',
  'svc-lab-pathology-thyroid-panel-review',
  'svc-neurology-brain-ct-scan-review',
  'svc-neurology-cerebral-angiography-review',
  'svc-neurology-emg-review',
  'svc-neurology-spine-mri-review',
  'svc-oncology-post-treatment-mri-review',
  'svc-oncology-staging-ct-scan-review',
  'svc-oncology-tumor-biopsy-review',
  'svc-ophthalmology-corneal-topography-review',
  'svc-ophthalmology-orbital-mri-review',
  'svc-ophthalmology-retinal-oct-review',
  'svc-orthopedics-arthroscopy-report-review',
  'svc-orthopedics-joint-replacement-pre-op-review',
  'svc-orthopedics-scoliosis-x-ray-review',
  'svc-orthopedics-sports-injury-mri-review',
  'svc-pediatrics-adhd-neuro-assessment-review',
  'svc-pediatrics-neonatal-screening-review',
  'svc-pediatrics-pediatric-abdominal-ultrasound-review',
  'svc-pediatrics-pediatric-brain-mri-review',
  'svc-pediatrics-pediatric-echo-review',
  'svc-pediatrics-vaccination-immunology-review',
  'svc-pulmonology-chest-ct-scan-review',
  'svc-pulmonology-ctpa-pe-protocol-review',
  'svc-pulmonology-high-resolution-ct-hrct-review',
  'svc-pulmonology-lung-biopsy-review',
  'svc-pulmonology-pleural-fluid-analysis-review',
  'svc-pulmonology-sleep-study-review',
  'svc-radiology-dexa-scan-review',
  'svc-radiology-interventional-radiology-case-review',
  'svc-radiology-nuclear-medicine-scan-review',
  'svc-radiology-pet-ct-scan-review',
  'svc-urology-bladder-ct-review',
  'svc-urology-kidney-biopsy-review',
  'svc-urology-prostate-mri-review',
  'svc-urology-psa-test-review',
  'svc-urology-renal-ct-scan-review',
  'svc-urology-testicular-ultrasound-review',
  'svc-urology-urodynamics-review'
);

-- Sanity check inside transaction (will fail the migration if pre-flight invariants drift):
DO $$
DECLARE
  hidden_count integer;
BEGIN
  SELECT COUNT(*) INTO hidden_count
  FROM services
  WHERE id IN (
    '002f73f4-39c5-4e10-8027-a572f02cc18d',
    '00395421-722c-4994-8f87-c503b04a3896',
    '003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057',
    '004e845e-7a96-4818-8bb7-7a9804c9bbe5',
    '0052a110-1ddc-4639-9e50-d88a5ab99f22',
    '005a6fd5-2ac0-4bc7-9edd-7a5092b1b896',
    '005ef4aa-01f2-4566-a418-8c9882542e6f',
    '00850a2b-4d53-4866-877b-f2c3414b288a',
    '0086d55b-0c1b-49c2-ae8c-97d0d70584ce',
    '0096b0ce-98dc-4211-a45d-b36dbd4eb867',
    '009e6a67-91ad-470e-84de-db95b157a461',
    '00a4fdbc-8bc7-42b2-a35d-af5823b477de',
    '00a5d1c9-6616-4595-b9f1-cf5730a97520',
    '00a85f9d-313a-4905-aa2d-50e9c4beafd1',
    '00a89f90-6d8f-4ffe-9208-b90dd324cd17',
    '011cacad-5ec7-4c6b-ab01-3919081796e2',
    '0123e5ba-4525-4df1-8d9f-0ab218b22627',
    '013748a2-439f-4a12-b283-a6da145ee5d4',
    '014ad203-f858-404d-af30-8168a4779522',
    '0167d79b-1ac6-49e8-9d36-14d6cf410fb6',
    '01734b45-bf72-43d3-8ed8-0840ae256ae3',
    '0178b4b3-998c-4f22-b8ad-244e527cf32c',
    '017c2399-6059-4696-96d2-dc478906a097',
    '01d596fd-16ec-472f-bed0-25ae8993d165',
    '01e95f20-aabc-4fcb-9583-c1a0ffba5a8d',
    '01f0a353-fe1e-4ba7-aa59-2310b0c8b3d6',
    '020abdf1-b8f6-444e-8bde-27d86103e2e7',
    '023495cb-67d6-43b8-9f3a-f6accdaf3f39',
    '025cbbde-ebb1-47f5-9c6d-b812c9bff781',
    '0260e565-52c4-4256-a93f-ab6c46d9bc14',
    '0273d7cd-d88d-4978-9d94-cc8a9da18e9b',
    '02a67b4e-c42d-49b7-a2fc-518b3aac938f',
    '02e935a9-fb3b-46e2-831b-b1e31a9494f9',
    '035bdd2a-030d-4f5b-8283-59afb8b68b9f',
    '0566e90d-bf71-46fb-bbab-7480c2e7552f',
    'lab_autoimmune',
    'lab_bm_smear_biopsy',
    'lab_coag',
    'lab_cytology_fluids',
    'lab_cytology_fna',
    'lab_cytology_pap',
    'lab_electrolytes',
    'lab_histopath_biopsy',
    'lab_hormones',
    'lab_kidney',
    'lab_liver',
    'lab_micro_cultures',
    'lab_micro_sensitivity',
    'lab_tumor_markers',
    'svc-cardiology-cardiac-ct-angiography-review',
    'svc-cardiology-cardiac-mri-review',
    'svc-cardiology-coronary-angiogram-review',
    'svc-cardiology-stress-test-review',
    'svc-dermatology-hair-loss-investigation-review',
    'svc-dermatology-melanoma-staging-review',
    'svc-dermatology-psoriasis-case-review',
    'svc-dermatology-skin-allergy-panel-review',
    'svc-dermatology-wound-assessment-review',
    'svc-endocrinology-adrenal-gland-mri-review',
    'svc-endocrinology-hormone-panel-review',
    'svc-endocrinology-parathyroid-scan-review',
    'svc-endocrinology-thyroid-biopsy-fna-review',
    'svc-ent-ct-sinuses-review',
    'svc-ent-hearing-test-audiogram-review',
    'svc-ent-laryngoscopy-report-review',
    'svc-ent-neck-mri-review',
    'svc-ent-salivary-gland-ultrasound-review',
    'svc-ent-temporal-bone-ct-review',
    'svc-ent-thyroid-ultrasound-review',
    'svc-ent-tympanometry-review',
    'svc-gastroenterology-abdominal-ct-scan-review',
    'svc-gastroenterology-celiac-disease-panel-review',
    'svc-gastroenterology-h-pylori-test-review',
    'svc-gastroenterology-inflammatory-bowel-disease-review',
    'svc-gastroenterology-liver-biopsy-review',
    'svc-general-surgery-abdominal-ct-review',
    'svc-general-surgery-appendix-ct-review',
    'svc-general-surgery-gallbladder-ultrasound-review',
    'svc-general-surgery-hernia-assessment-review',
    'svc-general-surgery-post-op-complication-review',
    'svc-general-surgery-pre-op-surgical-report-review',
    'svc-general-surgery-surgical-biopsy-review',
    'svc-general-surgery-wound-care-assessment-review',
    'svc-hematology-cbc-differential-review',
    'svc-hematology-coagulation-disorder-review',
    'svc-lab-pathology-infectious-disease-panel-review',
    'svc-lab-pathology-lipid-panel-review',
    'svc-lab-pathology-metabolic-panel-review',
    'svc-lab-pathology-thyroid-panel-review',
    'svc-neurology-brain-ct-scan-review',
    'svc-neurology-cerebral-angiography-review',
    'svc-neurology-emg-review',
    'svc-neurology-spine-mri-review',
    'svc-oncology-post-treatment-mri-review',
    'svc-oncology-staging-ct-scan-review',
    'svc-oncology-tumor-biopsy-review',
    'svc-ophthalmology-corneal-topography-review',
    'svc-ophthalmology-orbital-mri-review',
    'svc-ophthalmology-retinal-oct-review',
    'svc-orthopedics-arthroscopy-report-review',
    'svc-orthopedics-joint-replacement-pre-op-review',
    'svc-orthopedics-scoliosis-x-ray-review',
    'svc-orthopedics-sports-injury-mri-review',
    'svc-pediatrics-adhd-neuro-assessment-review',
    'svc-pediatrics-neonatal-screening-review',
    'svc-pediatrics-pediatric-abdominal-ultrasound-review',
    'svc-pediatrics-pediatric-brain-mri-review',
    'svc-pediatrics-pediatric-echo-review',
    'svc-pediatrics-vaccination-immunology-review',
    'svc-pulmonology-chest-ct-scan-review',
    'svc-pulmonology-ctpa-pe-protocol-review',
    'svc-pulmonology-high-resolution-ct-hrct-review',
    'svc-pulmonology-lung-biopsy-review',
    'svc-pulmonology-pleural-fluid-analysis-review',
    'svc-pulmonology-sleep-study-review',
    'svc-radiology-dexa-scan-review',
    'svc-radiology-interventional-radiology-case-review',
    'svc-radiology-nuclear-medicine-scan-review',
    'svc-radiology-pet-ct-scan-review',
    'svc-urology-bladder-ct-review',
    'svc-urology-kidney-biopsy-review',
    'svc-urology-prostate-mri-review',
    'svc-urology-psa-test-review',
    'svc-urology-renal-ct-scan-review',
    'svc-urology-testicular-ultrasound-review',
    'svc-urology-urodynamics-review'
  ) AND is_visible = false;
  IF hidden_count <> 126 THEN
    RAISE EXCEPTION 'migration 050 failed post-condition: expected 126 hidden, got %', hidden_count;
  END IF;
END $$;

COMMIT;
