# Pricing Reconciliation — Canonical v4 vs Live DB

**Generated:** 2026-05-11  
**Canonical sheet:** `Tashkheesa_Canonical_Pricing_v4.xlsx`  
**Live DB snapshot:** 269 rows in `services` table (89 with NULL/0 `base_price`)  
**Reference:** side issue #48

> **Stage 1 deliverable.** Read-only. No migration written, no DB modified.

---

## Executive Summary

| Bucket | Count | Action class |
|---|---:|---|
| **§1 — Exact matches** (sheet ↔ DB by id or specialty+name) | **66** | UPDATE price on existing row |
| **§2 — Ambiguous matches** | **0** | None — specialty filter resolved every multi-candidate case |
| **§3 — Sheet-only** (rows NOT in DB) | **71** | INSERT new — see breakdown below |
| **§4 — DB-only** (rows NOT on sheet) | **144** | Review case by case — most are seed leftovers |
| **§5 — Price-mismatch summary** | — | 66 priced today, all change |

**Total Launch Catalog rows on sheet:** 137 (125 Individual + 5 Bumped + 7 Panels)  
**Total Excluded rows on sheet:** 67 (38 Bundled-into-Panel + 10 Psychiatry + 9 Needs-Clarification + 6 Not-at-Shifa + 4 External)

---

## ⚠ Critical findings — read before migration design

These four issues will shape the actual migration. They are NOT bugs in the sheet — they are structural realities that the migration must handle.

**A. Sheet `Service ID` column is a NEW canonical id scheme — do NOT propagate it into the DB.**
The sheet uses clean snake_case ids like `mri_review`, `card_ecg_12lead`. The live DB has a chaotic mix: `svc-{specialty}-{slug}` style (from migration 011-era), bare UUIDs (35 rows — legacy seed), `lab_*` / `rad_*` / `card_*` / `onc_*` / `pulm_*` short-codes, plus `addon_*`. Only 4 sheet ids coincidentally match a DB id today.

Foreign keys reference `services.id` from at least: `orders.service_id`, `doctor_services` junction (migration 034), `addon_services` (019). Renaming `services.id` to match the sheet would cascade-corrupt order history. **The match key for the migration must be `(specialty_id, name)` — not id.**

**B. Two new specialties on the sheet are not in the DB: `Nephrology` (8 SKUs) and `OB/GYN` (9 SKUs) = 17 SKUs.**
The DB `specialties` table has no `spec-nephrology` or `spec-obgyn` row, so these 17 sheet rows currently fall through every matcher as 'no specialty mapping'. Migration must INSERT specialty rows first, then INSERT services with the new `specialty_id`.

**C. ~48 sheet-only rows in existing specialties are renames/restructures, not net-new services.**
Example token-overlap candidates surfaced in §3: sheet 'Knee MRI Review' / 'Hip MRI Review' / 'Shoulder MRI Review' (Orthopedics) all overlap with DB 'Joint MRI Review' — likely an intentional disaggregation. Sheet 'CT Chest Review' (Pulmonology) overlaps with DB 'Chest CT Review' AND 'Chest CT Scan Review' (two near-duplicate DB rows). Each of these needs a manual policy decision before INSERT: rename the existing row, or insert new + retire old?

**D. DB has 144 services not referenced by either sheet tab. Sheet's 'Excluded' tab is not exhaustive.**
Of those 144: 110 are `is_visible=true`, 34 are `is_visible=false`, 35 use legacy UUID ids, and the sheet makes no statement about them. These represent the largest unbounded risk in the migration scope. See §4 for breakdown.

**E. DB has 89 services with NULL/0 `base_price` — issue #48 description quoted 95.** This is a 6-row drift since the issue was filed. Worth confirming with Ziad whether the gap is real or whether some rows have been priced ad-hoc since.

---

## §1 — Exact matches (66)

Match key precedence: (1) sheet `Service ID` == DB `id`; (2) same specialty + exact name; (3) exact name cross-specialty (single candidate).

### §1a — Exact ID match (4)

These sheet ids coincidentally equal a DB id. All 4 are services with NULL `base_price` today; sheet sets them to 1,250 EGP.

| Sheet `Service ID` / DB `id` | Specialty | Name | Old price | New price |
|---|---|---|---:|---:|
| `rad_cxr_review` | Radiology | Chest X-Ray Review | NULL | 1,250 |
| `card_ecg_12lead` | Cardiology | 12-Lead ECG Interpretation | NULL | 1,250 |
| `card_rhythm_strip` | Cardiology | Rhythm Strip Analysis | NULL | 1,250 |
| `lab_cytology` | Lab & Pathology | Cytology | NULL | 1,250 |

### §1b — Specialty + name match (58)

Sheet's specialty maps to a DB `specialty_id`, and DB has exactly one row with that specialty + matching name (case/punctuation-normalised).

| Specialty | DB `id` | Service name | Old price | New price | Δ |
|---|---|---|---:|---:|---:|
| Radiology | `00d3c10b-6375-4ffd-9785-967777acc6e7` | CT Scan Review | 1,500 | 9,085 | +7,585 |
| Radiology | `014c5937-1ed0-4ff2-b424-de07418488ca` | MRI Review | 1,035 | 8,395 | +7,360 |
| Radiology | `016e6e41-7e50-4609-bf49-6d16d6fc0652` | Ultrasound Review | 1,500 | 1,725 | +225 |
| Radiology | `rad_neuro_imaging` | Neuro Imaging Review | NULL | 5,233 | +5,233 |
| Radiology | `rad_spine_mri` | Spine MRI Review | NULL | 9,315 | +9,315 |
| Radiology | `rad_ct_mr_angio` | CT/MR Angiography Review | NULL | 17,480 | +17,480 |
| Radiology | `rad_abd_pelvis_ct_mri` | Abdomen/Pelvis CT/MRI Review | NULL | 8,050 | +8,050 |
| Radiology | `rad_msk_imaging` | Musculoskeletal Imaging Review | NULL | 1,840 | +1,840 |
| Radiology | `rad_cardiac_ct` | Cardiac CT Review | NULL | 7,935 | +7,935 |
| Radiology | `rad_cardiac_mri` | Cardiac MRI Review | NULL | 8,395 | +8,395 |
| Cardiology | `0062fac6-ef3d-43be-a2d2-23bece8494c6` | Echocardiogram Review | 1,500 | 1,380 | -120 |
| Cardiology | `card_stress_treadmill` | Stress Treadmill Test Review | NULL | 1,553 | +1,553 |
| Cardiology | `card_stress_echo` | Stress Echo Review | NULL | 2,070 | +2,070 |
| Cardiology | `card_holter_24_72` | Holter Monitor (24-72h) Review | NULL | 3,450 | +3,450 |
| Cardiology | `card_ctca` | CT Coronary Angiography Review | NULL | 7,935 | +7,935 |
| Cardiology | `card_calcium_score` | Calcium Score Review | NULL | 3,680 | +3,680 |
| Cardiology | `card_cmr` | Cardiac MR Review | NULL | 8,395 | +8,395 |
| Oncology | `onc_ct_mri_staging` | CT/MRI Staging Review | NULL | 17,480 | +17,480 |
| Oncology | `onc_bone_marrow_biopsy` | Bone Marrow Biopsy Review | 1,495 | 11,500 | +10,005 |
| Neurology | `00ba8f5c-4384-48d6-bebb-7ef5132eccfe` | Brain MRI Review | 1,150 | 3,680 | +2,530 |
| Neurology | `neuro_brain_ct` | Brain CT Review | NULL | 1,553 | +1,553 |
| Neurology | `neuro_spine_mri` | Neuro Spine MRI Review | NULL | 9,315 | +9,315 |
| Neurology | `neuro_eeg` | EEG Interpretation | NULL | 13,225 | +13,225 |
| Neurology | `neuro_emg_ncs` | EMG/NCS Review | NULL | 6,900 | +6,900 |
| Neurology | `neuro_cta` | Neuro CTA Review | NULL | 9,085 | +9,085 |
| Neurology | `neuro_mra` | Neuro MRA Review | NULL | 6,210 | +6,210 |
| Lab & Pathology | `lab_autoimmune_anti_dna` | Autoimmune - Anti-DNA | NULL | 1,495 | +1,495 |
| Lab & Pathology | `lab_autoimmune_asma` | Autoimmune - ASMA | NULL | 1,495 | +1,495 |
| Lab & Pathology | `lab_autoimmune_anca` | Autoimmune - ANCA | NULL | 2,530 | +2,530 |
| Lab & Pathology | `lab_histo_small` | Histopathology - Small Biopsy | NULL | 1,668 | +1,668 |
| Lab & Pathology | `lab_histo_large` | Histopathology - Large Biopsy | NULL | 2,990 | +2,990 |
| Lab & Pathology | `lab_histo_organ` | Histopathology - Organ/Resection | NULL | 4,255 | +4,255 |
| Lab & Pathology | `lab_micro_sputum_cs` | Microbiology - Sputum C&S | NULL | 6,900 | +6,900 |
| Lab & Pathology | `lab_bone_marrow` | Bone Marrow Aspirate Review | NULL | 11,500 | +11,500 |
| Orthopedics | `svc-orthopedics-fracture-management-review` | Fracture Management Review | 805 | 3,680 | +2,875 |
| Gastroenterology | `0031d4bc-35da-4fc5-9d69-4ebe2247911e` | Endoscopy Report Review | 920 | 4,485 | +3,565 |
| Gastroenterology | `svc-gastroenterology-colonoscopy-report-review` | Colonoscopy Report Review | 920 | 4,485 | +3,565 |
| Gastroenterology | `svc-gastroenterology-mrcp-review` | MRCP Review | 1,035 | 9,545 | +8,510 |
| Gastroenterology | `svc-gastroenterology-capsule-endoscopy-review` | Capsule Endoscopy Review | 1,150 | 10,465 | +9,315 |
| Endocrinology | `01430733-1446-4886-9477-0fc1aa8d02a0` | Thyroid Ultrasound Review | 575 | 2,185 | +1,610 |
| Endocrinology | `svc-endocrinology-diabetes-management-review` | Diabetes Management Review | 575 | 2,990 | +2,415 |
| Endocrinology | `svc-endocrinology-pituitary-mri-review` | Pituitary MRI Review | 1,035 | 5,175 | +4,140 |
| Pulmonology | `064fa2a7-ab8d-48d6-9376-e14ffff69dc9` | Pulmonary Function Test Review | 575 | 3,680 | +3,105 |
| Pulmonology | `svc-pulmonology-bronchoscopy-report-review` | Bronchoscopy Report Review | 920 | 6,555 | +5,635 |
| Dermatology | `svc-dermatology-patch-test-review` | Patch Test Review | 402 | 2,990 | +2,588 |
| Ophthalmology | `03c367c3-fce1-4d54-8de7-ad829a86f6e6` | OCT Scan Review | 700 | 3,680 | +2,980 |
| Ophthalmology | `svc-ophthalmology-fundus-photography-review` | Fundus Photography Review | 690 | 2,990 | +2,300 |
| Ophthalmology | `svc-ophthalmology-visual-field-test-review` | Visual Field Test Review | 575 | 2,645 | +2,070 |
| Ophthalmology | `svc-ophthalmology-glaucoma-work-up-review` | Glaucoma Work-Up Review | 805 | 5,175 | +4,370 |
| Ophthalmology | `svc-ophthalmology-fluorescein-angiography-review` | Fluorescein Angiography Review | 920 | 6,555 | +5,635 |
| Ophthalmology | `svc-ophthalmology-diabetic-retinopathy-review` | Diabetic Retinopathy Review | 805 | 3,680 | +2,875 |
| Urology | `svc-urology-cystoscopy-report-review` | Cystoscopy Report Review | 920 | 5,980 | +5,060 |
| Hematology | `svc-hematology-bone-marrow-biopsy-review` | Bone Marrow Biopsy Review | 1,495 | 14,950 | +13,455 |
| Hematology | `svc-hematology-flow-cytometry-review` | Flow Cytometry Review | 920 | 13,455 | +12,535 |
| Hematology | `svc-hematology-lymphoma-staging-review` | Lymphoma Staging Review | 1,150 | 13,455 | +12,305 |
| Pulmonology | `0279d2b9-23bf-4f7a-bfa6-10243a39571d` | Chest X-Ray Review | 402 | 1,250 | +848 |
| Lab & Pathology | `svc-lab-pathology-hormone-panel-review` | Hormone Panel Review | 1,250 | 1,750 | +500 |
| Lab & Pathology | `svc-lab-pathology-autoimmune-panel-review` | Autoimmune Panel Review | 1,500 | 1,750 | +250 |

### §1c — Cross-specialty single name match (4)

Sheet's specialty has no row by this name, but exactly one row across the rest of the DB matches. Verify these manually before migration — the specialty assignment will change.

| Sheet specialty | DB `id` | DB specialty | Service name | Old price | New price |
|---|---|---|---|---:|---:|
| Orthopedics | `016b17a1-2add-4c1e-a4c9-34a667e8384f` | `spec-radiology` | X-Ray Review | 1,250 | 1,380 |
| Orthopedics | `svc-endocrinology-bone-density-dexa-review` | `spec-endocrinology` | Bone Density (DEXA) Review | 460 | 1,725 |
| Nephrology | `00de782c-21a2-4624-b124-844a93b46d9b` | `spec-urology` | Kidney Ultrasound Review | 575 | 2,185 |
| Hematology | `svc-lab-pathology-coagulation-panel-review` | `lab_pathology` | Coagulation Panel Review | 1,250 | 2,990 |

---

## §2 — Ambiguous matches (0)

**None.** Earlier passes flagged 7 ambiguous rows (e.g. 'Spine MRI Review' exists under Neurology, Orthopedics, AND Radiology in DB), but every case resolved cleanly once the sheet's `Specialty` column was used to filter candidates. No manual disambiguation needed for the launch catalog.

**Worth noting:** the DB still has 7+ true duplicates (same name, different specialty_id) that the v4 sheet implicitly de-duplicates by claiming exactly one specialty owner. The migration should hide the non-canonical copies — see §4.

---

## §3 — Sheet-only rows (71) — new INSERTs

These 71 rows have no name+specialty match in DB. Breakdown:

- **§3a — In new specialties not in DB**: 16 rows (Nephrology + OB/GYN)
- **§3b — Lab & Pathology panels** (`Category: Panel: ...`): 5 rows
- **§3c — Rename / restructure candidates in existing specialties**: 50 rows

### §3a — Rows in new specialties (16)

Migration step required: INSERT into `specialties` table first, THEN insert these services.

| Specialty | Sheet `Service ID` | Name | Price | Doctor fee |
|---|---|---|---:|---:|
| Nephrology | `kidney_function_panel_review` | Kidney Function Panel Review | 1,725 | 345 |
| Nephrology | `kidney_biopsy_report_review` | Kidney Biopsy Report Review | 10,465 | 2,093 |
| Nephrology | `ckd_staging_and_management_review` | CKD Staging & Management Review | 3,680 | 736 |
| Nephrology | `dialysis_adequacy_review` | Dialysis Adequacy Review | 5,980 | 1,196 |
| Nephrology | `proteinuria_workup_review` | Proteinuria Workup Review | 3,680 | 736 |
| Nephrology | `kidney_stone_ct_review` | Kidney Stone CT Review | 4,140 | 828 |
| Nephrology | `hypertension_workup_review` | Hypertension Workup Review | 3,680 | 736 |
| OB/GYN | `obstetric_ultrasound_review` | Obstetric Ultrasound Review | 2,185 | 437 |
| OB/GYN | `fetal_echocardiography_review` | Fetal Echocardiography Review | 5,980 | 1,196 |
| OB/GYN | `gynaecological_ultrasound_review` | Gynaecological Ultrasound Review | 2,185 | 437 |
| OB/GYN | `pap_smear_report_review` | Pap Smear Report Review | 1,380 | 276 |
| OB/GYN | `mri_pelvis_review` | MRI Pelvis Review | 7,935 | 1,587 |
| OB/GYN | `fertility_panel_review` | Fertility Panel Review | 2,990 | 598 |
| OB/GYN | `fibroid_management_review` | Fibroid Management Review | 3,680 | 736 |
| OB/GYN | `prenatal_labs_review` | Prenatal Labs Review | 1,725 | 345 |
| OB/GYN | `hsg_report_review` | HSG Report Review | 2,990 | 598 |

### §3b — New panel SKUs (5)

These replace 38 individual lab tests bundled in the Excluded tab (see §4).

| Sheet `Service ID` | Specialty | Name | Price | Components |
|---|---|---|---:|---|
| `lab_panel_routine_bloods` | Lab & Pathology | Routine Bloods Panel Review | 1,500 | CBC, Urea, Creatinine, Uric Acid, AST, ALT, ALP, GGT, Albumin, Lipid Prof… |
| `lab_panel_tumor_markers` | Lab & Pathology | Tumor Markers Panel Review | 1,750 | CEA, CA 15-3, CA 19-9, CA 125, PSA, AFP |
| `lab_panel_urine_stool` | Lab & Pathology | Urine & Stool Workup Review | 1,250 | Urinalysis, Urine Culture, Stool Analysis, Stool Culture, Microbiology Ur… |
| `lab_panel_coag_electrolytes` | Lab & Pathology | Coagulation & Electrolytes Review | 1,250 | PT/INR, PTT, Sodium, Potassium |
| `lab_panel_microbiology` | Lab & Pathology | Microbiology Cultures Review | 1,500 | Blood C&S, Sputum C&S, Sensitivity Testing |

### §3c — Rename/restructure candidates (50)

⚠ **Red flag — manual review required.** These rows are in specialties that exist in the DB, but their names don't match any DB row. Two interpretations:

1. **Genuine net-new services** (sheet adds SKUs the DB never had).
2. **Renames or disaggregations** of existing DB rows (e.g. sheet splits 'Joint MRI Review' into Knee/Hip/Shoulder/Orthopedic).

Each needs an explicit policy decision before migration. Token-overlap candidates (in same specialty, ≥2 shared tokens) are shown — pick the matching DB row, or accept the row as net-new.

| Sheet specialty | Sheet name | Price | Closest DB candidate in same specialty | Decision |
|---|---|---:|---|---|
| Orthopedics | Orthopedic MRI Review | 5,175 | `014ad203-f858-404d-af30-8168a4779522` — Joint MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Orthopedics | CT Scan Review | 4,140 | `003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057` — DEXA Scan Review (2 shared tokens, current 1,250) | _\<TBD>_ |
| Orthopedics | Spine Imaging Review | 5,175 | `00a4fdbc-8bc7-42b2-a35d-af5823b477de` — Spine MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Orthopedics | Knee MRI Review | 4,715 | `014ad203-f858-404d-af30-8168a4779522` — Joint MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Orthopedics | Shoulder MRI Review | 4,715 | `014ad203-f858-404d-af30-8168a4779522` — Joint MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Orthopedics | Hip MRI Review | 4,715 | `014ad203-f858-404d-af30-8168a4779522` — Joint MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Orthopedics | Pre-Operative Opinion | 6,555 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Orthopedics | Post-Operative Review | 4,485 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Gastroenterology | Liver Ultrasound Review | 2,185 | `0052a110-1ddc-4639-9e50-d88a5ab99f22` — Abdominal Ultrasound Review (2 shared tokens, current 500) | _\<TBD>_ |
| Gastroenterology | Liver MRI Review | 8,970 | `svc-gastroenterology-liver-biopsy-review` — Liver Biopsy Review (2 shared tokens, current 1,150) | _\<TBD>_ |
| Gastroenterology | Liver Biopsy Report Review | 10,465 | `svc-gastroenterology-liver-biopsy-review` — Liver Biopsy Review (3 shared tokens, current 1,150) | _\<TBD>_ |
| Gastroenterology | FibroScan/Elastography Review | 3,680 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Gastroenterology | Hepatitis B/C Panel Review | 3,105 | `svc-gastroenterology-celiac-disease-panel-review` — Celiac Disease Panel Review (2 shared tokens, current 460) | _\<TBD>_ |
| Gastroenterology | IBD Investigation Review | 5,980 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Endocrinology | Full Thyroid Panel Review | 1,725 | `00a5d1c9-6616-4595-b9f1-cf5730a97520` — Thyroid Panel Review (3 shared tokens, current 1,250) | _\<TBD>_ |
| Endocrinology | Adrenal Workup Review | 5,175 | `svc-endocrinology-adrenal-gland-mri-review` — Adrenal Gland MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Endocrinology | PCOS Panel Review | 2,990 | `svc-endocrinology-hormone-panel-review` — Hormone Panel Review (2 shared tokens, current 1,250) | _\<TBD>_ |
| Endocrinology | Osteoporosis Workup Review | 2,645 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Endocrinology | Lipid Disorder Management | 1,725 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Endocrinology | Obesity/Metabolic Review | 2,990 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Endocrinology | Growth Hormone Panel Review | 5,175 | `svc-endocrinology-hormone-panel-review` — Hormone Panel Review (3 shared tokens, current 1,250) | _\<TBD>_ |
| Pulmonology | CT Chest Review | 5,175 | `013748a2-439f-4a12-b283-a6da145ee5d4` — Chest CT Review (3 shared tokens, current 800) | _\<TBD>_ |
| Pulmonology | HRCT Chest Review | 7,475 | `013748a2-439f-4a12-b283-a6da145ee5d4` — Chest CT Review (2 shared tokens, current 800) | _\<TBD>_ |
| Pulmonology | Sleep Study (PSG) Review | 7,475 | `svc-pulmonology-sleep-study-review` — Sleep Study Review (3 shared tokens, current 1,500) | _\<TBD>_ |
| Pulmonology | Post-COVID Lung Review | 3,680 | `svc-pulmonology-lung-biopsy-review` — Lung Biopsy Review (2 shared tokens, current 1,150) | _\<TBD>_ |
| Pulmonology | TB Workup Review | 3,680 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Pulmonology | V/Q Scan Review | 6,555 | `svc-pulmonology-chest-ct-scan-review` — Chest CT Scan Review (2 shared tokens, current 805) | _\<TBD>_ |
| Dermatology | Clinical Photo Review | 2,645 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Dermatology | Dermoscopy Review | 3,680 | `023495cb-67d6-43b8-9f3a-f6accdaf3f39` — Dermoscopy Image Review (2 shared tokens, current 460) | _\<TBD>_ |
| Dermatology | Skin Biopsy Report Review | 5,980 | `002f73f4-39c5-4e10-8027-a572f02cc18d` — Skin Biopsy Review (3 shared tokens, current 575) | _\<TBD>_ |
| Dermatology | Autoimmune Skin Panel Review | 5,980 | `svc-dermatology-skin-allergy-panel-review` — Skin Allergy Panel Review (3 shared tokens, current 460) | _\<TBD>_ |
| Dermatology | Hair Loss Workup Review | 2,990 | `svc-dermatology-hair-loss-investigation-review` — Hair Loss Investigation Review (3 shared tokens, current 518) | _\<TBD>_ |
| Dermatology | Psoriasis Management Review | 2,990 | `svc-dermatology-psoriasis-case-review` — Psoriasis Case Review (2 shared tokens, current 575) | _\<TBD>_ |
| Dermatology | Chronic Wound Review | 2,990 | `svc-dermatology-wound-assessment-review` — Wound Assessment Review (2 shared tokens, current 460) | _\<TBD>_ |
| Ophthalmology | Retinal Imaging Review | 5,175 | `svc-ophthalmology-retinal-oct-review` — Retinal OCT Review (2 shared tokens, current 805) | _\<TBD>_ |
| Ophthalmology | MRI Orbit Review | 7,475 | `svc-ophthalmology-orbital-mri-review` — Orbital MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Ophthalmology | Pre-Op Surgical Opinion | 5,980 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Urology | Prostate Workup Review | 3,680 | `svc-urology-prostate-mri-review` — Prostate MRI Review (2 shared tokens, current 1,035) | _\<TBD>_ |
| Urology | PSA & Prostate Panel Review | 2,185 | `0566e90d-bf71-46fb-bbab-7480c2e7552f` — PSA / Prostate Review (3 shared tokens, current 500) | _\<TBD>_ |
| Urology | MRI Prostate Review | 7,475 | `svc-urology-prostate-mri-review` — Prostate MRI Review (3 shared tokens, current 1,035) | _\<TBD>_ |
| Urology | Kidney/Ureter CT Review | 4,140 | `svc-urology-bladder-ct-review` — Bladder CT Review (2 shared tokens, current 805) | _\<TBD>_ |
| Urology | Bladder Ultrasound Review | 2,185 | `svc-urology-bladder-ct-review` — Bladder CT Review (2 shared tokens, current 805) | _\<TBD>_ |
| Urology | Urodynamics Study Review | 6,555 | `svc-urology-urodynamics-review` — Urodynamics Review (2 shared tokens, current 805) | _\<TBD>_ |
| Urology | Renal Stone Management Review | 3,680 | `svc-urology-renal-ct-scan-review` — Renal CT Scan Review (2 shared tokens, current 805) | _\<TBD>_ |
| Urology | Scrotal Ultrasound Review | 2,645 | `svc-urology-testicular-ultrasound-review` — Testicular Ultrasound Review (2 shared tokens, current 575) | _\<TBD>_ |
| Hematology | Full CBC with Differential Review | 1,725 | `svc-hematology-cbc-differential-review` — CBC & Differential Review (3 shared tokens, current 1,250) | _\<TBD>_ |
| Hematology | Anemia Workup Review | 3,680 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Hematology | Thrombophilia Panel Review | 7,475 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Hematology | Sickle Cell/Thalassemia Review | 3,680 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |
| Hematology | Immunoglobulins/SPEP Review | 7,475 | _(no token-overlap candidate — likely net-new)_ | _\<TBD>_ |

---

## §4 — DB-only rows (144) — services in DB, not on sheet

These DB rows are not referenced by either the Launch Catalog OR the Excluded tab. They are the migration's biggest blind spot.

**Visibility:** 110 visible, 34 hidden  
**Legacy UUID ids:** 35 (likely from earliest seed data — pre-migration-011 conventions)  
**Add-ons** (`specialty_id='addon'`): 2  

### By specialty

| `specialty_id` | Total | Visible | Hidden | Recommendation |
|---|---:|---:|---:|---|
| `addon` | 2 | 0 | 2 | Leave — add-ons are out of scope for v4 pricing reset |
| `lab_pathology` | 24 | 8 | 16 | **REVIEW:** likely seed-leftover lab tests not on excluded list either |
| `spec-cardiology` | 8 | 8 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-dermatology` | 7 | 7 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-endocrinology` | 6 | 5 | 1 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-ent` | 10 | 8 | 2 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-gastroenterology` | 7 | 5 | 2 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-general-surgery` | 10 | 8 | 2 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-hematology` | 7 | 7 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-internal-medicine` | 3 | 0 | 3 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-neurology` | 8 | 8 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-oncology` | 9 | 7 | 2 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-ophthalmology` | 4 | 3 | 1 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-orthopedics` | 8 | 8 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-pediatrics` | 9 | 9 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-pulmonology` | 7 | 6 | 1 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-radiology` | 6 | 6 | 0 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |
| `spec-urology` | 9 | 7 | 2 | Review — likely duplicates of v4 SKUs under variant names; hide non-canonical copies |

### Full list (visible only — hidden rows are already safe)

Only visible DB-only rows shown here; hidden ones already excluded from launch.

| `id` | `specialty_id` | Name | `base_price` | Recommendation |
|---|---|---|---:|---|
| `02e935a9-fb3b-46e2-831b-b1e31a9494f9` | `lab_pathology` | Blood Work Review | 1,250 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-lab-pathology-cbc-analysis-review` | `lab_pathology` | CBC Analysis Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-infectious-disease-panel-review` | `lab_pathology` | Infectious Disease Panel Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-kidney-function-test-review` | `lab_pathology` | Kidney Function Test Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-lipid-panel-review` | `lab_pathology` | Lipid Panel Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-liver-function-test-review` | `lab_pathology` | Liver Function Test Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-metabolic-panel-review` | `lab_pathology` | Metabolic Panel Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-lab-pathology-thyroid-panel-review` | `lab_pathology` | Thyroid Panel Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-cardiology-cardiac-ct-angiography-review` | `spec-cardiology` | Cardiac CT Angiography Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `0096b0ce-98dc-4211-a45d-b36dbd4eb867` | `spec-cardiology` | Cardiac Catheterization Review | 1,380 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-cardiology-cardiac-mri-review` | `spec-cardiology` | Cardiac MRI Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-cardiology-coronary-angiogram-review` | `spec-cardiology` | Coronary Angiogram Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `0178b4b3-998c-4f22-b8ad-244e527cf32c` | `spec-cardiology` | ECG Review | 1,250 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-cardiology-electrophysiology-study-review` | `spec-cardiology` | Electrophysiology Study Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `01734b45-bf72-43d3-8ed8-0840ae256ae3` | `spec-cardiology` | Holter Monitor Review | 1,500 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-cardiology-stress-test-review` | `spec-cardiology` | Stress Test Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `023495cb-67d6-43b8-9f3a-f6accdaf3f39` | `spec-dermatology` | Dermoscopy Image Review | 460 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-dermatology-hair-loss-investigation-review` | `spec-dermatology` | Hair Loss Investigation Review | 518 | **hide** — confirm orphaned, no FK refs |
| `svc-dermatology-melanoma-staging-review` | `spec-dermatology` | Melanoma Staging Review | 920 | **hide** — confirm orphaned, no FK refs |
| `svc-dermatology-psoriasis-case-review` | `spec-dermatology` | Psoriasis Case Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-dermatology-skin-allergy-panel-review` | `spec-dermatology` | Skin Allergy Panel Review | 460 | **hide** — confirm orphaned, no FK refs |
| `002f73f4-39c5-4e10-8027-a572f02cc18d` | `spec-dermatology` | Skin Biopsy Review | 575 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-dermatology-wound-assessment-review` | `spec-dermatology` | Wound Assessment Review | 460 | **hide** — confirm orphaned, no FK refs |
| `svc-endocrinology-adrenal-gland-mri-review` | `spec-endocrinology` | Adrenal Gland MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-endocrinology-hormone-panel-review` | `spec-endocrinology` | Hormone Panel Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-endocrinology-parathyroid-scan-review` | `spec-endocrinology` | Parathyroid Scan Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-endocrinology-thyroid-biopsy-fna-review` | `spec-endocrinology` | Thyroid Biopsy (FNA) Review | 805 | **hide** — confirm orphaned, no FK refs |
| `00a5d1c9-6616-4595-b9f1-cf5730a97520` | `spec-endocrinology` | Thyroid Panel Review | 1,250 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-ent-ct-sinuses-review` | `spec-ent` | CT Sinuses Review | 690 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-hearing-test-audiogram-review` | `spec-ent` | Hearing Test (Audiogram) Review | 460 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-laryngoscopy-report-review` | `spec-ent` | Laryngoscopy Report Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-neck-mri-review` | `spec-ent` | Neck MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-salivary-gland-ultrasound-review` | `spec-ent` | Salivary Gland Ultrasound Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-temporal-bone-ct-review` | `spec-ent` | Temporal Bone CT Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-thyroid-ultrasound-review` | `spec-ent` | Thyroid Ultrasound Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-ent-tympanometry-review` | `spec-ent` | Tympanometry Review | 402 | **hide** — confirm orphaned, no FK refs |
| `svc-gastroenterology-abdominal-ct-scan-review` | `spec-gastroenterology` | Abdominal CT Scan Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-gastroenterology-celiac-disease-panel-review` | `spec-gastroenterology` | Celiac Disease Panel Review | 460 | **hide** — confirm orphaned, no FK refs |
| `svc-gastroenterology-h-pylori-test-review` | `spec-gastroenterology` | H. pylori Test Review | 345 | **hide** — confirm orphaned, no FK refs |
| `svc-gastroenterology-inflammatory-bowel-disease-review` | `spec-gastroenterology` | Inflammatory Bowel Disease Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-gastroenterology-liver-biopsy-review` | `spec-gastroenterology` | Liver Biopsy Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-abdominal-ct-review` | `spec-general-surgery` | Abdominal CT Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-appendix-ct-review` | `spec-general-surgery` | Appendix CT Review | 690 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-gallbladder-ultrasound-review` | `spec-general-surgery` | Gallbladder Ultrasound Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-hernia-assessment-review` | `spec-general-surgery` | Hernia Assessment Review | 690 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-post-op-complication-review` | `spec-general-surgery` | Post-Op Complication Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-pre-op-surgical-report-review` | `spec-general-surgery` | Pre-Op Surgical Report Review | 920 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-surgical-biopsy-review` | `spec-general-surgery` | Surgical Biopsy Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-general-surgery-wound-care-assessment-review` | `spec-general-surgery` | Wound Care Assessment Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-blood-film-review` | `spec-hematology` | Blood Film Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-cbc-differential-review` | `spec-hematology` | CBC & Differential Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-coagulation-disorder-review` | `spec-hematology` | Coagulation Disorder Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-hemoglobin-electrophoresis-review` | `spec-hematology` | Hemoglobin Electrophoresis Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-iron-studies-review` | `spec-hematology` | Iron Studies Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-leukemia-case-review` | `spec-hematology` | Leukemia Case Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `svc-hematology-platelet-disorder-review` | `spec-hematology` | Platelet Disorder Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-neurology-brain-ct-scan-review` | `spec-neurology` | Brain CT Scan Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-neurology-cerebral-angiography-review` | `spec-neurology` | Cerebral Angiography Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `017c2399-6059-4696-96d2-dc478906a097` | `spec-neurology` | EEG Review | 1,500 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-neurology-emg-review` | `spec-neurology` | EMG Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `0273d7cd-d88d-4978-9d94-cc8a9da18e9b` | `spec-neurology` | Nerve Conduction Study Review | 1,500 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-neurology-neuropsychological-test-review` | `spec-neurology` | Neuropsychological Test Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-neurology-sleep-study-review` | `spec-neurology` | Sleep Study Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-neurology-spine-mri-review` | `spec-neurology` | Spine MRI Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-chemotherapy-plan-review` | `spec-oncology` | Chemotherapy Plan Review | 1,725 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-immunotherapy-response-review` | `spec-oncology` | Immunotherapy Response Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-post-treatment-mri-review` | `spec-oncology` | Post-Treatment MRI Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-radiation-therapy-plan-review` | `spec-oncology` | Radiation Therapy Plan Review | 1,725 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-staging-ct-scan-review` | `spec-oncology` | Staging CT Scan Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-tumor-biopsy-review` | `spec-oncology` | Tumor Biopsy Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `svc-oncology-tumor-board-case-review` | `spec-oncology` | Tumor Board Case Review | 2,070 | **hide** — confirm orphaned, no FK refs |
| `svc-ophthalmology-corneal-topography-review` | `spec-ophthalmology` | Corneal Topography Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-ophthalmology-orbital-mri-review` | `spec-ophthalmology` | Orbital MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-ophthalmology-retinal-oct-review` | `spec-ophthalmology` | Retinal OCT Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-orthopedics-arthroscopy-report-review` | `spec-orthopedics` | Arthroscopy Report Review | 920 | **hide** — confirm orphaned, no FK refs |
| `025cbbde-ebb1-47f5-9c6d-b812c9bff781` | `spec-orthopedics` | Bone X-Ray Review | 402 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `003fb3d9-ce6d-4dcd-9bff-5b2fd43bd057` | `spec-orthopedics` | DEXA Scan Review | 1,250 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `014ad203-f858-404d-af30-8168a4779522` | `spec-orthopedics` | Joint MRI Review | 1,035 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-orthopedics-joint-replacement-pre-op-review` | `spec-orthopedics` | Joint Replacement Pre-Op Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-orthopedics-scoliosis-x-ray-review` | `spec-orthopedics` | Scoliosis X-Ray Review | 575 | **hide** — confirm orphaned, no FK refs |
| `00a4fdbc-8bc7-42b2-a35d-af5823b477de` | `spec-orthopedics` | Spine MRI Review | 1,035 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-orthopedics-sports-injury-mri-review` | `spec-orthopedics` | Sports Injury MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-pediatrics-adhd-neuro-assessment-review` | `spec-pediatrics` | ADHD/Neuro Assessment Review | 805 | **hide** — confirm orphaned, no FK refs |
| `02a67b4e-c42d-49b7-a2fc-518b3aac938f` | `spec-pediatrics` | Growth & Development Review | 690 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-pediatrics-neonatal-screening-review` | `spec-pediatrics` | Neonatal Screening Review | 690 | **hide** — confirm orphaned, no FK refs |
| `svc-pediatrics-pediatric-abdominal-ultrasound-review` | `spec-pediatrics` | Pediatric Abdominal Ultrasound Review | 575 | **hide** — confirm orphaned, no FK refs |
| `01e95f20-aabc-4fcb-9583-c1a0ffba5a8d` | `spec-pediatrics` | Pediatric Blood Work Review | 402 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-pediatrics-pediatric-brain-mri-review` | `spec-pediatrics` | Pediatric Brain MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-pediatrics-pediatric-echo-review` | `spec-pediatrics` | Pediatric Echo Review | 805 | **hide** — confirm orphaned, no FK refs |
| `0260e565-52c4-4256-a93f-ab6c46d9bc14` | `spec-pediatrics` | Pediatric X-Ray Review | 402 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-pediatrics-vaccination-immunology-review` | `spec-pediatrics` | Vaccination & Immunology Review | 460 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-ctpa-pe-protocol-review` | `spec-pulmonology` | CTPA (PE Protocol) Review | 920 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-chest-ct-scan-review` | `spec-pulmonology` | Chest CT Scan Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-high-resolution-ct-hrct-review` | `spec-pulmonology` | High-Resolution CT (HRCT) Review | 920 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-lung-biopsy-review` | `spec-pulmonology` | Lung Biopsy Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-pleural-fluid-analysis-review` | `spec-pulmonology` | Pleural Fluid Analysis Review | 690 | **hide** — confirm orphaned, no FK refs |
| `svc-pulmonology-sleep-study-review` | `spec-pulmonology` | Sleep Study Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-radiology-dexa-scan-review` | `spec-radiology` | DEXA Scan Review | 1,250 | **hide** — confirm orphaned, no FK refs |
| `svc-radiology-fluoroscopy-review` | `spec-radiology` | Fluoroscopy Review | 1,500 | **hide** — confirm orphaned, no FK refs |
| `svc-radiology-interventional-radiology-case-review` | `spec-radiology` | Interventional Radiology Case Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `011cacad-5ec7-4c6b-ab01-3919081796e2` | `spec-radiology` | Mammogram Review | 1,500 | **hide** (legacy UUID seed) — confirm no `orders.service_id` refs |
| `svc-radiology-nuclear-medicine-scan-review` | `spec-radiology` | Nuclear Medicine Scan Review | 920 | **hide** — confirm orphaned, no FK refs |
| `svc-radiology-pet-ct-scan-review` | `spec-radiology` | PET-CT Scan Review | 1,380 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-bladder-ct-review` | `spec-urology` | Bladder CT Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-kidney-biopsy-review` | `spec-urology` | Kidney Biopsy Review | 1,150 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-psa-test-review` | `spec-urology` | PSA Test Review | 288 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-prostate-mri-review` | `spec-urology` | Prostate MRI Review | 1,035 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-renal-ct-scan-review` | `spec-urology` | Renal CT Scan Review | 805 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-testicular-ultrasound-review` | `spec-urology` | Testicular Ultrasound Review | 575 | **hide** — confirm orphaned, no FK refs |
| `svc-urology-urodynamics-review` | `spec-urology` | Urodynamics Review | 805 | **hide** — confirm orphaned, no FK refs |

**Action item for Stage 2 (migration design):** before any hide/delete, run `SELECT COUNT(*) FROM orders WHERE service_id IN (…)` for each candidate. Soft-hide (`is_visible=false`) is always safer than delete; keep delete only for the 38 'Bundled into Panel' lab rows where the sheet explicitly says hard-delete.

---

### §4.1 — Excluded sheet → DB matches (57 sheet rows → 59 DB rows)

Sheet's 'Excluded' tab cross-references these DB rows. Group by sheet `Status`:

#### `🚫 Not at Shifa` — 6 DB rows

| Sheet name | Sheet specialty | DB `id` | DB name | Action |
|---|---|---|---|---|
| Oncology PET-CT Staging | Radiology | `rad_onc_petct_staging` | Oncology PET-CT Staging | **hide** (`is_visible=false`) |
| Event Monitor Review | Cardiology | `card_event_monitor` | Event Monitor Review | **hide** (`is_visible=false`) |
| Pre-Op Cardiac Clearance | Cardiology | `card_preop_clearance` | Pre-Op Cardiac Clearance | **hide** (`is_visible=false`) |
| PET-CT Imaging Review | Oncology | `onc_petct_imaging` | PET-CT Imaging Review | **hide** (`is_visible=false`) |
| RECIST Response Assessment | Oncology | `onc_recist_response` | RECIST Response Assessment | **hide** (`is_visible=false`) |
| RT Planning Scan Review | Oncology | `onc_rt_planning_scan` | RT Planning Scan Review | **hide** (`is_visible=false`) |

#### `🔗 External/Outsourced` — 4 DB rows

| Sheet name | Sheet specialty | DB `id` | DB name | Action |
|---|---|---|---|---|
| Histopathology Report Review | Oncology | `onc_histo_reports` | Histopathology Report Review | **hide** (`is_visible=false`) |
| Cytology Report Review | Oncology | `onc_cytology_reports` | Cytology Report Review | **hide** (`is_visible=false`) |
| Hemato-Oncology Blood Review | Oncology | `onc_heme_onc_blood` | Hemato-Oncology Blood Review | **hide** (`is_visible=false`) |
| Tumor Markers Review | Oncology | `onc_tumor_markers` | Tumor Markers Review | **hide** (`is_visible=false`) |

#### `❓ Needs Clarification` — 9 DB rows

| Sheet name | Sheet specialty | DB `id` | DB name | Action |
|---|---|---|---|---|
| Neurovascular Review | Neurology | `neuro_neurovascular` | Neurovascular Review | **hide** (`is_visible=false`) |
| Perfusion Imaging Review | Neurology | `neuro_perfusion` | Perfusion Imaging Review | **hide** (`is_visible=false`) |
| Epilepsy Imaging Review | Neurology | `neuro_epilepsy_imaging` | Epilepsy Imaging Review | **hide** (`is_visible=false`) |
| Stroke Imaging Review | Neurology | `neuro_stroke_imaging` | Stroke Imaging Review | **hide** (`is_visible=false`) |
| Pap Smear | Lab & Pathology | `lab_pap_smear` | Pap Smear | **hide** (`is_visible=false`) |
| Body Fluids Analysis | Lab & Pathology | `lab_body_fluids` | Body Fluids Analysis | **hide** (`is_visible=false`) |
| Fine Needle Aspiration (FNA) | Lab & Pathology | `lab_fna` | Fine Needle Aspiration (FNA) | **hide** (`is_visible=false`) |
| Sensitivity Testing | Lab & Pathology | `lab_sensitivity` | Sensitivity Testing | **hide** (`is_visible=false`) |
| Genetic/Molecular Testing | Lab & Pathology | `lab_genetic_molecular` | Genetic/Molecular Testing | **hide** (`is_visible=false`) |

#### `📦 Bundled into Panel` — 40 DB rows

| Sheet name | Sheet specialty | DB `id` | DB name | Action |
|---|---|---|---|---|
| Complete Blood Count (CBC) | Lab & Pathology | `lab_cbc` | Complete Blood Count (CBC) | **HARD DELETE** (after FK check) |
| Kidney Function - Urea | Lab & Pathology | `lab_kidney_urea` | Kidney Function - Urea | **HARD DELETE** (after FK check) |
| Kidney Function - Creatinine | Lab & Pathology | `lab_kidney_creat` | Kidney Function - Creatinine | **HARD DELETE** (after FK check) |
| Kidney Function - Uric Acid | Lab & Pathology | `lab_kidney_uric_acid` | Kidney Function - Uric Acid | **HARD DELETE** (after FK check) |
| Liver Function - AST | Lab & Pathology | `lab_liver_ast` | Liver Function - AST | **HARD DELETE** (after FK check) |
| Liver Function - ALT | Lab & Pathology | `lab_liver_alt` | Liver Function - ALT | **HARD DELETE** (after FK check) |
| Liver Function - GGT | Lab & Pathology | `lab_liver_ggt` | Liver Function - GGT | **HARD DELETE** (after FK check) |
| Liver Function - ALP | Lab & Pathology | `lab_liver_alp` | Liver Function - ALP | **HARD DELETE** (after FK check) |
| Liver Function - Albumin | Lab & Pathology | `lab_liver_albumin` | Liver Function - Albumin | **HARD DELETE** (after FK check) |
| Electrolytes - Sodium | Lab & Pathology | `lab_electrolytes_na` | Electrolytes - Sodium | **HARD DELETE** (after FK check) |
| Electrolytes - Potassium | Lab & Pathology | `lab_electrolytes_k` | Electrolytes - Potassium | **HARD DELETE** (after FK check) |
| Thyroid Panel | Lab & Pathology | `lab_thyroid` | Thyroid panel | **HARD DELETE** (after FK check) |
| Thyroid Panel | Lab & Pathology | `lab_thyroid_panel` | Thyroid Panel | **HARD DELETE** (after FK check) |
| Lipid Profile | Lab & Pathology | `lab_lipids` | Lipid profile | **HARD DELETE** (after FK check) |
| Lipid Profile | Lab & Pathology | `lab_lipid_profile` | Lipid Profile | **HARD DELETE** (after FK check) |
| Diabetes Panel (HbA1c/FBS) | Lab & Pathology | `lab_diabetes` | Diabetes Panel (HbA1c/FBS) | **HARD DELETE** (after FK check) |
| Autoimmune - ANA | Lab & Pathology | `lab_autoimmune_ana` | Autoimmune - ANA | **HARD DELETE** (after FK check) |
| Autoimmune - Complement C3 | Lab & Pathology | `lab_autoimmune_c3` | Autoimmune - Complement C3 | **HARD DELETE** (after FK check) |
| Autoimmune - Complement C4 | Lab & Pathology | `lab_autoimmune_c4` | Autoimmune - Complement C4 | **HARD DELETE** (after FK check) |
| Coagulation - PT/INR | Lab & Pathology | `lab_coag_pt` | Coagulation - PT/INR | **HARD DELETE** (after FK check) |
| Coagulation - PTT | Lab & Pathology | `lab_coag_ptt` | Coagulation - PTT | **HARD DELETE** (after FK check) |
| Tumor Marker - CEA | Lab & Pathology | `lab_tumor_cea` | Tumor Marker - CEA | **HARD DELETE** (after FK check) |
| Tumor Marker - CA 15-3 | Lab & Pathology | `lab_tumor_ca153` | Tumor Marker - CA 15-3 | **HARD DELETE** (after FK check) |
| Tumor Marker - CA 19-9 | Lab & Pathology | `lab_tumor_ca199` | Tumor Marker - CA 19-9 | **HARD DELETE** (after FK check) |
| Tumor Marker - CA 125 | Lab & Pathology | `lab_tumor_ca125` | Tumor Marker - CA 125 | **HARD DELETE** (after FK check) |
| Tumor Marker - PSA | Lab & Pathology | `lab_tumor_psa` | Tumor Marker - PSA | **HARD DELETE** (after FK check) |
| Tumor Marker - AFP | Lab & Pathology | `lab_tumor_afp` | Tumor Marker - AFP | **HARD DELETE** (after FK check) |
| Hormone - DHEA-S | Lab & Pathology | `lab_hormone_dhea` | Hormone - DHEA-S | **HARD DELETE** (after FK check) |
| Hormone - Estradiol (E2) | Lab & Pathology | `lab_hormone_e2` | Hormone - Estradiol (E2) | **HARD DELETE** (after FK check) |
| Hormone - Testosterone | Lab & Pathology | `lab_hormone_testo` | Hormone - Testosterone | **HARD DELETE** (after FK check) |
| Hormone - LH | Lab & Pathology | `lab_hormone_lh` | Hormone - LH | **HARD DELETE** (after FK check) |
| Hormone - FSH | Lab & Pathology | `lab_hormone_fsh` | Hormone - FSH | **HARD DELETE** (after FK check) |
| Hormone - Prolactin | Lab & Pathology | `lab_hormone_prl` | Hormone - Prolactin | **HARD DELETE** (after FK check) |
| Urinalysis | Lab & Pathology | `lab_urinalysis` | Urinalysis | **HARD DELETE** (after FK check) |
| Urine Culture | Lab & Pathology | `lab_urine_culture` | Urine Culture | **HARD DELETE** (after FK check) |
| Stool Analysis | Lab & Pathology | `lab_stool_analysis` | Stool Analysis | **HARD DELETE** (after FK check) |
| Stool Culture | Lab & Pathology | `lab_stool_culture` | Stool Culture | **HARD DELETE** (after FK check) |
| Microbiology - Urine C&S | Lab & Pathology | `lab_micro_urine_cs` | Microbiology - Urine C&S | **HARD DELETE** (after FK check) |
| Microbiology - Stool C&S | Lab & Pathology | `lab_micro_stool_cs` | Microbiology - Stool C&S | **HARD DELETE** (after FK check) |
| Microbiology - Blood C&S | Lab & Pathology | `lab_micro_blood_cs` | Microbiology - Blood C&S | **HARD DELETE** (after FK check) |

### §4.2 — Excluded sheet rows with no DB match (10)

All 10 are Psychiatry — not currently in the DB. No action needed; documented for completeness.

| Sheet name | Status |
|---|---|
| Psychiatric Diagnosis Review | 🚫 Psychiatry — Not at Shifa |
| Medication Regimen Review | 🚫 Psychiatry — Not at Shifa |
| Psychological Assessment Review | 🚫 Psychiatry — Not at Shifa |
| ADHD Assessment Review | 🚫 Psychiatry — Not at Shifa |
| Anxiety Disorder Review | 🚫 Psychiatry — Not at Shifa |
| Depression Management Review | 🚫 Psychiatry — Not at Shifa |
| Bipolar Disorder Review | 🚫 Psychiatry — Not at Shifa |
| Autism Spectrum Review | 🚫 Psychiatry — Not at Shifa |
| Substance Use Disorder Review | 🚫 Psychiatry — Not at Shifa |
| Psychiatric Brain MRI Review | 🚫 Psychiatry — Not at Shifa |

---

## §5 — Price-mismatch summary

- Matched DB rows with priced sheet entry: **66**
- Price changes: **66** (out of 66)
  - Old `base_price` was NULL/0 → setting new price: **32**
  - Bump (old > 0, new > old): **33**
  - Drop (new < old): **1**
- Unchanged: **0**

**Aggregate price-per-SKU delta** (one unit of each service, no volume weighting):
- Old sum: **32,759 EGP**
- New sum: **364,527 EGP**
- Net delta: **+331,768 EGP** (+1013%)

⚠ **Caveat — this is NOT revenue impact.** It's the sum of one-unit-per-service price differences. True revenue impact depends on volume mix per SKU, which is not in this report's scope. The headline change is that 32 currently unpriced services are being priced for the first time (driving most of the +sum), and the remaining 34 priced services are uniformly being marked up to enforce the 250-EGP doctor-fee floor (Tashkheesa price ≥ 1,250 EGP for Simple services).

### §5a — Sheet-defined 'Bumps' (Category = 'Bumped (was below floor)') — should be 5

These are the 5 rows the sheet explicitly labels as floor-enforcement bumps:

| Sheet `Service ID` | Specialty | Name | DB match | Old price | New price |
|---|---|---|---|---:|---:|
| `rad_cxr_review` | Radiology | Chest X-Ray Review | `rad_cxr_review` | NULL | 1,250 |
| `card_ecg_12lead` | Cardiology | 12-Lead ECG Interpretation | `card_ecg_12lead` | NULL | 1,250 |
| `card_rhythm_strip` | Cardiology | Rhythm Strip Analysis | `card_rhythm_strip` | NULL | 1,250 |
| `pulm_cxr_review` | Pulmonology | Chest X-Ray Review | `0279d2b9-23bf-4f7a-bfa6-10243a39571d` | 402 | 1,250 |
| `lab_cytology` | Lab & Pathology | Cytology | `lab_cytology` | NULL | 1,250 |

---

## Stage 2 — Recommended migration design (preview, not committed)

Based on §1–§5, the migration (`050_pricing_v4_reset.sql` — not yet written per Stage-1 hard-constraint) should be staged as:

1. **Add specialties** — INSERT `spec-nephrology` + `spec-obgyn` into `specialties` (§3a).
2. **Update prices on 66 matched rows** by `(specialty_id, name)` — never by id (§1).
3. **INSERT 7 new lab panels** (§3b).
4. **Resolve §3c rename/restructure** — needs Ziad's policy decisions per row (~48 decisions).
5. **Hide §4.1 Excluded matches** with status ≠ 'Bundled into Panel' (≈17 rows: hide).
6. **HARD DELETE the 38 'Bundled into Panel' lab rows**, AFTER pre-flight FK check on `orders.service_id`.
7. **Hide §4 visible DB-only rows** (≈110 rows) — but ONLY after Ziad's manual triage of which are genuinely orphan vs. which are intentional non-launch SKUs.

All steps are idempotent and reversible (except step 6, which the canonical sheet explicitly authorises).

---

## Artifacts

- `/tmp/reconcile_final.json` — full structured match data (intermediate, not committed)
- `/tmp/services_live.tsv` — DB snapshot used for matching (intermediate, not committed)
- This report: `docs/pricing/PRICING_RECONCILIATION_v4.md`

