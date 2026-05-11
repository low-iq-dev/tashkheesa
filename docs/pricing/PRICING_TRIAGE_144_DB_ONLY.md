# Triage — 144 DB-only Services (v4 Reconciliation)

**Generated:** 2026-05-11  
**Source:** §4 of `docs/pricing/PRICING_RECONCILIATION_v4.md`  
**Scope:** services currently in DB but NOT referenced by either tab of `Tashkheesa_Canonical_Pricing_v4.xlsx`  
**Constraint:** read-only queries; no DB modifications; recommendations only, not auto-applied

## Summary

| Metric | Count |
|---|---:|
| Total DB-only rows | **144** |
| Rows with ≥ 1 historical order | **0** |
| Rows unpriced (NULL or 0 `base_price`) | **0** |
| Rows below doctor-fee floor (< 250 EGP) | **82** |
| Currently `is_visible=true` | **110** |

**Recommendation breakdown:**

| Proposed action | Count |
|---|---:|
| KEEP | **0** |
| BUMP | **0** |
| HIDE | **126** |
| DELETE | **0** |
| NEEDS_DECISION | **18** |

## Key observations

- **Zero historical orders across all 144 rows.** Every one of these services has never been booked. This means hide/delete actions carry no order-history risk — the FK pre-flight check from §4 of the reconciliation report is moot for these rows.
- **All 144 rows are priced** (none NULL or 0). The 89 unpriced services that issue #48 originally targeted are all referenced by the v4 sheet (matched in §1 or excluded in §4.1); none fell through to this DB-only bucket.
- **82 rows (56%) are below the 250 EGP doctor-fee floor.** Strict reading of the BUMP rule would mark all of these for bump-to-1250, but since they are NOT on the canonical sheet, bumping them would create unsanctioned launchable SKUs. Recommendation overrides to HIDE.
- **The `DELETE` rule never triggers** for these 144 rows — it requires `unpriced + no orders + not on sheet`, but none are unpriced. The 38 hard-delete candidates from the v4 sheet are in §4.1 of the reconciliation report, not here.
- **3 rows are `spec-internal-medicine`** — Internal Medicine is not a specialty on the v4 sheet at all. These need a higher-level decision: does Internal Medicine launch in v4 or not?

## Triage table

Sorted by `order_count` DESC, then `specialty_id`, then `name`. Since all 144 have `order_count = 0`, ordering is effectively (specialty, name).

| # | db_id | specialty_id | name | base_price | doctor_fee | fee_pct | visible | orders | proposed_action | reason |
|--:|---|---|---|---:|---:|---:|:-:|---:|---|---|
| 1 | `addon_priority_24hr` | `addon` | 24-Hour Priority Review | 500 | 75 | 15% | ✗ | 0 | **NEEDS_DECISION** | addon out of v4 pricing-reset scope — leave for separate review |
| 2 | `addon_prescription` | `addon` | Prescription Service | 350 | 53 | 15% | ✗ | 0 | **NEEDS_DECISION** | addon out of v4 pricing-reset scope — leave for separate review |
| 3 | `lab_autoimmune` | `lab_pathology` | Autoimmune panels | 7,100 | 1,065 | 15% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 4 | `00a85f9d-313a-4905-aa2d-50e9c4beafd1` | `lab_pathology` | Biopsy / Histopathology Review | 900 | 720 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 5 | `02e935a9-fb3b-46e2-831b-b1e31a9494f9` | `lab_pathology` | Blood Work Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + legacy UUID id (pre-mig-011 seed) + no sheet counterpart |
| 6 | `lab_bm_smear_biopsy` | `lab_pathology` | Bone marrow smear & biopsy reports | 12,000 | 1,800 | 15% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 7 | `svc-lab-pathology-cbc-analysis-review` | `lab_pathology` | CBC Analysis Review | 1,250 | 250 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 8 | `lab_coag` | `lab_pathology` | Coagulation studies | 600 | 90 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 9 | `lab_cytology_fluids` | `lab_pathology` | Cytology: Body fluids | 1,050 | 158 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 10 | `lab_cytology_fna` | `lab_pathology` | Cytology: Fine needle aspiration (FNA) | 1,700 | 255 | 15% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 11 | `lab_cytology_pap` | `lab_pathology` | Cytology: Pap smear | 1,050 | 158 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 12 | `lab_electrolytes` | `lab_pathology` | Electrolytes | 550 | 83 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 13 | `lab_histopath_biopsy` | `lab_pathology` | Histopathology reports (biopsies) | 4,450 | 668 | 15% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 14 | `lab_hormones` | `lab_pathology` | Hormonal profiles | 1,550 | 233 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 15 | `svc-lab-pathology-infectious-disease-panel-review` | `lab_pathology` | Infectious Disease Panel Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'hormone panel review' — likely duplicate of canonical v4 SKU |
| 16 | `lab_kidney` | `lab_pathology` | Kidney function | 650 | 98 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 17 | `svc-lab-pathology-kidney-function-test-review` | `lab_pathology` | Kidney Function Test Review | 1,250 | 250 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 18 | `svc-lab-pathology-lipid-panel-review` | `lab_pathology` | Lipid Panel Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'hormone panel review' — likely duplicate of canonical v4 SKU |
| 19 | `lab_liver` | `lab_pathology` | Liver function | 900 | 135 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 20 | `svc-lab-pathology-liver-function-test-review` | `lab_pathology` | Liver Function Test Review | 1,250 | 250 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 21 | `svc-lab-pathology-metabolic-panel-review` | `lab_pathology` | Metabolic Panel Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'hormone panel review' — likely duplicate of canonical v4 SKU |
| 22 | `lab_micro_cultures` | `lab_pathology` | Microbiology: Bacterial cultures | 1,000 | 150 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 23 | `lab_micro_sensitivity` | `lab_pathology` | Microbiology: Sensitivity results | 1,000 | 150 | 15% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 24 | `svc-lab-pathology-thyroid-panel-review` | `lab_pathology` | Thyroid Panel Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'hormone panel review' — likely duplicate of canonical v4 SKU |
| 25 | `004e845e-7a96-4818-8bb7-7a9804c9bbe5` | `lab_pathology` | Tumor Marker Review | 600 | 480 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 26 | `lab_tumor_markers` | `lab_pathology` | Tumor markers | 3,300 | 495 | 15% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 27 | `0096b0ce-98dc-4211-a45d-b36dbd4eb867` | `spec-cardiology` | Cardiac Catheterization Review | 1,380 | 276 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'cardiac mr review' — likely duplicate of canonical v4 SKU |
| 28 | `svc-cardiology-cardiac-ct-angiography-review` | `spec-cardiology` | Cardiac CT Angiography Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'ct coronary angiography review' — likely duplicate of canonical v4 SKU |
| 29 | `svc-cardiology-cardiac-mri-review` | `spec-cardiology` | Cardiac MRI Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'cardiac mr review' — likely duplicate of canonical v4 SKU |
| 30 | `svc-cardiology-coronary-angiogram-review` | `spec-cardiology` | Coronary Angiogram Review | 1,380 | 276 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'ct coronary angiography review' — likely duplicate of canonical v4 SKU |
| 31 | `0178b4b3-998c-4f22-b8ad-244e527cf32c` | `spec-cardiology` | ECG Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + legacy UUID id (pre-mig-011 seed) + no sheet counterpart |
| 32 | `svc-cardiology-electrophysiology-study-review` | `spec-cardiology` | Electrophysiology Study Review | 1,380 | 276 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 33 | `01734b45-bf72-43d3-8ed8-0840ae256ae3` | `spec-cardiology` | Holter Monitor Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'holter monitor (24-72h) review' — likely duplicate of canonical v4 SKU |
| 34 | `svc-cardiology-stress-test-review` | `spec-cardiology` | Stress Test Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'stress treadmill test review' — likely duplicate of canonical v4 SKU |
| 35 | `023495cb-67d6-43b8-9f3a-f6accdaf3f39` | `spec-dermatology` | Dermoscopy Image Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + close name match to sheet row 'dermoscopy review' — likely duplicate of canonical v4 SKU |
| 36 | `svc-dermatology-hair-loss-investigation-review` | `spec-dermatology` | Hair Loss Investigation Review | 518 | 104 | 80% | ✓ | 0 | **HIDE** | below floor (fee=104) + 0 orders + close name match to sheet row 'hair loss workup review' — likely duplicate of canonical v4 SKU |
| 37 | `svc-dermatology-melanoma-staging-review` | `spec-dermatology` | Melanoma Staging Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 38 | `svc-dermatology-psoriasis-case-review` | `spec-dermatology` | Psoriasis Case Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + close name match to sheet row 'psoriasis management review' — likely duplicate of canonical v4 SKU |
| 39 | `svc-dermatology-skin-allergy-panel-review` | `spec-dermatology` | Skin Allergy Panel Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + close name match to sheet row 'autoimmune skin panel review' — likely duplicate of canonical v4 SKU |
| 40 | `002f73f4-39c5-4e10-8027-a572f02cc18d` | `spec-dermatology` | Skin Biopsy Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + close name match to sheet row 'skin biopsy report review' — likely duplicate of canonical v4 SKU |
| 41 | `svc-dermatology-wound-assessment-review` | `spec-dermatology` | Wound Assessment Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + close name match to sheet row 'chronic wound review' — likely duplicate of canonical v4 SKU |
| 42 | `svc-endocrinology-adrenal-gland-mri-review` | `spec-endocrinology` | Adrenal Gland MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'pituitary mri review' — likely duplicate of canonical v4 SKU |
| 43 | `0167d79b-1ac6-49e8-9d36-14d6cf410fb6` | `spec-endocrinology` | Hormonal Profile Review | 500 | 400 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 44 | `svc-endocrinology-hormone-panel-review` | `spec-endocrinology` | Hormone Panel Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'growth hormone panel review' — likely duplicate of canonical v4 SKU |
| 45 | `svc-endocrinology-parathyroid-scan-review` | `spec-endocrinology` | Parathyroid Scan Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 46 | `svc-endocrinology-thyroid-biopsy-fna-review` | `spec-endocrinology` | Thyroid Biopsy (FNA) Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'thyroid ultrasound review' — likely duplicate of canonical v4 SKU |
| 47 | `00a5d1c9-6616-4595-b9f1-cf5730a97520` | `spec-endocrinology` | Thyroid Panel Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'full thyroid panel review' — likely duplicate of canonical v4 SKU |
| 48 | `01d596fd-16ec-472f-bed0-25ae8993d165` | `spec-ent` | Audiogram Review | 400 | 320 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 49 | `svc-ent-ct-sinuses-review` | `spec-ent` | CT Sinuses Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 50 | `svc-ent-hearing-test-audiogram-review` | `spec-ent` | Hearing Test (Audiogram) Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 51 | `svc-ent-laryngoscopy-report-review` | `spec-ent` | Laryngoscopy Report Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 52 | `svc-ent-neck-mri-review` | `spec-ent` | Neck MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 53 | `svc-ent-salivary-gland-ultrasound-review` | `spec-ent` | Salivary Gland Ultrasound Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 54 | `020abdf1-b8f6-444e-8bde-27d86103e2e7` | `spec-ent` | Sinus CT Review | 700 | 560 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 55 | `svc-ent-temporal-bone-ct-review` | `spec-ent` | Temporal Bone CT Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 56 | `svc-ent-thyroid-ultrasound-review` | `spec-ent` | Thyroid Ultrasound Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 57 | `svc-ent-tympanometry-review` | `spec-ent` | Tympanometry Review | 402 | 80 | 80% | ✓ | 0 | **HIDE** | below floor (fee=80) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 58 | `005a6fd5-2ac0-4bc7-9edd-7a5092b1b896` | `spec-gastroenterology` | Abdominal CT Review | 800 | 640 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 59 | `svc-gastroenterology-abdominal-ct-scan-review` | `spec-gastroenterology` | Abdominal CT Scan Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 60 | `0052a110-1ddc-4639-9e50-d88a5ab99f22` | `spec-gastroenterology` | Abdominal Ultrasound Review | 500 | 400 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 61 | `svc-gastroenterology-celiac-disease-panel-review` | `spec-gastroenterology` | Celiac Disease Panel Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + close name match to sheet row 'hepatitis b/c panel review' — likely duplicate of canonical v4 SKU |
| 62 | `svc-gastroenterology-h-pylori-test-review` | `spec-gastroenterology` | H. pylori Test Review | 345 | 69 | 80% | ✓ | 0 | **HIDE** | below floor (fee=69) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 63 | `svc-gastroenterology-inflammatory-bowel-disease-review` | `spec-gastroenterology` | Inflammatory Bowel Disease Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 64 | `svc-gastroenterology-liver-biopsy-review` | `spec-gastroenterology` | Liver Biopsy Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'liver biopsy report review' — likely duplicate of canonical v4 SKU |
| 65 | `svc-general-surgery-abdominal-ct-review` | `spec-general-surgery` | Abdominal CT Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 66 | `svc-general-surgery-appendix-ct-review` | `spec-general-surgery` | Appendix CT Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 67 | `svc-general-surgery-gallbladder-ultrasound-review` | `spec-general-surgery` | Gallbladder Ultrasound Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 68 | `svc-general-surgery-hernia-assessment-review` | `spec-general-surgery` | Hernia Assessment Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 69 | `svc-general-surgery-post-op-complication-review` | `spec-general-surgery` | Post-Op Complication Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 70 | `005ef4aa-01f2-4566-a418-8c9882542e6f` | `spec-general-surgery` | Post-operative Imaging Review | 700 | 560 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 71 | `svc-general-surgery-pre-op-surgical-report-review` | `spec-general-surgery` | Pre-Op Surgical Report Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 72 | `00395421-722c-4994-8f87-c503b04a3896` | `spec-general-surgery` | Pre-operative Assessment Review | 800 | 640 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 73 | `svc-general-surgery-surgical-biopsy-review` | `spec-general-surgery` | Surgical Biopsy Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 74 | `svc-general-surgery-wound-care-assessment-review` | `spec-general-surgery` | Wound Care Assessment Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 75 | `svc-hematology-blood-film-review` | `spec-hematology` | Blood Film Review | 1,250 | 250 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 76 | `svc-hematology-cbc-differential-review` | `spec-hematology` | CBC & Differential Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'full cbc with differential review' — likely duplicate of canonical v4 SKU |
| 77 | `svc-hematology-coagulation-disorder-review` | `spec-hematology` | Coagulation Disorder Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'coagulation panel review' — likely duplicate of canonical v4 SKU |
| 78 | `svc-hematology-hemoglobin-electrophoresis-review` | `spec-hematology` | Hemoglobin Electrophoresis Review | 1,500 | 300 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 79 | `svc-hematology-iron-studies-review` | `spec-hematology` | Iron Studies Review | 1,250 | 250 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 80 | `svc-hematology-leukemia-case-review` | `spec-hematology` | Leukemia Case Review | 1,380 | 276 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 81 | `svc-hematology-platelet-disorder-review` | `spec-hematology` | Platelet Disorder Review | 1,500 | 300 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 82 | `00850a2b-4d53-4866-877b-f2c3414b288a` | `spec-internal-medicine` | Chronic Disease Management Review | 700 | 560 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 83 | `0086d55b-0c1b-49c2-ae8c-97d0d70584ce` | `spec-internal-medicine` | Comprehensive Blood Panel Review | 500 | 400 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 84 | `0123e5ba-4525-4df1-8d9f-0ab218b22627` | `spec-internal-medicine` | General Second Opinion | 600 | 480 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 85 | `svc-neurology-brain-ct-scan-review` | `spec-neurology` | Brain CT Scan Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'brain ct review' — likely duplicate of canonical v4 SKU |
| 86 | `svc-neurology-cerebral-angiography-review` | `spec-neurology` | Cerebral Angiography Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 87 | `017c2399-6059-4696-96d2-dc478906a097` | `spec-neurology` | EEG Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + legacy UUID id (pre-mig-011 seed) + no sheet counterpart |
| 88 | `svc-neurology-emg-review` | `spec-neurology` | EMG Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'emg/ncs review' — likely duplicate of canonical v4 SKU |
| 89 | `0273d7cd-d88d-4978-9d94-cc8a9da18e9b` | `spec-neurology` | Nerve Conduction Study Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + legacy UUID id (pre-mig-011 seed) + no sheet counterpart |
| 90 | `svc-neurology-neuropsychological-test-review` | `spec-neurology` | Neuropsychological Test Review | 1,500 | 300 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 91 | `svc-neurology-sleep-study-review` | `spec-neurology` | Sleep Study Review | 1,500 | 300 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 92 | `svc-neurology-spine-mri-review` | `spec-neurology` | Spine MRI Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'neuro spine mri review' — likely duplicate of canonical v4 SKU |
| 93 | `svc-oncology-chemotherapy-plan-review` | `spec-oncology` | Chemotherapy Plan Review | 1,725 | 345 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 94 | `svc-oncology-immunotherapy-response-review` | `spec-oncology` | Immunotherapy Response Review | 1,380 | 276 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 95 | `01f0a353-fe1e-4ba7-aa59-2310b0c8b3d6` | `spec-oncology` | Oncology Case Review | 1,200 | 960 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 96 | `009e6a67-91ad-470e-84de-db95b157a461` | `spec-oncology` | PET Scan Review | 1,500 | 1,200 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 97 | `svc-oncology-post-treatment-mri-review` | `spec-oncology` | Post-Treatment MRI Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'ct/mri staging review' — likely duplicate of canonical v4 SKU |
| 98 | `svc-oncology-radiation-therapy-plan-review` | `spec-oncology` | Radiation Therapy Plan Review | 1,725 | 345 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 99 | `svc-oncology-staging-ct-scan-review` | `spec-oncology` | Staging CT Scan Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'ct/mri staging review' — likely duplicate of canonical v4 SKU |
| 100 | `svc-oncology-tumor-biopsy-review` | `spec-oncology` | Tumor Biopsy Review | 1,380 | 276 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'bone marrow biopsy review' — likely duplicate of canonical v4 SKU |
| 101 | `svc-oncology-tumor-board-case-review` | `spec-oncology` | Tumor Board Case Review | 2,070 | 414 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 102 | `svc-ophthalmology-corneal-topography-review` | `spec-ophthalmology` | Corneal Topography Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 103 | `svc-ophthalmology-orbital-mri-review` | `spec-ophthalmology` | Orbital MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'mri orbit review' — likely duplicate of canonical v4 SKU |
| 104 | `svc-ophthalmology-retinal-oct-review` | `spec-ophthalmology` | Retinal OCT Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'oct scan review' — likely duplicate of canonical v4 SKU |
| 105 | `035bdd2a-030d-4f5b-8283-59afb8b68b9f` | `spec-ophthalmology` | Retinal Scan Review | 600 | 480 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 106 | `svc-orthopedics-arthroscopy-report-review` | `spec-orthopedics` | Arthroscopy Report Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 107 | `025cbbde-ebb1-47f5-9c6d-b812c9bff781` | `spec-orthopedics` | Bone X-Ray Review | 402 | 80 | 80% | ✓ | 0 | **HIDE** | below floor (fee=80) + 0 orders + close name match to sheet row 'x-ray review' — likely duplicate of canonical v4 SKU |
| 108 | `003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057` | `spec-orthopedics` | DEXA Scan Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'bone density (dexa) review' — likely duplicate of canonical v4 SKU |
| 109 | `014ad203-f858-404d-af30-8168a4779522` | `spec-orthopedics` | Joint MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'hip mri review' — likely duplicate of canonical v4 SKU |
| 110 | `svc-orthopedics-joint-replacement-pre-op-review` | `spec-orthopedics` | Joint Replacement Pre-Op Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 111 | `svc-orthopedics-scoliosis-x-ray-review` | `spec-orthopedics` | Scoliosis X-Ray Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + close name match to sheet row 'x-ray review' — likely duplicate of canonical v4 SKU |
| 112 | `00a4fdbc-8bc7-42b2-a35d-af5823b477de` | `spec-orthopedics` | Spine MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'hip mri review' — likely duplicate of canonical v4 SKU |
| 113 | `svc-orthopedics-sports-injury-mri-review` | `spec-orthopedics` | Sports Injury MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'hip mri review' — likely duplicate of canonical v4 SKU |
| 114 | `svc-pediatrics-adhd-neuro-assessment-review` | `spec-pediatrics` | ADHD/Neuro Assessment Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 115 | `02a67b4e-c42d-49b7-a2fc-518b3aac938f` | `spec-pediatrics` | Growth & Development Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 116 | `svc-pediatrics-neonatal-screening-review` | `spec-pediatrics` | Neonatal Screening Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 117 | `svc-pediatrics-pediatric-abdominal-ultrasound-review` | `spec-pediatrics` | Pediatric Abdominal Ultrasound Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 118 | `01e95f20-aabc-4fcb-9583-c1a0ffba5a8d` | `spec-pediatrics` | Pediatric Blood Work Review | 402 | 80 | 80% | ✓ | 0 | **HIDE** | below floor (fee=80) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 119 | `svc-pediatrics-pediatric-brain-mri-review` | `spec-pediatrics` | Pediatric Brain MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 120 | `svc-pediatrics-pediatric-echo-review` | `spec-pediatrics` | Pediatric Echo Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 121 | `0260e565-52c4-4256-a93f-ab6c46d9bc14` | `spec-pediatrics` | Pediatric X-Ray Review | 402 | 80 | 80% | ✓ | 0 | **HIDE** | below floor (fee=80) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 122 | `svc-pediatrics-vaccination-immunology-review` | `spec-pediatrics` | Vaccination & Immunology Review | 460 | 92 | 80% | ✓ | 0 | **HIDE** | below floor (fee=92) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 123 | `013748a2-439f-4a12-b283-a6da145ee5d4` | `spec-pulmonology` | Chest CT Review | 800 | 640 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 124 | `svc-pulmonology-chest-ct-scan-review` | `spec-pulmonology` | Chest CT Scan Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'ct chest review' — likely duplicate of canonical v4 SKU |
| 125 | `svc-pulmonology-ctpa-pe-protocol-review` | `spec-pulmonology` | CTPA (PE Protocol) Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 126 | `svc-pulmonology-high-resolution-ct-hrct-review` | `spec-pulmonology` | High-Resolution CT (HRCT) Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + close name match to sheet row 'ct chest review' — likely duplicate of canonical v4 SKU |
| 127 | `svc-pulmonology-lung-biopsy-review` | `spec-pulmonology` | Lung Biopsy Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'post-covid lung review' — likely duplicate of canonical v4 SKU |
| 128 | `svc-pulmonology-pleural-fluid-analysis-review` | `spec-pulmonology` | Pleural Fluid Analysis Review | 690 | 138 | 80% | ✓ | 0 | **HIDE** | below floor (fee=138) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 129 | `svc-pulmonology-sleep-study-review` | `spec-pulmonology` | Sleep Study Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'sleep study (psg) review' — likely duplicate of canonical v4 SKU |
| 130 | `svc-radiology-dexa-scan-review` | `spec-radiology` | DEXA Scan Review | 1,250 | 250 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'ct scan review' — likely duplicate of canonical v4 SKU |
| 131 | `svc-radiology-fluoroscopy-review` | `spec-radiology` | Fluoroscopy Review | 1,500 | 300 | 80% | ✓ | 0 | **NEEDS_DECISION** | ≥ floor + visible + 0 orders + no v4 sheet match — could be intentional non-launch SKU or stale seed |
| 132 | `svc-radiology-interventional-radiology-case-review` | `spec-radiology` | Interventional Radiology Case Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + not on v4 sheet — strict-rule says BUMP, but bumping a non-sheet SKU would create unsanctioned launch row |
| 133 | `011cacad-5ec7-4c6b-ab01-3919081796e2` | `spec-radiology` | Mammogram Review | 1,500 | 300 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + legacy UUID id (pre-mig-011 seed) + no sheet counterpart |
| 134 | `svc-radiology-nuclear-medicine-scan-review` | `spec-radiology` | Nuclear Medicine Scan Review | 920 | 184 | 80% | ✓ | 0 | **HIDE** | below floor (fee=184) + 0 orders + close name match to sheet row 'ct scan review' — likely duplicate of canonical v4 SKU |
| 135 | `svc-radiology-pet-ct-scan-review` | `spec-radiology` | PET-CT Scan Review | 1,380 | 276 | 80% | ✓ | 0 | **HIDE** | ≥ floor + visible + 0 orders + close name match to sheet row 'ct scan review' — likely duplicate of canonical v4 SKU |
| 136 | `svc-urology-bladder-ct-review` | `spec-urology` | Bladder CT Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'bladder ultrasound review' — likely duplicate of canonical v4 SKU |
| 137 | `svc-urology-kidney-biopsy-review` | `spec-urology` | Kidney Biopsy Review | 1,150 | 230 | 80% | ✓ | 0 | **HIDE** | below floor (fee=230) + 0 orders + close name match to sheet row 'kidney/ureter ct review' — likely duplicate of canonical v4 SKU |
| 138 | `svc-urology-prostate-mri-review` | `spec-urology` | Prostate MRI Review | 1,035 | 207 | 80% | ✓ | 0 | **HIDE** | below floor (fee=207) + 0 orders + close name match to sheet row 'mri prostate review' — likely duplicate of canonical v4 SKU |
| 139 | `0566e90d-bf71-46fb-bbab-7480c2e7552f` | `spec-urology` | PSA / Prostate Review | 500 | 400 | 80% | ✗ | 0 | **HIDE** | already hidden — confirm no-op |
| 140 | `svc-urology-psa-test-review` | `spec-urology` | PSA Test Review | 288 | 58 | 80% | ✓ | 0 | **HIDE** | below floor (fee=58) + 0 orders + close name match to sheet row 'psa & prostate panel review' — likely duplicate of canonical v4 SKU |
| 141 | `svc-urology-renal-ct-scan-review` | `spec-urology` | Renal CT Scan Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'renal stone management review' — likely duplicate of canonical v4 SKU |
| 142 | `svc-urology-testicular-ultrasound-review` | `spec-urology` | Testicular Ultrasound Review | 575 | 115 | 80% | ✓ | 0 | **HIDE** | below floor (fee=115) + 0 orders + close name match to sheet row 'bladder ultrasound review' — likely duplicate of canonical v4 SKU |
| 143 | `00a89f90-6d8f-4ffe-9208-b90dd324cd17` | `spec-urology` | Urinalysis Review | 300 | 240 | 80% | ✗ | 0 | **HIDE** | already hidden, below floor — confirm no-op |
| 144 | `svc-urology-urodynamics-review` | `spec-urology` | Urodynamics Review | 805 | 161 | 80% | ✓ | 0 | **HIDE** | below floor (fee=161) + 0 orders + close name match to sheet row 'urodynamics study review' — likely duplicate of canonical v4 SKU |

---

## Notes for Stage 2 migration design

- **126 HIDE recommendations** can be batched into a single `UPDATE services SET is_visible = false WHERE id IN (…)` statement. Reversible.
- **18 NEEDS_DECISION rows** require explicit Ziad-decision per row before migration. These are concentrated in:
  - `spec-hematology`: 5
  - `spec-oncology`: 4
  - `lab_pathology`: 3
  - `addon`: 2
  - `spec-neurology`: 2
  - `spec-cardiology`: 1
  - `spec-radiology`: 1
- **No `DELETE` recommendations.** Hard-delete candidates from the v4 reconciliation live in §4.1 of the reconciliation report (the 38 'Bundled into Panel' lab rows), not in this triage.
- **Nephrology / OB/GYN constraint:** N/A for this triage — both are sheet-only specialties (zero DB rows), so none appear in this list.

