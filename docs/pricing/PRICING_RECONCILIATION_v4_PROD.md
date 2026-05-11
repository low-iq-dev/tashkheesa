# Pricing Reconciliation v4 — Production Supabase

**Generated:** 2026-05-11  
**Canonical sheet:** `Tashkheesa_Canonical_Pricing_v4.xlsx`  
**Live DB snapshot:** 187 rows in `services` table on production Supabase (`aws-1-us-east-1.pooler.supabase.com`)  
**Reference:** side issue #48

> **Supersedes** the deleted `PRICING_RECONCILIATION_v4.md` and `PRICING_TRIAGE_144_DB_ONLY.md`, which were built against a local-DB snapshot that did not reflect production state. Migration 050 (also retracted in `4f56ce9`) was generated from those wrong reports and is moot for prod.

---

## Executive Summary

| Bucket | Count | Action class |
|---|---:|---|
| **§1 — Exact matches** (sheet ↔ prod by id or specialty+name) | **130** | UPDATE price / un-hide on existing row |
| **§2 — Ambiguous matches** | **0** | None |
| **§3 — Sheet-only** (7 new lab panels) | **7** | INSERT |
| **§4 — DB-only** (prod rows not on sheet) | **0** | _(none — every prod service is referenced by the v4 sheet)_ |
| **§5 — Price-mismatch summary** | — | 38 unpriced + 5 sheet-defined bumps + small priced-deltas (see §5) |

**Total Launch Catalog rows on sheet:** 137 (125 Individual + 5 Bumped + 7 Panels)  
**Total Excluded rows on sheet:** 67 (38 Bundled-into-Panel + 9 Needs-Clarification + 6 Not-at-Shifa + 4 External + 10 Psychiatry-orphans-not-in-DB)

**Prod services baseline:** 187 rows | 92 visible | 95 unpriced (NULL or 0 `base_price`) | 17 historical orders touching 3 service rows (all matched-launch SKUs)

---

## ⚠ Critical findings (revised — most prior concerns dissolved)

The deleted local-DB report had 5 'critical findings' (A-E). Against **production**, four of them no longer apply:

| Old finding (local DB) | Reality in prod |
|---|---|
| A. Sheet's `Service ID` is a new canonical scheme, DB has chaotic mixed ids | Prod uses clean `svc-{specialty}-{slug}` for most rows; 4 sheet IDs (`rad_cxr_review`, `card_ecg_12lead`, `card_rhythm_strip`, `lab_cytology`) coincidentally match prod ids; **no UUID-only legacy ids exist in prod**; the (specialty_id, name) match key still works flawlessly (126/130 matches resolved this way, 0 ambiguous). |
| B. Nephrology & OB/GYN are not in DB (need INSERT specialties) | **Both already exist in prod** — `spec-nephrology` has 8 services, `spec-obgyn` has 9. No specialty INSERT needed. |
| C. ~48 sheet-only rows are renames/restructures in existing specialties | **0 renames in prod.** All 130 matched launch SKUs match by (specialty, name) cleanly. The 'sheet-only' bucket contains exactly the 7 new lab panels — no spurious entries. |
| D. 144 DB-only services need triage (largest blind spot) | **0 DB-only services in prod.** Every one of the 187 prod services is referenced by either the Launch Catalog or the Excluded tab. The 144-row triage was a phantom problem. |
| E. 95 unpriced (issue #48) vs 89 measured — 6-row drift | **95 confirmed in prod exactly.** Drift was a local-DB artifact. |

**The single critical finding that remains:**

**F. Visibility state in prod is already very close to v4-target.** All 57 Excluded-tab matches are already `is_visible=false`. Of the 130 matched launch SKUs, 92 are visible+priced (launch-ready) and 38 are hidden+unpriced (need both pricing AND un-hiding). This means migration 051 (hide the 19 non-Bundled Excluded rows) will be a **no-op** — all 19 are already hidden in prod. See §5 and Stage 2 for the full delta.

---

## §1 — Exact matches (130)

Match key precedence: (1) sheet `Service ID` == prod `id`; (2) same specialty + exact name; (3) exact name cross-specialty.

### §1a — Exact ID match (4)

These sheet ids coincidentally equal a prod id. All 4 currently `is_visible=false` with NULL `base_price` — they need both pricing AND un-hiding.

| Sheet `Service ID` / Prod `id` | Specialty | Name | Old price | Old fee | Old visible | New price |
|---|---|---|---:|---:|:-:|---:|
| `rad_cxr_review` | Radiology | Chest X-Ray Review | NULL | NULL | ✗ | 1,250 |
| `card_ecg_12lead` | Cardiology | 12-Lead ECG Interpretation | NULL | NULL | ✗ | 1,250 |
| `card_rhythm_strip` | Cardiology | Rhythm Strip Analysis | NULL | NULL | ✗ | 1,250 |
| `lab_cytology` | Lab & Pathology | Cytology | NULL | NULL | ✗ | 1,250 |

### §1b — Specialty + name match (126)

Prod `specialty_id` matches sheet specialty, and prod has exactly one row with the same name (normalized).

Grouped by `specialty_id`:

| `specialty_id` | Rows | Currently visible | Currently priced |
|---|---:|---:|---:|
| `lab_pathology` | 8 | 0 | 0 |
| `spec-cardiology` | 7 | 0 | 0 |
| `spec-dermatology` | 8 | 8 | 8 |
| `spec-endocrinology` | 10 | 10 | 10 |
| `spec-gastroenterology` | 10 | 10 | 10 |
| `spec-hematology` | 9 | 9 | 9 |
| `spec-nephrology` | 8 | 8 | 8 |
| `spec-neurology` | 7 | 0 | 0 |
| `spec-obgyn` | 9 | 9 | 9 |
| `spec-oncology` | 2 | 0 | 0 |
| `spec-ophthalmology` | 9 | 9 | 9 |
| `spec-orthopedics` | 11 | 11 | 11 |
| `spec-pulmonology` | 9 | 9 | 9 |
| `spec-radiology` | 10 | 0 | 0 |
| `spec-urology` | 9 | 9 | 9 |

Full row-by-row dump in [appendix below](#§1b-full-listing-126-rows).

### §1c — Cross-specialty single name match (0)

**None.** Prod has no name-collision drift across specialties.

---

## §2 — Ambiguous matches (0)

**None.** Every launch SKU resolved cleanly via the (specialty_id, name) key. Prod does not have the multi-specialty duplicate-name problem that the local DB had.

---

## §3 — Sheet-only rows (7) — INSERTs

These 7 rows have no name+specialty match in prod. **All 7 are the new Lab & Pathology panel SKUs** the v4 sheet introduces to replace 38 individual lab tests.

| Sheet `Service ID` | Name | Price (EGP) | Doctor fee | Panel components |
|---|---|---:|---:|---|
| `lab_panel_routine_bloods` | Routine Bloods Panel Review | 1,500 | 300 | BC, Urea, Creatinine, Uric Acid, AST, ALT, ALP, GGT, Albumin, Lipid Prof |
| `lab_panel_tumor_markers` | Tumor Markers Panel Review | 1,750 | 350 | EA, CA 15-3, CA 19-9, CA 125, PSA, AFP |
| `lab_panel_hormones` | Hormone Panel Review | 1,750 | 350 | HEA-S, Estradiol (E2), Testosterone, LH, FSH, Prolactin |
| `lab_panel_autoimmune` | Autoimmune Panel Review | 1,750 | 350 | NA, ANCA, Anti-DNA, ASMA, Complement C3, Complement C4 |
| `lab_panel_urine_stool` | Urine & Stool Workup Review | 1,250 | 250 | rinalysis, Urine Culture, Stool Analysis, Stool Culture, Microbiology Ur |
| `lab_panel_coag_electrolytes` | Coagulation & Electrolytes Review | 1,250 | 250 | T/INR, PTT, Sodium, Potassium |
| `lab_panel_microbiology` | Microbiology Cultures Review | 1,500 | 300 | lood C&S, Sputum C&S, Sensitivity Testing |

Migration plan: `INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, is_visible, ...) VALUES ...` with `specialty_id = 'lab_pathology'` and `is_visible = true`.

---

## §4 — DB-only rows (0)

**None.** Every prod service is referenced by either the Launch Catalog or the Excluded tab of the v4 sheet. The local-DB report flagged 144 DB-only rows as 'the largest unbounded risk' — that was a phantom. Prod has zero seed-leftovers, zero unreferenced legacy duplicates, zero orphan services. The v4 sheet was clearly designed against this exact prod state.

### §4.1 — Excluded sheet → prod matches (57)

All 57 are **already `is_visible=false` in prod**. Status breakdown:

| Status | Rows | Currently visible? | Action |
|---|---:|---|---|
| `📦 Bundled into Panel` | 38 | 0 of 38 visible | **HARD DELETE** (planned migration 054 — 0 orders reference any of these 38 rows, verified) |
| `❓ Needs Clarification` | 9 | 0 of 9 visible | hide (planned 051 — already hidden, no-op) |
| `🚫 Not at Shifa` | 6 | 0 of 6 visible | hide (planned 051 — already hidden, no-op) |
| `🔗 External/Outsourced` | 4 | 0 of 4 visible | hide (planned 051 — already hidden, no-op) |

### §4.2 — Excluded rows with no prod match (10)

All 10 are Psychiatry specialty, not present in prod. No action needed (already absent).

---

## §5 — Price-mismatch summary

For the 130 matched launch SKUs:
- Currently visible + priced (launch-ready as-is): **92**
- Currently visible + unpriced: **0**
- Currently hidden + priced: **0**
- Currently hidden + unpriced (need price + un-hide): **38**

**Price-changes among rows that already have a price:** 1 change, 91 unchanged

### §5a — Sheet-defined 'Bumps' (5 rows, Category = 'Bumped (was below floor)')

| Sheet `Service ID` | Specialty | Name | Prod `id` | Prod current price | New price |
|---|---|---|---|---:|---:|
| `rad_cxr_review` | Radiology | Chest X-Ray Review | `rad_cxr_review` | NULL | 1,250 |
| `card_ecg_12lead` | Cardiology | 12-Lead ECG Interpretation | `card_ecg_12lead` | NULL | 1,250 |
| `card_rhythm_strip` | Cardiology | Rhythm Strip Analysis | `card_rhythm_strip` | NULL | 1,250 |
| `pulm_cxr_review` | Pulmonology | Chest X-Ray Review | `rad_cxr_review` | NULL | 1,250 |
| `lab_cytology` | Lab & Pathology | Cytology | `lab_cytology` | NULL | 1,250 |

### §5b — 38 currently-hidden+unpriced launch SKUs

These are matched launch SKUs that are currently `is_visible=false` AND `base_price IS NULL`. They need BOTH pricing applied AND un-hiding for launch:

| `specialty_id` | Count | New price range (EGP) |
|---|---:|---|
| `lab_pathology` | 9 | 1,250 – 11,500 |
| `spec-cardiology` | 9 | 1,250 – 8,395 |
| `spec-neurology` | 7 | 1,553 – 13,225 |
| `spec-oncology` | 2 | 11,500 – 17,480 |
| `spec-radiology` | 11 | 1,250 – 17,480 |

Together with the 57 still-hidden Excluded rows, that accounts for exactly **95 = 95** currently-unpriced prod services (matches issue #48).

---

## Stage 2 — Migration plan (051–055)

Each migration writes its filename into `schema_migrations` only on success (`src/db.js:40`); a DO-block post-condition guard inside each migration aborts the txn if the data doesn't end up where we expect. Idempotent throughout.

| # | Purpose | Rows touched in prod | No-op? | Risk |
|---|---|---|---|---|
| **051** | Hide the 19 non-Bundled Excluded rows (Needs Clarification + Not at Shifa + External) | 19 | **YES — all 19 already hidden in prod.** Migration is a safety/idempotency guarantee, not a state change. | None |
| **052** | Bump 5 stragglers to 1,250 EGP | 5 (4 currently NULL→1250, 1 currently 402→1250) | No | Low — only floor enforcement |
| **053** | INSERT 7 new lab panel SKUs | 7 inserts | No | Low — net-new ids, no conflicts |
| **054** | HARD DELETE 38 Bundled-into-Panel lab services | 38 deletes | No | **Verified safe**: 0 orders reference these 38 ids in prod |
| **055** | Apply prices for 95 currently-unpriced services + un-hide where appropriate | 95 priced + 38 un-hidden (the 57 Excluded stay hidden) | No | Medium — biggest single migration; should run last after 051–054 |

**Suggested merge order:** 051 → 052 → 053 → 054 → 055. Each migration is independent of the others (no data dependencies between them), so the order is just for review ergonomics.

**On migration 051 being a no-op:** worth keeping anyway as a hard safety guarantee — if any of the 19 rows are ever manually re-shown (e.g. via admin UI), the next deploy of 051 silently hides them again. Idempotent. Alternative: skip 051 and let the existing prod state speak for itself.

---

## Appendix — §1b full listing (126 rows)

| Specialty | Prod `id` | Name | Sheet new price | Prod current price | Currently visible | Δ price |
|---|---|---|---:|---:|:-:|---:|
| Lab & Pathology | `lab_autoimmune_anca` | Autoimmune - ANCA | 2,530 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_autoimmune_anti_dna` | Autoimmune - Anti-DNA | 1,495 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_autoimmune_asma` | Autoimmune - ASMA | 1,495 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_bone_marrow` | Bone Marrow Aspirate Review | 11,500 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_histo_large` | Histopathology - Large Biopsy | 2,990 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_histo_organ` | Histopathology - Organ/Resection | 4,255 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_histo_small` | Histopathology - Small Biopsy | 1,668 | NULL | ✗ | NEW PRICE |
| Lab & Pathology | `lab_micro_sputum_cs` | Microbiology - Sputum C&S | 6,900 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_calcium_score` | Calcium Score Review | 3,680 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_cmr` | Cardiac MR Review | 8,395 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_ctca` | CT Coronary Angiography Review | 7,935 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_echo` | Echocardiogram Review | 1,380 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_holter_24_72` | Holter Monitor (24-72h) Review | 3,450 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_stress_echo` | Stress Echo Review | 2,070 | NULL | ✗ | NEW PRICE |
| Cardiology | `card_stress_treadmill` | Stress Treadmill Test Review | 1,553 | NULL | ✗ | NEW PRICE |
| Dermatology | `f2c6ad36-af16-417d-8b17-f66afbd7f750` | Autoimmune Skin Panel Review | 5,980 | 5,980 | ✓ | — |
| Dermatology | `0ad67dc7-55f4-405a-938b-433e283b82ee` | Chronic Wound Review | 2,990 | 2,990 | ✓ | — |
| Dermatology | `30641b01-db6b-46bc-bee0-d3037873c2be` | Clinical Photo Review | 2,645 | 2,645 | ✓ | — |
| Dermatology | `783ad9ec-a01c-4c12-8cad-b466a838390a` | Dermoscopy Review | 3,680 | 3,680 | ✓ | — |
| Dermatology | `911127b5-34e2-47b5-853a-6975f4a54b0f` | Hair Loss Workup Review | 2,990 | 2,990 | ✓ | — |
| Dermatology | `ac1f3447-9cb2-4c2a-ba8f-b5d2560f9d69` | Patch Test Review | 2,990 | 2,990 | ✓ | — |
| Dermatology | `2da99181-dfc6-4e55-be0b-fb9ea28b09c4` | Psoriasis Management Review | 2,990 | 2,990 | ✓ | — |
| Dermatology | `f3d1a7f1-a6cc-4a0d-ab8f-678caa10474d` | Skin Biopsy Report Review | 5,980 | 5,980 | ✓ | — |
| Endocrinology | `014b800d-7431-4cf6-9e87-37599be29399` | Adrenal Workup Review | 5,175 | 5,175 | ✓ | — |
| Endocrinology | `f2333602-2a06-4a5c-898a-a403a2243008` | Diabetes Management Review | 2,990 | 2,990 | ✓ | — |
| Endocrinology | `08766418-29d9-4012-ac42-6a5fdb623bae` | Full Thyroid Panel Review | 1,725 | 1,725 | ✓ | — |
| Endocrinology | `1d115a28-abe4-4e0d-aa0b-3735338f1453` | Growth Hormone Panel Review | 5,175 | 5,175 | ✓ | — |
| Endocrinology | `bb1a3406-2007-44ac-a165-e10256cd2b76` | Lipid Disorder Management | 1,725 | 1,725 | ✓ | — |
| Endocrinology | `357a9ed9-0dc3-47b6-b53c-db05b50ab7e6` | Obesity/Metabolic Review | 2,990 | 2,990 | ✓ | — |
| Endocrinology | `2fca13ac-08b1-4118-83c6-2dca3d950563` | Osteoporosis Workup Review | 2,645 | 2,645 | ✓ | — |
| Endocrinology | `5ab109b3-4637-448c-8e6d-1f3821a58e3a` | PCOS Panel Review | 2,990 | 2,990 | ✓ | — |
| Endocrinology | `89ff1ef4-c4fd-441f-9aa9-8e92aa846436` | Pituitary MRI Review | 5,175 | 5,175 | ✓ | — |
| Endocrinology | `a9ac1b8e-e8fc-43e4-8783-de53536f6cc7` | Thyroid Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| Gastroenterology | `ccc8556d-089a-4b61-b21c-7fc3bc9cda62` | Capsule Endoscopy Review | 10,465 | 10,465 | ✓ | — |
| Gastroenterology | `0e6c534d-dfab-4c2b-a950-0eda846a1cdb` | Colonoscopy Report Review | 4,485 | 4,485 | ✓ | — |
| Gastroenterology | `c1e9624a-78c2-4c8c-b6ca-7b3694719eb8` | Endoscopy Report Review | 4,485 | 4,485 | ✓ | — |
| Gastroenterology | `9ffc180c-bed2-4305-b71c-2303c12f30b6` | FibroScan/Elastography Review | 3,680 | 3,680 | ✓ | — |
| Gastroenterology | `4f3ff7a9-bbf4-41ac-bbf9-e731f62bbad7` | Hepatitis B/C Panel Review | 3,105 | 3,105 | ✓ | — |
| Gastroenterology | `6193b569-cfe7-40d9-a2a7-ce7b02189395` | IBD Investigation Review | 5,980 | 5,980 | ✓ | — |
| Gastroenterology | `d8e374d9-0ae0-4c1a-9299-a508752fdf7b` | Liver Biopsy Report Review | 10,465 | 10,465 | ✓ | — |
| Gastroenterology | `3576c5fe-59a7-4370-ad05-f34e40d8a1e8` | Liver MRI Review | 8,970 | 8,970 | ✓ | — |
| Gastroenterology | `891c261f-6c63-4341-8644-a75af15c7a59` | Liver Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| Gastroenterology | `7fa58485-fe05-49ef-85c7-607abc91c123` | MRCP Review | 9,545 | 9,545 | ✓ | — |
| Hematology | `08681b8c-8fe5-44d2-90b4-956974dbbc29` | Anemia Workup Review | 3,680 | 3,680 | ✓ | — |
| Hematology | `68d477c3-2414-4307-8bdb-ce732604338d` | Bone Marrow Biopsy Review | 14,950 | 14,950 | ✓ | — |
| Hematology | `b992e0c0-1f0c-4747-b122-d9c5bd2d04a1` | Coagulation Panel Review | 2,990 | 2,990 | ✓ | — |
| Hematology | `cc7f3467-17b2-4f75-96b7-ce56dd1cbc39` | Flow Cytometry Review | 13,455 | 13,455 | ✓ | — |
| Hematology | `77f4db68-466d-4874-ba04-88d3dccfad6b` | Full CBC with Differential Review | 1,725 | 1,725 | ✓ | — |
| Hematology | `fb41d6e4-1221-4b79-9b7d-b1dd512b93a3` | Immunoglobulins/SPEP Review | 7,475 | 7,475 | ✓ | — |
| Hematology | `aeea6eee-2a3a-4833-af8c-6ced381f76ea` | Lymphoma Staging Review | 13,455 | 13,455 | ✓ | — |
| Hematology | `d05d3fa7-81d5-4cbc-b5ec-cd96187f14c7` | Sickle Cell/Thalassemia Review | 3,680 | 3,680 | ✓ | — |
| Hematology | `75ae2cee-6b8a-4cea-8240-89a821a47938` | Thrombophilia Panel Review | 7,475 | 7,475 | ✓ | — |
| Nephrology | `bef26bde-7f2c-4ed9-ac08-6d4ef3075e03` | CKD Staging & Management Review | 3,680 | 3,680 | ✓ | — |
| Nephrology | `6d7409bb-18a2-4659-a119-e7102ea3c2b0` | Dialysis Adequacy Review | 5,980 | 5,980 | ✓ | — |
| Nephrology | `442081e7-0abb-490e-9df1-0ef7f0bd0397` | Hypertension Workup Review | 3,680 | 3,680 | ✓ | — |
| Nephrology | `5318c5cf-9097-47a9-b1a7-a40c1ba68406` | Kidney Biopsy Report Review | 10,465 | 10,465 | ✓ | — |
| Nephrology | `cd428c90-e144-48a6-ae2d-e7321c47eb62` | Kidney Function Panel Review | 1,725 | 1,725 | ✓ | — |
| Nephrology | `90445995-81a2-4dfa-9c33-5b39cb6779ad` | Kidney Stone CT Review | 4,140 | 4,140 | ✓ | — |
| Nephrology | `3896c375-5e86-4b83-b978-6dcd4257bd23` | Kidney Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| Nephrology | `22028c6f-2f3a-427f-bc37-e65e3e518836` | Proteinuria Workup Review | 3,680 | 3,680 | ✓ | — |
| Neurology | `neuro_brain_ct` | Brain CT Review | 1,553 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_brain_mri` | Brain MRI Review | 3,680 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_eeg` | EEG Interpretation | 13,225 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_emg_ncs` | EMG/NCS Review | 6,900 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_cta` | Neuro CTA Review | 9,085 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_mra` | Neuro MRA Review | 6,210 | NULL | ✗ | NEW PRICE |
| Neurology | `neuro_spine_mri` | Neuro Spine MRI Review | 9,315 | NULL | ✗ | NEW PRICE |
| OB/GYN | `226a46c3-c09a-4bb4-9020-1aca84286456` | Fertility Panel Review | 2,990 | 2,990 | ✓ | — |
| OB/GYN | `c3b25b89-abcb-4351-b784-29fda57e3303` | Fetal Echocardiography Review | 5,980 | 5,980 | ✓ | — |
| OB/GYN | `381228d3-9967-45aa-b37b-f5d52833a42e` | Fibroid Management Review | 3,680 | 3,680 | ✓ | — |
| OB/GYN | `c8e6b8e3-eb44-4039-94f7-29d3fe510db2` | Gynaecological Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| OB/GYN | `8dc26268-ce9f-4abc-b3ee-81e8bfa1bcf7` | HSG Report Review | 2,990 | 2,990 | ✓ | — |
| OB/GYN | `86311863-9230-4181-a93a-1c8ad9c3d4b8` | MRI Pelvis Review | 7,935 | 7,935 | ✓ | — |
| OB/GYN | `751a96a3-4491-481e-b15f-85ecce841ab0` | Obstetric Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| OB/GYN | `914f690d-e65c-4374-aa77-c6cb5d020ebd` | Pap Smear Report Review | 1,380 | 1,380 | ✓ | — |
| OB/GYN | `804d2c86-e917-4003-bf85-78ae90e4fc46` | Prenatal Labs Review | 1,725 | 1,725 | ✓ | — |
| Oncology | `onc_bone_marrow_biopsy` | Bone Marrow Biopsy Review | 11,500 | NULL | ✗ | NEW PRICE |
| Oncology | `onc_ct_mri_staging` | CT/MRI Staging Review | 17,480 | NULL | ✗ | NEW PRICE |
| Ophthalmology | `7d87d268-800b-403e-bd4f-d5d6a6a60fa7` | Diabetic Retinopathy Review | 3,680 | 3,680 | ✓ | — |
| Ophthalmology | `8e52adb3-70ba-4f85-b31d-5c2c5d33c95f` | Fluorescein Angiography Review | 6,555 | 6,555 | ✓ | — |
| Ophthalmology | `ce27136e-8334-487d-b0be-9394fa3a5c04` | Fundus Photography Review | 2,990 | 2,990 | ✓ | — |
| Ophthalmology | `0c4257f2-ce6f-4d6e-bcdf-43d5870c7483` | Glaucoma Workup Review | 5,175 | 5,175 | ✓ | — |
| Ophthalmology | `31caa261-6e99-490e-92b4-f41c063c0df6` | MRI Orbit Review | 7,475 | 7,475 | ✓ | — |
| Ophthalmology | `c479cb12-65f7-476f-891d-54b92e408437` | OCT Scan Review | 3,680 | 3,680 | ✓ | — |
| Ophthalmology | `89022187-e714-4558-b460-8eb8576cb5a7` | Pre-Op Surgical Opinion | 5,980 | 5,980 | ✓ | — |
| Ophthalmology | `b41eac6d-47d4-482f-888d-97ffb3070490` | Retinal Imaging Review | 5,175 | 5,175 | ✓ | — |
| Ophthalmology | `53b8103b-a3b3-4f80-8c37-274e15758e97` | Visual Field Test Review | 2,645 | 2,645 | ✓ | — |
| Orthopedics | `f7212d50-4ec9-4f75-93c4-38bb2953753f` | Bone Density (DEXA) Review | 1,725 | 1,725 | ✓ | — |
| Orthopedics | `bd9ae0ea-4516-4b0b-bedd-524847c20005` | CT Scan Review | 4,140 | 4,140 | ✓ | — |
| Orthopedics | `57749223-ea3b-43d6-9561-8641d4d4297d` | Fracture Management Review | 3,680 | 3,680 | ✓ | — |
| Orthopedics | `6f068411-f7fb-461c-8725-5081543f80da` | Hip MRI Review | 4,715 | 4,715 | ✓ | — |
| Orthopedics | `20782c32-9943-4867-abc0-c35d25b925ad` | Knee MRI Review | 4,715 | 4,715 | ✓ | — |
| Orthopedics | `c48b7386-0877-4cb0-9725-4cafc809b895` | Orthopedic MRI Review | 5,175 | 5,175 | ✓ | — |
| Orthopedics | `e52f1bf2-11aa-4941-8100-387ecff881f2` | Post-Operative Review | 4,485 | 4,485 | ✓ | — |
| Orthopedics | `95e10e76-4c56-401e-a5ce-b2f75d34fdea` | Pre-Operative Opinion | 6,555 | 6,555 | ✓ | — |
| Orthopedics | `eb2c20d7-f956-4b0f-a638-aafdd3d1e888` | Shoulder MRI Review | 4,715 | 4,715 | ✓ | — |
| Orthopedics | `fcf976a7-d58d-49e3-b072-d2fcdc16d7ad` | Spine Imaging Review | 5,175 | 5,175 | ✓ | — |
| Orthopedics | `8df6ec54-9a42-4377-89af-7ffec238018a` | X-Ray Review | 1,380 | 1,380 | ✓ | — |
| Pulmonology | `055b0b59-cb66-4312-9a25-dd69f6a37318` | Bronchoscopy Report Review | 6,555 | 6,555 | ✓ | — |
| Pulmonology | `767d653b-0945-4ba6-b42e-44614b68fc85` | Chest X-Ray Review | 1,250 | 920 | ✓ | +330 |
| Pulmonology | `570a903f-8e16-4a15-bcb2-f92740e27ffa` | CT Chest Review | 5,175 | 5,175 | ✓ | — |
| Pulmonology | `7d2407d6-a297-4fea-aed7-da4babb6c3ed` | HRCT Chest Review | 7,475 | 7,475 | ✓ | — |
| Pulmonology | `5d81155f-35ff-422e-807c-37a5cc7a9b5e` | Post-COVID Lung Review | 3,680 | 3,680 | ✓ | — |
| Pulmonology | `8142527a-dfc3-47a1-876c-606d86a6e6da` | Pulmonary Function Test Review | 3,680 | 3,680 | ✓ | — |
| Pulmonology | `7de25d3f-363b-4db7-8853-2a6d90800401` | Sleep Study (PSG) Review | 7,475 | 7,475 | ✓ | — |
| Pulmonology | `64843aa5-6703-444a-9f5d-53e1e1342df4` | TB Workup Review | 3,680 | 3,680 | ✓ | — |
| Pulmonology | `92e584e4-1c16-4334-922a-5886672c9b6c` | V/Q Scan Review | 6,555 | 6,555 | ✓ | — |
| Radiology | `rad_abd_pelvis_ct_mri` | Abdomen/Pelvis CT/MRI Review | 8,050 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_cardiac_ct` | Cardiac CT Review | 7,935 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_cardiac_mri` | Cardiac MRI Review | 8,395 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_ct_review` | CT Scan Review | 9,085 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_ct_mr_angio` | CT/MR Angiography Review | 17,480 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_mri_review` | MRI Review | 8,395 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_msk_imaging` | Musculoskeletal Imaging Review | 1,840 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_neuro_imaging` | Neuro Imaging Review | 5,233 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_spine_mri` | Spine MRI Review | 9,315 | NULL | ✗ | NEW PRICE |
| Radiology | `rad_us_review` | Ultrasound Review | 1,725 | NULL | ✗ | NEW PRICE |
| Urology | `362481e4-1b61-4f37-9ee3-5c4109816a01` | Bladder Ultrasound Review | 2,185 | 2,185 | ✓ | — |
| Urology | `18b1e5a5-3218-49a0-8ac5-fc545746d921` | Cystoscopy Report Review | 5,980 | 5,980 | ✓ | — |
| Urology | `efe933ea-e15e-4336-9e22-f1f487ea0762` | Kidney/Ureter CT Review | 4,140 | 4,140 | ✓ | — |
| Urology | `35242a11-0fad-4d0b-a6a9-be19d7b511fb` | MRI Prostate Review | 7,475 | 7,475 | ✓ | — |
| Urology | `96e8adde-dc99-4e60-a1ed-d1ea3cd18c8e` | Prostate Workup Review | 3,680 | 3,680 | ✓ | — |
| Urology | `43ab445f-68a3-46d1-9af5-0024fce4d0bb` | PSA & Prostate Panel Review | 2,185 | 2,185 | ✓ | — |
| Urology | `edb1d583-6dab-49af-af75-abea9bfdc571` | Renal Stone Management Review | 3,680 | 3,680 | ✓ | — |
| Urology | `ca8cc7e9-80b3-450c-a1b8-793aa1eff45a` | Scrotal Ultrasound Review | 2,645 | 2,645 | ✓ | — |
| Urology | `784adb02-0189-41aa-8f89-724b2de39568` | Urodynamics Study Review | 6,555 | 6,555 | ✓ | — |

---

## Artifacts

- `/tmp/prod_recon.json` — full structured reconciliation data (intermediate, not committed)
- `/tmp/services_PROD.tsv` — prod snapshot used for matching (intermediate, not committed)
- This report: `docs/pricing/PRICING_RECONCILIATION_v4_PROD.md`

**Snapshot integrity:** prod `services` row count at report-write time = 187. Re-running the matcher against the same snapshot is deterministic; re-pulling prod after subsequent migrations will of course produce different deltas.
