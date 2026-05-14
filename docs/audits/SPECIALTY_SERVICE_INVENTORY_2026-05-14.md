# Specialty / Service Inventory — Production Snapshot 2026-05-14

**Generated:** 2026-05-14
**Source DB:** production Supabase (`aws-1-us-east-1.pooler.supabase.com`, `postgres` db, `services` + `specialties` tables)
**Mode:** READ-ONLY — no schema or data changes performed

## Summary

| Metric | Count |
|---|---:|
| Total specialties | **28** |
| Visible specialties (`is_visible=true`) | **22** |
| Hidden specialties (`is_visible=false`) | **6** |
| Total services | **156** |
| Visible services (`is_visible=true`) | **137** |
| Hidden services (`is_visible=false`) | **19** |
| Services with NULL or 0 base_price | **19** |
| Services with NULL or 0 doctor_fee | **19** |

### Schema note

`specialties` columns: `id, name, name_ar, is_visible, description, description_ar`.
`services` columns: `id, specialty_id, code, name, base_price, doctor_fee, currency, payment_link, sla_hours, is_visible, video_consultation_price, video_doctor_commission_pct, appointment_price, doctor_commission_pct, video_consultation_prices_json, sla_24hr_price, sla_24hr_prices_json, vip_multiplier, urgent_multiplier, urgency_uplift_doctor_pct`.

No `tier` / `complexity` column exists on `services` in prod. Complexity tier (Simple / Moderate / Complex) only appears on the canonical pricing sheet, not the DB.

---

## Per-specialty tables

### Anesthesiology / التخدير — `spec-anesthesiology` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Cardiology / أمراض القلب — `spec-cardiology` — is_visible: true — 11 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `card_ecg_12lead` | `card_ecg_12lead` | 12-Lead ECG Interpretation | 1250 | 250 | 0 | — | 100 | 48 | ✓ |
| `card_calcium_score` | `card_calcium_score` | Calcium Score Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `card_cmr` | `card_cmr` | Cardiac MR Review | 8395 | 1679 | 0 | — | 100 | 48 | ✓ |
| `card_ctca` | `card_ctca` | CT Coronary Angiography Review | 7935 | 1587 | 0 | — | 100 | 48 | ✓ |
| `card_echo` | `card_echo` | Echocardiogram Review | 1380 | 276 | 0 | — | 100 | 48 | ✓ |
| `card_event_monitor` | `card_event_monitor` | Event Monitor Review | — | — | 0 | — | 100 | 48 | ✗ |
| `card_holter_24_72` | `card_holter_24_72` | Holter Monitor (24-72h) Review | 3450 | 690 | 0 | — | 100 | 48 | ✓ |
| `card_preop_clearance` | `card_preop_clearance` | Pre-Op Cardiac Clearance | — | — | 0 | — | 100 | 48 | ✗ |
| `card_rhythm_strip` | `card_rhythm_strip` | Rhythm Strip Analysis | 1250 | 250 | 0 | — | 100 | 48 | ✓ |
| `card_stress_echo` | `card_stress_echo` | Stress Echo Review | 2070 | 414 | 0 | — | 100 | 48 | ✓ |
| `card_stress_treadmill` | `card_stress_treadmill` | Stress Treadmill Test Review | 1553 | 311 | 0 | — | 100 | 48 | ✓ |

### Cardiothoracic Surgery / جراحة القلب والصدر — `spec-cardiothoracic` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Clinical Nutrition / التغذية العلاجية — `spec-clinical-nutrition` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Dermatology / الأمراض الجلدية — `spec-dermatology` — is_visible: true — 8 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `f2c6ad36-af16-417d-8b17-f66afbd7f750` | `` | Autoimmune Skin Panel Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `0ad67dc7-55f4-405a-938b-433e283b82ee` | `` | Chronic Wound Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `30641b01-db6b-46bc-bee0-d3037873c2be` | `` | Clinical Photo Review | 2645 | 529 | 0 | — | 100 | 48 | ✓ |
| `783ad9ec-a01c-4c12-8cad-b466a838390a` | `` | Dermoscopy Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `911127b5-34e2-47b5-853a-6975f4a54b0f` | `` | Hair Loss Workup Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `ac1f3447-9cb2-4c2a-ba8f-b5d2560f9d69` | `` | Patch Test Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `2da99181-dfc6-4e55-be0b-fb9ea28b09c4` | `` | Psoriasis Management Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `f3d1a7f1-a6cc-4a0d-ab8f-678caa10474d` | `` | Skin Biopsy Report Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |

### Emergency Medicine / طب الطوارئ — `spec-emergency-medicine` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Endocrinology / الغدد الصماء — `spec-endocrinology` — is_visible: true — 10 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `014b800d-7431-4cf6-9e87-37599be29399` | `` | Adrenal Workup Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `f2333602-2a06-4a5c-898a-a403a2243008` | `` | Diabetes Management Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `08766418-29d9-4012-ac42-6a5fdb623bae` | `` | Full Thyroid Panel Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |
| `1d115a28-abe4-4e0d-aa0b-3735338f1453` | `` | Growth Hormone Panel Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `bb1a3406-2007-44ac-a165-e10256cd2b76` | `` | Lipid Disorder Management | 1725 | 345 | 0 | — | 100 | 48 | ✓ |
| `357a9ed9-0dc3-47b6-b53c-db05b50ab7e6` | `` | Obesity/Metabolic Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `2fca13ac-08b1-4118-83c6-2dca3d950563` | `` | Osteoporosis Workup Review | 2645 | 529 | 0 | — | 100 | 48 | ✓ |
| `5ab109b3-4637-448c-8e6d-1f3821a58e3a` | `` | PCOS Panel Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `89ff1ef4-c4fd-441f-9aa9-8e92aa846436` | `` | Pituitary MRI Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `a9ac1b8e-e8fc-43e4-8783-de53536f6cc7` | `` | Thyroid Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |

### Gastroenterology / الجهاز الهضمي — `spec-gastroenterology` — is_visible: true — 10 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `ccc8556d-089a-4b61-b21c-7fc3bc9cda62` | `` | Capsule Endoscopy Review | 10465 | 2093 | 0 | — | 100 | 48 | ✓ |
| `0e6c534d-dfab-4c2b-a950-0eda846a1cdb` | `` | Colonoscopy Report Review | 4485 | 897 | 0 | — | 100 | 48 | ✓ |
| `c1e9624a-78c2-4c8c-b6ca-7b3694719eb8` | `` | Endoscopy Report Review | 4485 | 897 | 0 | — | 100 | 48 | ✓ |
| `9ffc180c-bed2-4305-b71c-2303c12f30b6` | `` | FibroScan/Elastography Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `4f3ff7a9-bbf4-41ac-bbf9-e731f62bbad7` | `` | Hepatitis B/C Panel Review | 3105 | 621 | 0 | — | 100 | 48 | ✓ |
| `6193b569-cfe7-40d9-a2a7-ce7b02189395` | `` | IBD Investigation Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `d8e374d9-0ae0-4c1a-9299-a508752fdf7b` | `` | Liver Biopsy Report Review | 10465 | 2093 | 0 | — | 100 | 48 | ✓ |
| `3576c5fe-59a7-4370-ad05-f34e40d8a1e8` | `` | Liver MRI Review | 8970 | 1794 | 0 | — | 100 | 48 | ✓ |
| `891c261f-6c63-4341-8644-a75af15c7a59` | `` | Liver Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `7fa58485-fe05-49ef-85c7-607abc91c123` | `` | MRCP Review | 9545 | 1909 | 0 | — | 100 | 48 | ✓ |

### Hematology / أمراض الدم — `spec-hematology` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `08681b8c-8fe5-44d2-90b4-956974dbbc29` | `` | Anemia Workup Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `68d477c3-2414-4307-8bdb-ce732604338d` | `` | Bone Marrow Biopsy Review | 14950 | 2990 | 0 | — | 100 | 48 | ✓ |
| `b992e0c0-1f0c-4747-b122-d9c5bd2d04a1` | `` | Coagulation Panel Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `cc7f3467-17b2-4f75-96b7-ce56dd1cbc39` | `` | Flow Cytometry Review | 13455 | 2691 | 0 | — | 100 | 48 | ✓ |
| `77f4db68-466d-4874-ba04-88d3dccfad6b` | `` | Full CBC with Differential Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |
| `fb41d6e4-1221-4b79-9b7d-b1dd512b93a3` | `` | Immunoglobulins/SPEP Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |
| `aeea6eee-2a3a-4833-af8c-6ced381f76ea` | `` | Lymphoma Staging Review | 13455 | 2691 | 0 | — | 100 | 48 | ✓ |
| `d05d3fa7-81d5-4cbc-b5ec-cd96187f14c7` | `` | Sickle Cell/Thalassemia Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `75ae2cee-6b8a-4cea-8240-89a821a47938` | `` | Thrombophilia Panel Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |

### Nephrology / أمراض الكلى — `spec-nephrology` — is_visible: true — 8 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `bef26bde-7f2c-4ed9-ac08-6d4ef3075e03` | `` | CKD Staging & Management Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `6d7409bb-18a2-4659-a119-e7102ea3c2b0` | `` | Dialysis Adequacy Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `442081e7-0abb-490e-9df1-0ef7f0bd0397` | `` | Hypertension Workup Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `5318c5cf-9097-47a9-b1a7-a40c1ba68406` | `` | Kidney Biopsy Report Review | 10465 | 2093 | 0 | — | 100 | 48 | ✓ |
| `cd428c90-e144-48a6-ae2d-e7321c47eb62` | `` | Kidney Function Panel Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |
| `90445995-81a2-4dfa-9c33-5b39cb6779ad` | `` | Kidney Stone CT Review | 4140 | 828 | 0 | — | 100 | 48 | ✓ |
| `3896c375-5e86-4b83-b978-6dcd4257bd23` | `` | Kidney Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `22028c6f-2f3a-427f-bc37-e65e3e518836` | `` | Proteinuria Workup Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |

### Neurology / المخ والأعصاب — `spec-neurology` — is_visible: true — 11 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `neuro_brain_ct` | `neuro_brain_ct` | Brain CT Review | 1553 | 311 | 0 | — | 100 | 48 | ✓ |
| `neuro_brain_mri` | `neuro_brain_mri` | Brain MRI Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `neuro_eeg` | `neuro_eeg` | EEG Interpretation | 13225 | 2645 | 0 | — | 100 | 48 | ✓ |
| `neuro_emg_ncs` | `neuro_emg_ncs` | EMG/NCS Review | 6900 | 1380 | 0 | — | 100 | 48 | ✓ |
| `neuro_epilepsy_imaging` | `neuro_epilepsy_imaging` | Epilepsy Imaging Review | — | — | 0 | — | 100 | 48 | ✗ |
| `neuro_cta` | `neuro_cta` | Neuro CTA Review | 9085 | 1817 | 0 | — | 100 | 48 | ✓ |
| `neuro_mra` | `neuro_mra` | Neuro MRA Review | 6210 | 1242 | 0 | — | 100 | 48 | ✓ |
| `neuro_spine_mri` | `neuro_spine_mri` | Neuro Spine MRI Review | 9315 | 1863 | 0 | — | 100 | 48 | ✓ |
| `neuro_neurovascular` | `neuro_neurovascular` | Neurovascular Review | — | — | 0 | — | 100 | 48 | ✗ |
| `neuro_perfusion` | `neuro_perfusion` | Perfusion Imaging Review | — | — | 0 | — | 100 | 48 | ✗ |
| `neuro_stroke_imaging` | `neuro_stroke_imaging` | Stroke Imaging Review | — | — | 0 | — | 100 | 48 | ✗ |

### OB/GYN / النساء والتوليد — `spec-obgyn` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `226a46c3-c09a-4bb4-9020-1aca84286456` | `` | Fertility Panel Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `c3b25b89-abcb-4351-b784-29fda57e3303` | `` | Fetal Echocardiography Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `381228d3-9967-45aa-b37b-f5d52833a42e` | `` | Fibroid Management Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `c8e6b8e3-eb44-4039-94f7-29d3fe510db2` | `` | Gynaecological Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `8dc26268-ce9f-4abc-b3ee-81e8bfa1bcf7` | `` | HSG Report Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `86311863-9230-4181-a93a-1c8ad9c3d4b8` | `` | MRI Pelvis Review | 7935 | 1587 | 0 | — | 100 | 48 | ✓ |
| `751a96a3-4491-481e-b15f-85ecce841ab0` | `` | Obstetric Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `914f690d-e65c-4374-aa77-c6cb5d020ebd` | `` | Pap Smear Report Review | 1380 | 276 | 0 | — | 100 | 48 | ✓ |
| `804d2c86-e917-4003-bf85-78ae90e4fc46` | `` | Prenatal Labs Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |

### Oncology / الأورام — `spec-oncology` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `onc_bone_marrow_biopsy` | `onc_bone_marrow_biopsy` | Bone Marrow Biopsy Review | 11500 | 2300 | 0 | — | 100 | 48 | ✓ |
| `onc_ct_mri_staging` | `onc_ct_mri_staging` | CT/MRI Staging Review | 17480 | 3496 | 0 | — | 100 | 48 | ✓ |
| `onc_cytology_reports` | `onc_cytology_reports` | Cytology Report Review | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_heme_onc_blood` | `onc_heme_onc_blood` | Hemato-Oncology Blood Review | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_histo_reports` | `onc_histo_reports` | Histopathology Report Review | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_petct_imaging` | `onc_petct_imaging` | PET-CT Imaging Review | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_recist_response` | `onc_recist_response` | RECIST Response Assessment | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_rt_planning_scan` | `onc_rt_planning_scan` | RT Planning Scan Review | — | — | 0 | — | 100 | 48 | ✗ |
| `onc_tumor_markers` | `onc_tumor_markers` | Tumor Markers Review | — | — | 0 | — | 100 | 48 | ✗ |

### Ophthalmology / طب العيون — `spec-ophthalmology` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `7d87d268-800b-403e-bd4f-d5d6a6a60fa7` | `` | Diabetic Retinopathy Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `8e52adb3-70ba-4f85-b31d-5c2c5d33c95f` | `` | Fluorescein Angiography Review | 6555 | 1311 | 0 | — | 100 | 48 | ✓ |
| `ce27136e-8334-487d-b0be-9394fa3a5c04` | `` | Fundus Photography Review | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `0c4257f2-ce6f-4d6e-bcdf-43d5870c7483` | `` | Glaucoma Workup Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `31caa261-6e99-490e-92b4-f41c063c0df6` | `` | MRI Orbit Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |
| `c479cb12-65f7-476f-891d-54b92e408437` | `` | OCT Scan Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `89022187-e714-4558-b460-8eb8576cb5a7` | `` | Pre-Op Surgical Opinion | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `b41eac6d-47d4-482f-888d-97ffb3070490` | `` | Retinal Imaging Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `53b8103b-a3b3-4f80-8c37-274e15758e97` | `` | Visual Field Test Review | 2645 | 529 | 0 | — | 100 | 48 | ✓ |

### Orthopedics / العظام — `spec-orthopedics` — is_visible: true — 11 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `f7212d50-4ec9-4f75-93c4-38bb2953753f` | `` | Bone Density (DEXA) Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |
| `bd9ae0ea-4516-4b0b-bedd-524847c20005` | `` | CT Scan Review | 4140 | 828 | 0 | — | 100 | 48 | ✓ |
| `57749223-ea3b-43d6-9561-8641d4d4297d` | `` | Fracture Management Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `6f068411-f7fb-461c-8725-5081543f80da` | `` | Hip MRI Review | 4715 | 943 | 0 | — | 100 | 48 | ✓ |
| `20782c32-9943-4867-abc0-c35d25b925ad` | `` | Knee MRI Review | 4715 | 943 | 0 | — | 100 | 48 | ✓ |
| `c48b7386-0877-4cb0-9725-4cafc809b895` | `` | Orthopedic MRI Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `e52f1bf2-11aa-4941-8100-387ecff881f2` | `` | Post-Operative Review | 4485 | 897 | 0 | — | 100 | 48 | ✓ |
| `95e10e76-4c56-401e-a5ce-b2f75d34fdea` | `` | Pre-Operative Opinion | 6555 | 1311 | 0 | — | 100 | 48 | ✓ |
| `eb2c20d7-f956-4b0f-a638-aafdd3d1e888` | `` | Shoulder MRI Review | 4715 | 943 | 0 | — | 100 | 48 | ✓ |
| `fcf976a7-d58d-49e3-b072-d2fcdc16d7ad` | `` | Spine Imaging Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `8df6ec54-9a42-4377-89af-7ffec238018a` | `` | X-Ray Review | 1380 | 276 | 0 | — | 100 | 48 | ✓ |

### Pathology / علم الأمراض — `spec-pathology` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Psychiatry / الطب النفسي — `spec-psychiatry` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Pulmonology / أمراض الصدر — `spec-pulmonology` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `055b0b59-cb66-4312-9a25-dd69f6a37318` | `` | Bronchoscopy Report Review | 6555 | 1311 | 0 | — | 100 | 48 | ✓ |
| `767d653b-0945-4ba6-b42e-44614b68fc85` | `` | Chest X-Ray Review | 920 | 184 | 0 | — | 100 | 48 | ✓ |
| `570a903f-8e16-4a15-bcb2-f92740e27ffa` | `` | CT Chest Review | 5175 | 1035 | 0 | — | 100 | 48 | ✓ |
| `7d2407d6-a297-4fea-aed7-da4babb6c3ed` | `` | HRCT Chest Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |
| `5d81155f-35ff-422e-807c-37a5cc7a9b5e` | `` | Post-COVID Lung Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `8142527a-dfc3-47a1-876c-606d86a6e6da` | `` | Pulmonary Function Test Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `7de25d3f-363b-4db7-8853-2a6d90800401` | `` | Sleep Study (PSG) Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |
| `64843aa5-6703-444a-9f5d-53e1e1342df4` | `` | TB Workup Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `92e584e4-1c16-4334-922a-5886672c9b6c` | `` | V/Q Scan Review | 6555 | 1311 | 0 | — | 100 | 48 | ✓ |

### Radiology / الأشعة — `spec-radiology` — is_visible: true — 12 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `rad_abd_pelvis_ct_mri` | `rad_abd_pelvis_ct_mri` | Abdomen/Pelvis CT/MRI Review | 8050 | 1610 | 0 | — | 100 | 48 | ✓ |
| `rad_cardiac_ct` | `rad_cardiac_ct` | Cardiac CT Review | 7935 | 1587 | 0 | — | 100 | 48 | ✓ |
| `rad_cardiac_mri` | `rad_cardiac_mri` | Cardiac MRI Review | 8395 | 1679 | 0 | — | 100 | 48 | ✓ |
| `rad_cxr_review` | `rad_cxr_review` | Chest X-Ray Review | 1250 | 250 | 0 | — | 100 | 48 | ✓ |
| `rad_ct_review` | `rad_ct_review` | CT Scan Review | 9085 | 1817 | 0 | — | 100 | 48 | ✓ |
| `rad_ct_mr_angio` | `rad_ct_mr_angio` | CT/MR Angiography Review | 17480 | 3496 | 0 | — | 100 | 48 | ✓ |
| `rad_mri_review` | `rad_mri_review` | MRI Review | 8395 | 1679 | 0 | — | 100 | 48 | ✓ |
| `rad_msk_imaging` | `rad_msk_imaging` | Musculoskeletal Imaging Review | 1840 | 368 | 0 | — | 100 | 48 | ✓ |
| `rad_neuro_imaging` | `rad_neuro_imaging` | Neuro Imaging Review | 5233 | 1047 | 0 | — | 100 | 48 | ✓ |
| `rad_onc_petct_staging` | `rad_onc_petct_staging` | Oncology PET-CT Staging | — | — | 0 | — | 100 | 48 | ✗ |
| `rad_spine_mri` | `rad_spine_mri` | Spine MRI Review | 9315 | 1863 | 0 | — | 100 | 48 | ✓ |
| `rad_us_review` | `rad_us_review` | Ultrasound Review | 1725 | 345 | 0 | — | 100 | 48 | ✓ |

### Rheumatology / أمراض الروماتيزم — `spec-rheumatology` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Urology / المسالك البولية — `spec-urology` — is_visible: true — 9 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `362481e4-1b61-4f37-9ee3-5c4109816a01` | `` | Bladder Ultrasound Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `18b1e5a5-3218-49a0-8ac5-fc545746d921` | `` | Cystoscopy Report Review | 5980 | 1196 | 0 | — | 100 | 48 | ✓ |
| `efe933ea-e15e-4336-9e22-f1f487ea0762` | `` | Kidney/Ureter CT Review | 4140 | 828 | 0 | — | 100 | 48 | ✓ |
| `35242a11-0fad-4d0b-a6a9-be19d7b511fb` | `` | MRI Prostate Review | 7475 | 1495 | 0 | — | 100 | 48 | ✓ |
| `96e8adde-dc99-4e60-a1ed-d1ea3cd18c8e` | `` | Prostate Workup Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `43ab445f-68a3-46d1-9af5-0024fce4d0bb` | `` | PSA & Prostate Panel Review | 2185 | 437 | 0 | — | 100 | 48 | ✓ |
| `edb1d583-6dab-49af-af75-abea9bfdc571` | `` | Renal Stone Management Review | 3680 | 736 | 0 | — | 100 | 48 | ✓ |
| `ca8cc7e9-80b3-450c-a1b8-793aa1eff45a` | `` | Scrotal Ultrasound Review | 2645 | 529 | 0 | — | 100 | 48 | ✓ |
| `784adb02-0189-41aa-8f89-724b2de39568` | `` | Urodynamics Study Review | 6555 | 1311 | 0 | — | 100 | 48 | ✓ |

### Vascular Surgery / جراحة الأوعية الدموية — `spec-vascular-surgery` — is_visible: true — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Add-on Services / خدمات إضافية — `addon` — is_visible: false — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Lab & Pathology / المختبر وعلم الأمراض — `lab_pathology` — is_visible: false — 21 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| `lab_autoimmune_anca` | `lab_autoimmune_anca` | Autoimmune - ANCA | 2530 | 506 | 0 | — | 100 | 48 | ✓ |
| `lab_autoimmune_anti_dna` | `lab_autoimmune_anti_dna` | Autoimmune - Anti-DNA | 1495 | 299 | 0 | — | 100 | 48 | ✓ |
| `lab_autoimmune_asma` | `lab_autoimmune_asma` | Autoimmune - ASMA | 1495 | 299 | 0 | — | 100 | 48 | ✓ |
| `lab_panel_autoimmune` | `` | Autoimmune Panel Review | 1750 | 350 | 0 | — | 100 | 72 | ✓ |
| `lab_body_fluids` | `lab_body_fluids` | Body Fluids Analysis | — | — | 0 | — | 100 | 48 | ✗ |
| `lab_bone_marrow` | `lab_bone_marrow` | Bone Marrow Aspirate Review | 11500 | 2300 | 0 | — | 100 | 48 | ✓ |
| `lab_panel_coag_electrolytes` | `` | Coagulation & Electrolytes Review | 1250 | 250 | 0 | — | 100 | 72 | ✓ |
| `lab_cytology` | `lab_cytology` | Cytology | 1250 | 250 | 0 | — | 100 | 48 | ✓ |
| `lab_fna` | `lab_fna` | Fine Needle Aspiration (FNA) | — | — | 0 | — | 100 | 48 | ✗ |
| `lab_genetic_molecular` | `lab_genetic_molecular` | Genetic/Molecular Testing | — | — | 0 | — | 100 | 48 | ✗ |
| `lab_histo_large` | `lab_histo_large` | Histopathology - Large Biopsy | 2990 | 598 | 0 | — | 100 | 48 | ✓ |
| `lab_histo_organ` | `lab_histo_organ` | Histopathology - Organ/Resection | 4255 | 851 | 0 | — | 100 | 48 | ✓ |
| `lab_histo_small` | `lab_histo_small` | Histopathology - Small Biopsy | 1668 | 334 | 0 | — | 100 | 48 | ✓ |
| `lab_panel_hormones` | `` | Hormone Panel Review | 1750 | 350 | 0 | — | 100 | 72 | ✓ |
| `lab_micro_sputum_cs` | `lab_micro_sputum_cs` | Microbiology - Sputum C&S | 6900 | 1380 | 0 | — | 100 | 48 | ✓ |
| `lab_panel_microbiology` | `` | Microbiology Cultures Review | 1500 | 300 | 0 | — | 100 | 72 | ✓ |
| `lab_pap_smear` | `lab_pap_smear` | Pap Smear | — | — | 0 | — | 100 | 48 | ✗ |
| `lab_panel_routine_bloods` | `` | Routine Bloods Panel Review | 1500 | 300 | 0 | — | 100 | 72 | ✓ |
| `lab_sensitivity` | `lab_sensitivity` | Sensitivity Testing | — | — | 0 | — | 100 | 48 | ✗ |
| `lab_panel_tumor_markers` | `` | Tumor Markers Panel Review | 1750 | 350 | 0 | — | 100 | 72 | ✓ |
| `lab_panel_urine_stool` | `` | Urine & Stool Workup Review | 1250 | 250 | 0 | — | 100 | 72 | ✓ |

### ENT / أنف وأذن وحنجرة — `spec-ent` — is_visible: false — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### General Surgery / الجراحة العامة — `spec-general-surgery` — is_visible: false — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Internal Medicine / الباطنة — `spec-internal-medicine` — is_visible: false — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

### Pediatrics / طب الأطفال — `spec-pediatrics` — is_visible: false — 0 service(s)

| Service ID | Code | Name | Base Price | Doctor Fee | Appt Price | Video Price | SLA-24hr | SLA hrs | Visible |
|---|---|---|---:|---:|---:|---:|---:|---:|:-:|
| _(no services)_ | | | | | | | | | |

---

## Diff vs canonical pricing sheet

### Source caveat

The audit request asked for a diff against "canonical pricing v4". The repository contains:

- `docs/pricing/tashkheesa_pricing_v2.xlsx` + `tashkheesa_pricing_v2.json` — **v2** canonical sheet (143 priced + 17 unpriced = 160 rows). Present in repo.
- `docs/pricing/PRICING_RECONCILIATION_v4_PROD.md` — **v4** reconciliation report (dated 2026-05-11), which references `Tashkheesa_Canonical_Pricing_v4.xlsx` as its input sheet. **That v4 xlsx is not checked into the repo.**

The diff below is therefore computed against the v2 JSON only.

**⚠ The v2 sheet is stale relative to prod.** Spot-checking Cardiology, the v2 sheet uses different service names ("ECG Review", "Stress Test Review", "Cardiac MRI Review") than what prod actually holds ("12-Lead ECG Interpretation", "Stress Echo Review", "Cardiac MR Review"). The 2026-05-11 v4 PROD reconciliation explicitly notes prod was reconciled to v4 names, which is why a naive (specialty, name) match against v2 produces a huge sheet-only / DB-only diff. Treat the diff below as **evidence of v2 ↔ prod drift**, not as a triage punch-list. The v4 PROD reconciliation report at `docs/pricing/PRICING_RECONCILIATION_v4_PROD.md` is the authoritative source-of-truth until the v4 xlsx is added to the repo.

Note: the v4 PROD report (2026-05-11) counted **187 services** in prod. Today's snapshot shows **156**. Drift of 31 rows since 2026-05-11 — needs follow-up if unexpected.

### Diff summary

| Bucket | Count |
|---|---:|
| Matched (sheet row ↔ DB row by specialty + name) | **27** |
| Sheet-only (sheet row, no corresponding DB row) | **133** |
| DB-only (DB service not on v2 sheet) | **129** |

### Sheet-only rows (on v2 sheet, not in DB)

| Sheet specialty | Sheet service name | Sheet price | Sheet doctor fee | Status | Launch | Reason |
|---|---|---:|---:|---|---|---|
| Radiology | X-Ray Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-radiology with name "X-Ray Review" |
| Radiology | Mammogram Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-radiology with name "Mammogram Review" |
| Radiology | PET-CT Scan Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-radiology with name "PET-CT Scan Review" |
| Radiology | Fluoroscopy Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-radiology with name "Fluoroscopy Review" |
| Radiology | DEXA Scan Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-radiology with name "DEXA Scan Review" |
| Radiology | Interventional Radiology Case Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-radiology with name "Interventional Radiology Case Review" |
| Radiology | Nuclear Medicine Scan Review | 920 | 184 | ✅ Active | ✅ Launch | no row in spec-radiology with name "Nuclear Medicine Scan Review" |
| Cardiology | ECG Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-cardiology with name "ECG Review" |
| Cardiology | Holter Monitor Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-cardiology with name "Holter Monitor Review" |
| Cardiology | Stress Test Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-cardiology with name "Stress Test Review" |
| Cardiology | Cardiac MRI Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-cardiology with name "Cardiac MRI Review" |
| Cardiology | Coronary Angiogram Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-cardiology with name "Coronary Angiogram Review" |
| Cardiology | Cardiac CT Angiography Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-cardiology with name "Cardiac CT Angiography Review" |
| Cardiology | Cardiac Catheterization Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-cardiology with name "Cardiac Catheterization Review" |
| Cardiology | Electrophysiology Study Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-cardiology with name "Electrophysiology Study Review" |
| Neurology | Spine MRI Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-neurology with name "Spine MRI Review" |
| Neurology | EEG Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "EEG Review" |
| Neurology | Nerve Conduction Study Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "Nerve Conduction Study Review" |
| Neurology | EMG Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "EMG Review" |
| Neurology | Brain CT Scan Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "Brain CT Scan Review" |
| Neurology | Cerebral Angiography Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-neurology with name "Cerebral Angiography Review" |
| Neurology | Sleep Study Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "Sleep Study Review" |
| Neurology | Neuropsychological Test Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-neurology with name "Neuropsychological Test Review" |
| Oncology | Tumor Biopsy Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Tumor Biopsy Review" |
| Oncology | Chemotherapy Plan Review | 1725 | 345 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Chemotherapy Plan Review" |
| Oncology | Radiation Therapy Plan Review | 1725 | 345 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Radiation Therapy Plan Review" |
| Oncology | Staging CT Scan Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Staging CT Scan Review" |
| Oncology | Tumor Board Case Review | 2070 | 414 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Tumor Board Case Review" |
| Oncology | Post-Treatment MRI Review | 1150 | 230 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Post-Treatment MRI Review" |
| Oncology | Immunotherapy Response Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-oncology with name "Immunotherapy Response Review" |
| Pathology & Lab | Blood Work Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Blood Work Review" |
| Pathology & Lab | CBC Analysis Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "CBC Analysis Review" |
| Pathology & Lab | Metabolic Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Metabolic Panel Review" |
| Pathology & Lab | Lipid Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Lipid Panel Review" |
| Pathology & Lab | Liver Function Test Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Liver Function Test Review" |
| Pathology & Lab | Kidney Function Test Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Kidney Function Test Review" |
| Pathology & Lab | Thyroid Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Thyroid Panel Review" |
| Pathology & Lab | Coagulation Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Coagulation Panel Review" |
| Pathology & Lab | Hormone Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Hormone Panel Review" |
| Pathology & Lab | Autoimmune Panel Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Autoimmune Panel Review" |
| Pathology & Lab | Infectious Disease Panel Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-pathology with name "Infectious Disease Panel Review" |
| Hematology | CBC & Differential Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "CBC & Differential Review" |
| Hematology | Coagulation Disorder Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "Coagulation Disorder Review" |
| Hematology | Hemoglobin Electrophoresis Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "Hemoglobin Electrophoresis Review" |
| Hematology | Blood Film Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "Blood Film Review" |
| Hematology | Leukemia Case Review | 1380 | 276 | ✅ Active | ✅ Launch | no row in spec-hematology with name "Leukemia Case Review" |
| Hematology | Platelet Disorder Review | 1500 | 300 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "Platelet Disorder Review" |
| Hematology | Iron Studies Review | 1250 | 250 | ✅ Active 🔺 Floored | ✅ Launch | no row in spec-hematology with name "Iron Studies Review" |
| Orthopedics | Bone X-Ray Review | 402 | 80 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Bone X-Ray Review" |
| Orthopedics | Joint MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Joint MRI Review" |
| Orthopedics | Spine MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Spine MRI Review" |
| Orthopedics | DEXA Scan Review | 1250 | 250 | ✅ Active 🔺 Floored | ⚡ Phase 2 | no row in spec-orthopedics with name "DEXA Scan Review" |
| Orthopedics | Arthroscopy Report Review | 920 | 184 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Arthroscopy Report Review" |
| Orthopedics | Sports Injury MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Sports Injury MRI Review" |
| Orthopedics | Scoliosis X-Ray Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Scoliosis X-Ray Review" |
| Orthopedics | Joint Replacement Pre-Op Review | 1150 | 230 | ✅ Active | ⚡ Phase 2 | no row in spec-orthopedics with name "Joint Replacement Pre-Op Review" |
| Gastroenterology | Abdominal CT Scan Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-gastroenterology with name "Abdominal CT Scan Review" |
| Gastroenterology | Liver Biopsy Review | 1150 | 230 | ✅ Active | ⚡ Phase 2 | no row in spec-gastroenterology with name "Liver Biopsy Review" |
| Gastroenterology | H. pylori Test Review | 345 | 69 | ✅ Active | ⚡ Phase 2 | no row in spec-gastroenterology with name "H. pylori Test Review" |
| Gastroenterology | Inflammatory Bowel Disease Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-gastroenterology with name "Inflammatory Bowel Disease Review" |
| Gastroenterology | Celiac Disease Panel Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-gastroenterology with name "Celiac Disease Panel Review" |
| Endocrinology | Thyroid Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ⚡ Phase 2 | no row in spec-endocrinology with name "Thyroid Panel Review" |
| Endocrinology | Adrenal Gland MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-endocrinology with name "Adrenal Gland MRI Review" |
| Endocrinology | Bone Density (DEXA) Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-endocrinology with name "Bone Density (DEXA) Review" |
| Endocrinology | Hormone Panel Review | 1250 | 250 | ✅ Active 🔺 Floored | ⚡ Phase 2 | no row in spec-endocrinology with name "Hormone Panel Review" |
| Endocrinology | Parathyroid Scan Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-endocrinology with name "Parathyroid Scan Review" |
| Endocrinology | Thyroid Biopsy (FNA) Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-endocrinology with name "Thyroid Biopsy (FNA) Review" |
| Pulmonology | Chest CT Scan Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-pulmonology with name "Chest CT Scan Review" |
| Pulmonology | Sleep Study Review | 1500 | 300 | ✅ Active 🔺 Floored | ⚡ Phase 2 | no row in spec-pulmonology with name "Sleep Study Review" |
| Pulmonology | High-Resolution CT (HRCT) Review | 920 | 184 | ✅ Active | ⚡ Phase 2 | no row in spec-pulmonology with name "High-Resolution CT (HRCT) Review" |
| Pulmonology | CTPA (PE Protocol) Review | 920 | 184 | ✅ Active | ⚡ Phase 2 | no row in spec-pulmonology with name "CTPA (PE Protocol) Review" |
| Pulmonology | Pleural Fluid Analysis Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-pulmonology with name "Pleural Fluid Analysis Review" |
| Pulmonology | Lung Biopsy Review | 1150 | 230 | ✅ Active | ⚡ Phase 2 | no row in spec-pulmonology with name "Lung Biopsy Review" |
| Urology | Kidney Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Kidney Ultrasound Review" |
| Urology | Renal CT Scan Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Renal CT Scan Review" |
| Urology | Prostate MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Prostate MRI Review" |
| Urology | PSA Test Review | 288 | 58 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "PSA Test Review" |
| Urology | Urodynamics Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Urodynamics Review" |
| Urology | Kidney Biopsy Review | 1150 | 230 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Kidney Biopsy Review" |
| Urology | Testicular Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Testicular Ultrasound Review" |
| Urology | Bladder CT Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-urology with name "Bladder CT Review" |
| Dermatology | Skin Biopsy Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Skin Biopsy Review" |
| Dermatology | Dermoscopy Image Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Dermoscopy Image Review" |
| Dermatology | Skin Allergy Panel Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Skin Allergy Panel Review" |
| Dermatology | Psoriasis Case Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Psoriasis Case Review" |
| Dermatology | Melanoma Staging Review | 920 | 184 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Melanoma Staging Review" |
| Dermatology | Wound Assessment Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Wound Assessment Review" |
| Dermatology | Hair Loss Investigation Review | 518 | 104 | ✅ Active | ⚡ Phase 2 | no row in spec-dermatology with name "Hair Loss Investigation Review" |
| Ophthalmology | Retinal OCT Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-ophthalmology with name "Retinal OCT Review" |
| Ophthalmology | Corneal Topography Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-ophthalmology with name "Corneal Topography Review" |
| Ophthalmology | Glaucoma Work-Up Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-ophthalmology with name "Glaucoma Work-Up Review" |
| Ophthalmology | Orbital MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-ophthalmology with name "Orbital MRI Review" |
| ENT (Ear, Nose & Throat) | Hearing Test (Audiogram) Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Hearing Test (Audiogram) Review" |
| ENT (Ear, Nose & Throat) | CT Sinuses Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "CT Sinuses Review" |
| ENT (Ear, Nose & Throat) | Laryngoscopy Report Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Laryngoscopy Report Review" |
| ENT (Ear, Nose & Throat) | Temporal Bone CT Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Temporal Bone CT Review" |
| ENT (Ear, Nose & Throat) | Neck MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Neck MRI Review" |
| ENT (Ear, Nose & Throat) | Tympanometry Review | 402 | 80 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Tympanometry Review" |
| ENT (Ear, Nose & Throat) | Thyroid Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Thyroid Ultrasound Review" |
| ENT (Ear, Nose & Throat) | Salivary Gland Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-ent with name "Salivary Gland Ultrasound Review" |
| General Surgery | Pre-Op Surgical Report Review | 920 | 184 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Pre-Op Surgical Report Review" |
| General Surgery | Post-Op Complication Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Post-Op Complication Review" |
| General Surgery | Abdominal CT Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Abdominal CT Review" |
| General Surgery | Surgical Biopsy Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Surgical Biopsy Review" |
| General Surgery | Hernia Assessment Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Hernia Assessment Review" |
| General Surgery | Wound Care Assessment Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Wound Care Assessment Review" |
| General Surgery | Gallbladder Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Gallbladder Ultrasound Review" |
| General Surgery | Appendix CT Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-general-surgery with name "Appendix CT Review" |
| Pediatrics | Growth & Development Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Growth & Development Review" |
| Pediatrics | Pediatric Blood Work Review | 402 | 80 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Pediatric Blood Work Review" |
| Pediatrics | Pediatric Echo Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Pediatric Echo Review" |
| Pediatrics | Pediatric Brain MRI Review | 1035 | 207 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Pediatric Brain MRI Review" |
| Pediatrics | Pediatric Abdominal Ultrasound Review | 575 | 115 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Pediatric Abdominal Ultrasound Review" |
| Pediatrics | Neonatal Screening Review | 690 | 138 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Neonatal Screening Review" |
| Pediatrics | Pediatric X-Ray Review | 402 | 80 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Pediatric X-Ray Review" |
| Pediatrics | Vaccination & Immunology Review | 460 | 92 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "Vaccination & Immunology Review" |
| Pediatrics | ADHD/Neuro Assessment Review | 805 | 161 | ✅ Active | ⚡ Phase 2 | no row in spec-pediatrics with name "ADHD/Neuro Assessment Review" |
| Cardiology | Pre-Op Cardiac Clearance Review | — | — | 🚫 Not at Shifa | ✅ Launch | no row in spec-cardiology with name "Pre-Op Cardiac Clearance Review" |
| Neurology | Neuro Perfusion Study Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-neurology with name "Neuro Perfusion Study Review" |
| Neurology | Epilepsy Monitoring Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-neurology with name "Epilepsy Monitoring Review" |
| Neurology | Stroke Protocol MRI Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-neurology with name "Stroke Protocol MRI Review" |
| Neurology | Neurovascular MRI Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-neurology with name "Neurovascular MRI Review" |
| Oncology | PET-CT Staging Review | — | — | 🚫 Not at Shifa | ✅ Launch | no row in spec-oncology with name "PET-CT Staging Review" |
| Oncology | Genetic/Molecular Testing Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-oncology with name "Genetic/Molecular Testing Review" |
| Oncology | RECIST Measurement Review | — | — | 🚫 Not at Shifa | ✅ Launch | no row in spec-oncology with name "RECIST Measurement Review" |
| Pathology & Lab | Tumor Markers Review | — | — | 🔗 External | ✅ Launch | no row in spec-pathology with name "Tumor Markers Review" |
| Pathology & Lab | Histopathology Review | — | — | 🔗 External | ✅ Launch | no row in spec-pathology with name "Histopathology Review" |
| Pathology & Lab | Cytology Review | — | — | 🔗 External | ✅ Launch | no row in spec-pathology with name "Cytology Review" |
| Pathology & Lab | Hematology Blood Review | — | — | 🔗 External | ✅ Launch | no row in spec-pathology with name "Hematology Blood Review" |
| Pathology & Lab | Pap Smear Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-pathology with name "Pap Smear Review" |
| Pathology & Lab | Body Fluids Analysis Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-pathology with name "Body Fluids Analysis Review" |
| Pathology & Lab | FNA (Fine Needle Aspiration) Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-pathology with name "FNA (Fine Needle Aspiration) Review" |
| Pathology & Lab | Sensitivity Testing Review | — | — | ❓ Needs Cost | ✅ Launch | no row in spec-pathology with name "Sensitivity Testing Review" |

### DB-only rows (in production DB, not on v2 sheet)

| Service ID | Specialty | Name | Base Price | Doctor Fee | Visible |
|---|---|---|---:|---:|:-:|
| `lab_autoimmune_anca` | Lab & Pathology | Autoimmune - ANCA | 2530 | 506 | ✓ |
| `lab_autoimmune_anti_dna` | Lab & Pathology | Autoimmune - Anti-DNA | 1495 | 299 | ✓ |
| `lab_autoimmune_asma` | Lab & Pathology | Autoimmune - ASMA | 1495 | 299 | ✓ |
| `lab_panel_autoimmune` | Lab & Pathology | Autoimmune Panel Review | 1750 | 350 | ✓ |
| `lab_body_fluids` | Lab & Pathology | Body Fluids Analysis | — | — | ✗ |
| `lab_bone_marrow` | Lab & Pathology | Bone Marrow Aspirate Review | 11500 | 2300 | ✓ |
| `lab_panel_coag_electrolytes` | Lab & Pathology | Coagulation & Electrolytes Review | 1250 | 250 | ✓ |
| `lab_cytology` | Lab & Pathology | Cytology | 1250 | 250 | ✓ |
| `lab_fna` | Lab & Pathology | Fine Needle Aspiration (FNA) | — | — | ✗ |
| `lab_genetic_molecular` | Lab & Pathology | Genetic/Molecular Testing | — | — | ✗ |
| `lab_histo_large` | Lab & Pathology | Histopathology - Large Biopsy | 2990 | 598 | ✓ |
| `lab_histo_organ` | Lab & Pathology | Histopathology - Organ/Resection | 4255 | 851 | ✓ |
| `lab_histo_small` | Lab & Pathology | Histopathology - Small Biopsy | 1668 | 334 | ✓ |
| `lab_panel_hormones` | Lab & Pathology | Hormone Panel Review | 1750 | 350 | ✓ |
| `lab_micro_sputum_cs` | Lab & Pathology | Microbiology - Sputum C&S | 6900 | 1380 | ✓ |
| `lab_panel_microbiology` | Lab & Pathology | Microbiology Cultures Review | 1500 | 300 | ✓ |
| `lab_pap_smear` | Lab & Pathology | Pap Smear | — | — | ✗ |
| `lab_panel_routine_bloods` | Lab & Pathology | Routine Bloods Panel Review | 1500 | 300 | ✓ |
| `lab_sensitivity` | Lab & Pathology | Sensitivity Testing | — | — | ✗ |
| `lab_panel_tumor_markers` | Lab & Pathology | Tumor Markers Panel Review | 1750 | 350 | ✓ |
| `lab_panel_urine_stool` | Lab & Pathology | Urine & Stool Workup Review | 1250 | 250 | ✓ |
| `card_ecg_12lead` | Cardiology | 12-Lead ECG Interpretation | 1250 | 250 | ✓ |
| `card_calcium_score` | Cardiology | Calcium Score Review | 3680 | 736 | ✓ |
| `card_cmr` | Cardiology | Cardiac MR Review | 8395 | 1679 | ✓ |
| `card_ctca` | Cardiology | CT Coronary Angiography Review | 7935 | 1587 | ✓ |
| `card_holter_24_72` | Cardiology | Holter Monitor (24-72h) Review | 3450 | 690 | ✓ |
| `card_preop_clearance` | Cardiology | Pre-Op Cardiac Clearance | — | — | ✗ |
| `card_rhythm_strip` | Cardiology | Rhythm Strip Analysis | 1250 | 250 | ✓ |
| `card_stress_echo` | Cardiology | Stress Echo Review | 2070 | 414 | ✓ |
| `card_stress_treadmill` | Cardiology | Stress Treadmill Test Review | 1553 | 311 | ✓ |
| `f2c6ad36-af16-417d-8b17-f66afbd7f750` | Dermatology | Autoimmune Skin Panel Review | 5980 | 1196 | ✓ |
| `0ad67dc7-55f4-405a-938b-433e283b82ee` | Dermatology | Chronic Wound Review | 2990 | 598 | ✓ |
| `30641b01-db6b-46bc-bee0-d3037873c2be` | Dermatology | Clinical Photo Review | 2645 | 529 | ✓ |
| `783ad9ec-a01c-4c12-8cad-b466a838390a` | Dermatology | Dermoscopy Review | 3680 | 736 | ✓ |
| `911127b5-34e2-47b5-853a-6975f4a54b0f` | Dermatology | Hair Loss Workup Review | 2990 | 598 | ✓ |
| `2da99181-dfc6-4e55-be0b-fb9ea28b09c4` | Dermatology | Psoriasis Management Review | 2990 | 598 | ✓ |
| `f3d1a7f1-a6cc-4a0d-ab8f-678caa10474d` | Dermatology | Skin Biopsy Report Review | 5980 | 1196 | ✓ |
| `014b800d-7431-4cf6-9e87-37599be29399` | Endocrinology | Adrenal Workup Review | 5175 | 1035 | ✓ |
| `08766418-29d9-4012-ac42-6a5fdb623bae` | Endocrinology | Full Thyroid Panel Review | 1725 | 345 | ✓ |
| `1d115a28-abe4-4e0d-aa0b-3735338f1453` | Endocrinology | Growth Hormone Panel Review | 5175 | 1035 | ✓ |
| `bb1a3406-2007-44ac-a165-e10256cd2b76` | Endocrinology | Lipid Disorder Management | 1725 | 345 | ✓ |
| `357a9ed9-0dc3-47b6-b53c-db05b50ab7e6` | Endocrinology | Obesity/Metabolic Review | 2990 | 598 | ✓ |
| `2fca13ac-08b1-4118-83c6-2dca3d950563` | Endocrinology | Osteoporosis Workup Review | 2645 | 529 | ✓ |
| `5ab109b3-4637-448c-8e6d-1f3821a58e3a` | Endocrinology | PCOS Panel Review | 2990 | 598 | ✓ |
| `9ffc180c-bed2-4305-b71c-2303c12f30b6` | Gastroenterology | FibroScan/Elastography Review | 3680 | 736 | ✓ |
| `4f3ff7a9-bbf4-41ac-bbf9-e731f62bbad7` | Gastroenterology | Hepatitis B/C Panel Review | 3105 | 621 | ✓ |
| `6193b569-cfe7-40d9-a2a7-ce7b02189395` | Gastroenterology | IBD Investigation Review | 5980 | 1196 | ✓ |
| `d8e374d9-0ae0-4c1a-9299-a508752fdf7b` | Gastroenterology | Liver Biopsy Report Review | 10465 | 2093 | ✓ |
| `3576c5fe-59a7-4370-ad05-f34e40d8a1e8` | Gastroenterology | Liver MRI Review | 8970 | 1794 | ✓ |
| `891c261f-6c63-4341-8644-a75af15c7a59` | Gastroenterology | Liver Ultrasound Review | 2185 | 437 | ✓ |
| `08681b8c-8fe5-44d2-90b4-956974dbbc29` | Hematology | Anemia Workup Review | 3680 | 736 | ✓ |
| `b992e0c0-1f0c-4747-b122-d9c5bd2d04a1` | Hematology | Coagulation Panel Review | 2990 | 598 | ✓ |
| `77f4db68-466d-4874-ba04-88d3dccfad6b` | Hematology | Full CBC with Differential Review | 1725 | 345 | ✓ |
| `fb41d6e4-1221-4b79-9b7d-b1dd512b93a3` | Hematology | Immunoglobulins/SPEP Review | 7475 | 1495 | ✓ |
| `d05d3fa7-81d5-4cbc-b5ec-cd96187f14c7` | Hematology | Sickle Cell/Thalassemia Review | 3680 | 736 | ✓ |
| `75ae2cee-6b8a-4cea-8240-89a821a47938` | Hematology | Thrombophilia Panel Review | 7475 | 1495 | ✓ |
| `bef26bde-7f2c-4ed9-ac08-6d4ef3075e03` | Nephrology | CKD Staging & Management Review | 3680 | 736 | ✓ |
| `6d7409bb-18a2-4659-a119-e7102ea3c2b0` | Nephrology | Dialysis Adequacy Review | 5980 | 1196 | ✓ |
| `442081e7-0abb-490e-9df1-0ef7f0bd0397` | Nephrology | Hypertension Workup Review | 3680 | 736 | ✓ |
| `5318c5cf-9097-47a9-b1a7-a40c1ba68406` | Nephrology | Kidney Biopsy Report Review | 10465 | 2093 | ✓ |
| `cd428c90-e144-48a6-ae2d-e7321c47eb62` | Nephrology | Kidney Function Panel Review | 1725 | 345 | ✓ |
| `90445995-81a2-4dfa-9c33-5b39cb6779ad` | Nephrology | Kidney Stone CT Review | 4140 | 828 | ✓ |
| `3896c375-5e86-4b83-b978-6dcd4257bd23` | Nephrology | Kidney Ultrasound Review | 2185 | 437 | ✓ |
| `22028c6f-2f3a-427f-bc37-e65e3e518836` | Nephrology | Proteinuria Workup Review | 3680 | 736 | ✓ |
| `neuro_brain_ct` | Neurology | Brain CT Review | 1553 | 311 | ✓ |
| `neuro_eeg` | Neurology | EEG Interpretation | 13225 | 2645 | ✓ |
| `neuro_emg_ncs` | Neurology | EMG/NCS Review | 6900 | 1380 | ✓ |
| `neuro_epilepsy_imaging` | Neurology | Epilepsy Imaging Review | — | — | ✗ |
| `neuro_cta` | Neurology | Neuro CTA Review | 9085 | 1817 | ✓ |
| `neuro_mra` | Neurology | Neuro MRA Review | 6210 | 1242 | ✓ |
| `neuro_spine_mri` | Neurology | Neuro Spine MRI Review | 9315 | 1863 | ✓ |
| `neuro_neurovascular` | Neurology | Neurovascular Review | — | — | ✗ |
| `neuro_perfusion` | Neurology | Perfusion Imaging Review | — | — | ✗ |
| `neuro_stroke_imaging` | Neurology | Stroke Imaging Review | — | — | ✗ |
| `226a46c3-c09a-4bb4-9020-1aca84286456` | OB/GYN | Fertility Panel Review | 2990 | 598 | ✓ |
| `c3b25b89-abcb-4351-b784-29fda57e3303` | OB/GYN | Fetal Echocardiography Review | 5980 | 1196 | ✓ |
| `381228d3-9967-45aa-b37b-f5d52833a42e` | OB/GYN | Fibroid Management Review | 3680 | 736 | ✓ |
| `c8e6b8e3-eb44-4039-94f7-29d3fe510db2` | OB/GYN | Gynaecological Ultrasound Review | 2185 | 437 | ✓ |
| `8dc26268-ce9f-4abc-b3ee-81e8bfa1bcf7` | OB/GYN | HSG Report Review | 2990 | 598 | ✓ |
| `86311863-9230-4181-a93a-1c8ad9c3d4b8` | OB/GYN | MRI Pelvis Review | 7935 | 1587 | ✓ |
| `751a96a3-4491-481e-b15f-85ecce841ab0` | OB/GYN | Obstetric Ultrasound Review | 2185 | 437 | ✓ |
| `914f690d-e65c-4374-aa77-c6cb5d020ebd` | OB/GYN | Pap Smear Report Review | 1380 | 276 | ✓ |
| `804d2c86-e917-4003-bf85-78ae90e4fc46` | OB/GYN | Prenatal Labs Review | 1725 | 345 | ✓ |
| `onc_ct_mri_staging` | Oncology | CT/MRI Staging Review | 17480 | 3496 | ✓ |
| `onc_cytology_reports` | Oncology | Cytology Report Review | — | — | ✗ |
| `onc_heme_onc_blood` | Oncology | Hemato-Oncology Blood Review | — | — | ✗ |
| `onc_histo_reports` | Oncology | Histopathology Report Review | — | — | ✗ |
| `onc_petct_imaging` | Oncology | PET-CT Imaging Review | — | — | ✗ |
| `onc_recist_response` | Oncology | RECIST Response Assessment | — | — | ✗ |
| `onc_rt_planning_scan` | Oncology | RT Planning Scan Review | — | — | ✗ |
| `onc_tumor_markers` | Oncology | Tumor Markers Review | — | — | ✗ |
| `0c4257f2-ce6f-4d6e-bcdf-43d5870c7483` | Ophthalmology | Glaucoma Workup Review | 5175 | 1035 | ✓ |
| `31caa261-6e99-490e-92b4-f41c063c0df6` | Ophthalmology | MRI Orbit Review | 7475 | 1495 | ✓ |
| `c479cb12-65f7-476f-891d-54b92e408437` | Ophthalmology | OCT Scan Review | 3680 | 736 | ✓ |
| `89022187-e714-4558-b460-8eb8576cb5a7` | Ophthalmology | Pre-Op Surgical Opinion | 5980 | 1196 | ✓ |
| `b41eac6d-47d4-482f-888d-97ffb3070490` | Ophthalmology | Retinal Imaging Review | 5175 | 1035 | ✓ |
| `f7212d50-4ec9-4f75-93c4-38bb2953753f` | Orthopedics | Bone Density (DEXA) Review | 1725 | 345 | ✓ |
| `bd9ae0ea-4516-4b0b-bedd-524847c20005` | Orthopedics | CT Scan Review | 4140 | 828 | ✓ |
| `6f068411-f7fb-461c-8725-5081543f80da` | Orthopedics | Hip MRI Review | 4715 | 943 | ✓ |
| `20782c32-9943-4867-abc0-c35d25b925ad` | Orthopedics | Knee MRI Review | 4715 | 943 | ✓ |
| `c48b7386-0877-4cb0-9725-4cafc809b895` | Orthopedics | Orthopedic MRI Review | 5175 | 1035 | ✓ |
| `e52f1bf2-11aa-4941-8100-387ecff881f2` | Orthopedics | Post-Operative Review | 4485 | 897 | ✓ |
| `95e10e76-4c56-401e-a5ce-b2f75d34fdea` | Orthopedics | Pre-Operative Opinion | 6555 | 1311 | ✓ |
| `eb2c20d7-f956-4b0f-a638-aafdd3d1e888` | Orthopedics | Shoulder MRI Review | 4715 | 943 | ✓ |
| `fcf976a7-d58d-49e3-b072-d2fcdc16d7ad` | Orthopedics | Spine Imaging Review | 5175 | 1035 | ✓ |
| `8df6ec54-9a42-4377-89af-7ffec238018a` | Orthopedics | X-Ray Review | 1380 | 276 | ✓ |
| `570a903f-8e16-4a15-bcb2-f92740e27ffa` | Pulmonology | CT Chest Review | 5175 | 1035 | ✓ |
| `7d2407d6-a297-4fea-aed7-da4babb6c3ed` | Pulmonology | HRCT Chest Review | 7475 | 1495 | ✓ |
| `5d81155f-35ff-422e-807c-37a5cc7a9b5e` | Pulmonology | Post-COVID Lung Review | 3680 | 736 | ✓ |
| `7de25d3f-363b-4db7-8853-2a6d90800401` | Pulmonology | Sleep Study (PSG) Review | 7475 | 1495 | ✓ |
| `64843aa5-6703-444a-9f5d-53e1e1342df4` | Pulmonology | TB Workup Review | 3680 | 736 | ✓ |
| `92e584e4-1c16-4334-922a-5886672c9b6c` | Pulmonology | V/Q Scan Review | 6555 | 1311 | ✓ |
| `rad_abd_pelvis_ct_mri` | Radiology | Abdomen/Pelvis CT/MRI Review | 8050 | 1610 | ✓ |
| `rad_cardiac_ct` | Radiology | Cardiac CT Review | 7935 | 1587 | ✓ |
| `rad_cardiac_mri` | Radiology | Cardiac MRI Review | 8395 | 1679 | ✓ |
| `rad_cxr_review` | Radiology | Chest X-Ray Review | 1250 | 250 | ✓ |
| `rad_ct_mr_angio` | Radiology | CT/MR Angiography Review | 17480 | 3496 | ✓ |
| `rad_msk_imaging` | Radiology | Musculoskeletal Imaging Review | 1840 | 368 | ✓ |
| `rad_neuro_imaging` | Radiology | Neuro Imaging Review | 5233 | 1047 | ✓ |
| `rad_onc_petct_staging` | Radiology | Oncology PET-CT Staging | — | — | ✗ |
| `rad_spine_mri` | Radiology | Spine MRI Review | 9315 | 1863 | ✓ |
| `362481e4-1b61-4f37-9ee3-5c4109816a01` | Urology | Bladder Ultrasound Review | 2185 | 437 | ✓ |
| `efe933ea-e15e-4336-9e22-f1f487ea0762` | Urology | Kidney/Ureter CT Review | 4140 | 828 | ✓ |
| `35242a11-0fad-4d0b-a6a9-be19d7b511fb` | Urology | MRI Prostate Review | 7475 | 1495 | ✓ |
| `96e8adde-dc99-4e60-a1ed-d1ea3cd18c8e` | Urology | Prostate Workup Review | 3680 | 736 | ✓ |
| `43ab445f-68a3-46d1-9af5-0024fce4d0bb` | Urology | PSA & Prostate Panel Review | 2185 | 437 | ✓ |
| `edb1d583-6dab-49af-af75-abea9bfdc571` | Urology | Renal Stone Management Review | 3680 | 736 | ✓ |
| `ca8cc7e9-80b3-450c-a1b8-793aa1eff45a` | Urology | Scrotal Ultrasound Review | 2645 | 529 | ✓ |
| `784adb02-0189-41aa-8f89-724b2de39568` | Urology | Urodynamics Study Review | 6555 | 1311 | ✓ |

### Price-mismatch (matched rows where DB base_price ≠ sheet tashkheesa_price)

Total mismatches: **26**

| Service ID | Specialty | Name | DB base_price | Sheet price | DB doctor_fee | Sheet doctor_fee | DB visible |
|---|---|---|---:|---:|---:|---:|:-:|
| `rad_ct_review` | Radiology | CT Scan Review | 9085 | 1500 | 1817 | 300 | ✓ |
| `rad_mri_review` | Radiology | MRI Review | 8395 | 1035 | 1679 | 207 | ✓ |
| `rad_us_review` | Radiology | Ultrasound Review | 1725 | 1500 | 345 | 300 | ✓ |
| `card_echo` | Cardiology | Echocardiogram Review | 1380 | 1500 | 276 | 300 | ✓ |
| `neuro_brain_mri` | Neurology | Brain MRI Review | 3680 | 1150 | 736 | 230 | ✓ |
| `onc_bone_marrow_biopsy` | Oncology | Bone Marrow Biopsy Review | 11500 | 1495 | 2300 | 299 | ✓ |
| `68d477c3-2414-4307-8bdb-ce732604338d` | Hematology | Bone Marrow Biopsy Review | 14950 | 1495 | 2990 | 299 | ✓ |
| `cc7f3467-17b2-4f75-96b7-ce56dd1cbc39` | Hematology | Flow Cytometry Review | 13455 | 920 | 2691 | 184 | ✓ |
| `aeea6eee-2a3a-4833-af8c-6ced381f76ea` | Hematology | Lymphoma Staging Review | 13455 | 1150 | 2691 | 230 | ✓ |
| `57749223-ea3b-43d6-9561-8641d4d4297d` | Orthopedics | Fracture Management Review | 3680 | 805 | 736 | 161 | ✓ |
| `c1e9624a-78c2-4c8c-b6ca-7b3694719eb8` | Gastroenterology | Endoscopy Report Review | 4485 | 920 | 897 | 184 | ✓ |
| `0e6c534d-dfab-4c2b-a950-0eda846a1cdb` | Gastroenterology | Colonoscopy Report Review | 4485 | 920 | 897 | 184 | ✓ |
| `7fa58485-fe05-49ef-85c7-607abc91c123` | Gastroenterology | MRCP Review | 9545 | 1035 | 1909 | 207 | ✓ |
| `ccc8556d-089a-4b61-b21c-7fc3bc9cda62` | Gastroenterology | Capsule Endoscopy Review | 10465 | 1150 | 2093 | 230 | ✓ |
| `a9ac1b8e-e8fc-43e4-8783-de53536f6cc7` | Endocrinology | Thyroid Ultrasound Review | 2185 | 575 | 437 | 115 | ✓ |
| `f2333602-2a06-4a5c-898a-a403a2243008` | Endocrinology | Diabetes Management Review | 2990 | 575 | 598 | 115 | ✓ |
| `89ff1ef4-c4fd-441f-9aa9-8e92aa846436` | Endocrinology | Pituitary MRI Review | 5175 | 1035 | 1035 | 207 | ✓ |
| `767d653b-0945-4ba6-b42e-44614b68fc85` | Pulmonology | Chest X-Ray Review | 920 | 402 | 184 | 80 | ✓ |
| `8142527a-dfc3-47a1-876c-606d86a6e6da` | Pulmonology | Pulmonary Function Test Review | 3680 | 575 | 736 | 115 | ✓ |
| `055b0b59-cb66-4312-9a25-dd69f6a37318` | Pulmonology | Bronchoscopy Report Review | 6555 | 920 | 1311 | 184 | ✓ |
| `18b1e5a5-3218-49a0-8ac5-fc545746d921` | Urology | Cystoscopy Report Review | 5980 | 920 | 1196 | 184 | ✓ |
| `ac1f3447-9cb2-4c2a-ba8f-b5d2560f9d69` | Dermatology | Patch Test Review | 2990 | 402 | 598 | 80 | ✓ |
| `53b8103b-a3b3-4f80-8c37-274e15758e97` | Ophthalmology | Visual Field Test Review | 2645 | 575 | 529 | 115 | ✓ |
| `8e52adb3-70ba-4f85-b31d-5c2c5d33c95f` | Ophthalmology | Fluorescein Angiography Review | 6555 | 920 | 1311 | 184 | ✓ |
| `ce27136e-8334-487d-b0be-9394fa3a5c04` | Ophthalmology | Fundus Photography Review | 2990 | 690 | 598 | 138 | ✓ |
| `7d87d268-800b-403e-bd4f-d5d6a6a60fa7` | Ophthalmology | Diabetic Retinopathy Review | 3680 | 805 | 736 | 161 | ✓ |

---

## Specialties with zero services

- `spec-anesthesiology` — Anesthesiology (visible: true)
- `spec-cardiothoracic` — Cardiothoracic Surgery (visible: true)
- `spec-clinical-nutrition` — Clinical Nutrition (visible: true)
- `spec-emergency-medicine` — Emergency Medicine (visible: true)
- `spec-pathology` — Pathology (visible: true)
- `spec-psychiatry` — Psychiatry (visible: true)
- `spec-rheumatology` — Rheumatology (visible: true)
- `spec-vascular-surgery` — Vascular Surgery (visible: true)
- `addon` — Add-on Services (visible: false)
- `spec-ent` — ENT (visible: false)
- `spec-general-surgery` — General Surgery (visible: false)
- `spec-internal-medicine` — Internal Medicine (visible: false)
- `spec-pediatrics` — Pediatrics (visible: false)
