# Pricing drift — `services.base_price` vs `service_regional_prices` (EG active)

**Generated:** 2026-05-16
**Mode:** READ-ONLY — no schema or data changes performed
**Scope:** all visible services + their Egypt active regional row (or NULL if none)

## Summary

| Bucket | Count |
|---|---:|
| Total visible services | **143** |
| With regional Egypt row (active) | **38** |
| No regional row → canonical wins by default | **105** |
| Regional == canonical (no drift) | **34** |
| Regional < canonical (regional is a discount) | **4** |
| Regional > canonical (regional is a markup) | **0** |

**Aggregate impact** (sum of absolute deltas):
- Total discount across all drifted-down services: **EGP 2,182**
- Total markup across all drifted-up services:    **EGP 0**

## Top 10 largest absolute deltas

| Service ID | Service Name | Specialty | Canonical | Regional EG | Δ EGP | Δ % |
|---|---|---|---:|---:|---:|---:|
| `card_ecg_12lead` | 12-Lead ECG Interpretation | Cardiology | 1,250 | 575 | -675 | -54.0% |
| `card_rhythm_strip` | Rhythm Strip Analysis | Cardiology | 1,250 | 575 | -675 | -54.0% |
| `rad_cxr_review` | Chest X-Ray Review | Radiology | 1,250 | 633 | -617 | -49.4% |
| `lab_cytology` | Cytology | Lab & Pathology | 1,250 | 1,035 | -215 | -17.2% |

## Discount-bucket pattern (regional < canonical, 4 services)

- Discount range: -54.0% to -17.2%
- Mean discount: -43.6%
- Spread: 36.8pp (tight clustering = systematic; wide = ad-hoc edits)

## Full diff table (all visible services)

| Service ID | Specialty | Canonical (`services.base_price`) | Regional EG | Δ EGP | Δ % | Bucket |
|---|---|---:|---:|---:|---:|---|
| `lab_autoimmune_anca` | lab_pathology | 2,530 | 2,530 | +0 | +0.0% | equal |
| `lab_autoimmune_anti_dna` | lab_pathology | 1,495 | 1,495 | +0 | +0.0% | equal |
| `lab_autoimmune_asma` | lab_pathology | 1,495 | 1,495 | +0 | +0.0% | equal |
| `lab_panel_autoimmune` | lab_pathology | 1,750 | — | — | — | no-regional |
| `lab_bone_marrow` | lab_pathology | 11,500 | 11,500 | +0 | +0.0% | equal |
| `lab_panel_coag_electrolytes` | lab_pathology | 1,250 | — | — | — | no-regional |
| `lab_cytology` | lab_pathology | 1,250 | 1,035 | -215 | -17.2% | discount |
| `lab_histo_large` | lab_pathology | 2,990 | 2,990 | +0 | +0.0% | equal |
| `lab_histo_organ` | lab_pathology | 4,255 | 4,255 | +0 | +0.0% | equal |
| `lab_histo_small` | lab_pathology | 1,668 | 1,668 | +0 | +0.0% | equal |
| `lab_panel_hormones` | lab_pathology | 1,750 | — | — | — | no-regional |
| `lab_micro_sputum_cs` | lab_pathology | 6,900 | 6,900 | +0 | +0.0% | equal |
| `lab_panel_microbiology` | lab_pathology | 1,500 | — | — | — | no-regional |
| `lab_panel_routine_bloods` | lab_pathology | 1,500 | — | — | — | no-regional |
| `lab_panel_tumor_markers` | lab_pathology | 1,750 | — | — | — | no-regional |
| `lab_panel_urine_stool` | lab_pathology | 1,250 | — | — | — | no-regional |
| `card_ecg_12lead` | spec-cardiology | 1,250 | 575 | -675 | -54.0% | discount |
| `card_calcium_score` | spec-cardiology | 3,680 | 3,680 | +0 | +0.0% | equal |
| `card_cmr` | spec-cardiology | 8,395 | 8,395 | +0 | +0.0% | equal |
| `card_ctca` | spec-cardiology | 7,935 | 7,935 | +0 | +0.0% | equal |
| `card_echo` | spec-cardiology | 1,380 | 1,380 | +0 | +0.0% | equal |
| `card_holter_24_72` | spec-cardiology | 3,450 | 3,450 | +0 | +0.0% | equal |
| `card_rhythm_strip` | spec-cardiology | 1,250 | 575 | -675 | -54.0% | discount |
| `card_stress_echo` | spec-cardiology | 2,070 | 2,070 | +0 | +0.0% | equal |
| `card_stress_treadmill` | spec-cardiology | 1,553 | 1,553 | +0 | +0.0% | equal |
| `svc-cardiothoracic-consultation` | spec-cardiothoracic | 2,500 | — | — | — | no-regional |
| `svc-clinical-nutrition-consultation` | spec-clinical-nutrition | 1,250 | — | — | — | no-regional |
| `f2c6ad36-af16-417d-8b17-f66afbd7f750` | spec-dermatology | 5,980 | — | — | — | no-regional |
| `0ad67dc7-55f4-405a-938b-433e283b82ee` | spec-dermatology | 2,990 | — | — | — | no-regional |
| `30641b01-db6b-46bc-bee0-d3037873c2be` | spec-dermatology | 2,645 | — | — | — | no-regional |
| `783ad9ec-a01c-4c12-8cad-b466a838390a` | spec-dermatology | 3,680 | — | — | — | no-regional |
| `911127b5-34e2-47b5-853a-6975f4a54b0f` | spec-dermatology | 2,990 | — | — | — | no-regional |
| `ac1f3447-9cb2-4c2a-ba8f-b5d2560f9d69` | spec-dermatology | 2,990 | — | — | — | no-regional |
| `2da99181-dfc6-4e55-be0b-fb9ea28b09c4` | spec-dermatology | 2,990 | — | — | — | no-regional |
| `f3d1a7f1-a6cc-4a0d-ab8f-678caa10474d` | spec-dermatology | 5,980 | — | — | — | no-regional |
| `svc-emergency-medicine-consultation` | spec-emergency-medicine | 1,500 | — | — | — | no-regional |
| `014b800d-7431-4cf6-9e87-37599be29399` | spec-endocrinology | 5,175 | — | — | — | no-regional |
| `f2333602-2a06-4a5c-898a-a403a2243008` | spec-endocrinology | 2,990 | — | — | — | no-regional |
| `08766418-29d9-4012-ac42-6a5fdb623bae` | spec-endocrinology | 1,725 | — | — | — | no-regional |
| `1d115a28-abe4-4e0d-aa0b-3735338f1453` | spec-endocrinology | 5,175 | — | — | — | no-regional |
| `bb1a3406-2007-44ac-a165-e10256cd2b76` | spec-endocrinology | 1,725 | — | — | — | no-regional |
| `357a9ed9-0dc3-47b6-b53c-db05b50ab7e6` | spec-endocrinology | 2,990 | — | — | — | no-regional |
| `2fca13ac-08b1-4118-83c6-2dca3d950563` | spec-endocrinology | 2,645 | — | — | — | no-regional |
| `5ab109b3-4637-448c-8e6d-1f3821a58e3a` | spec-endocrinology | 2,990 | — | — | — | no-regional |
| `89ff1ef4-c4fd-441f-9aa9-8e92aa846436` | spec-endocrinology | 5,175 | — | — | — | no-regional |
| `a9ac1b8e-e8fc-43e4-8783-de53536f6cc7` | spec-endocrinology | 2,185 | — | — | — | no-regional |
| `ccc8556d-089a-4b61-b21c-7fc3bc9cda62` | spec-gastroenterology | 10,465 | — | — | — | no-regional |
| `0e6c534d-dfab-4c2b-a950-0eda846a1cdb` | spec-gastroenterology | 4,485 | — | — | — | no-regional |
| `c1e9624a-78c2-4c8c-b6ca-7b3694719eb8` | spec-gastroenterology | 4,485 | — | — | — | no-regional |
| `9ffc180c-bed2-4305-b71c-2303c12f30b6` | spec-gastroenterology | 3,680 | — | — | — | no-regional |
| `4f3ff7a9-bbf4-41ac-bbf9-e731f62bbad7` | spec-gastroenterology | 3,105 | — | — | — | no-regional |
| `6193b569-cfe7-40d9-a2a7-ce7b02189395` | spec-gastroenterology | 5,980 | — | — | — | no-regional |
| `d8e374d9-0ae0-4c1a-9299-a508752fdf7b` | spec-gastroenterology | 10,465 | — | — | — | no-regional |
| `3576c5fe-59a7-4370-ad05-f34e40d8a1e8` | spec-gastroenterology | 8,970 | — | — | — | no-regional |
| `891c261f-6c63-4341-8644-a75af15c7a59` | spec-gastroenterology | 2,185 | — | — | — | no-regional |
| `7fa58485-fe05-49ef-85c7-607abc91c123` | spec-gastroenterology | 9,545 | — | — | — | no-regional |
| `08681b8c-8fe5-44d2-90b4-956974dbbc29` | spec-hematology | 3,680 | — | — | — | no-regional |
| `68d477c3-2414-4307-8bdb-ce732604338d` | spec-hematology | 14,950 | — | — | — | no-regional |
| `b992e0c0-1f0c-4747-b122-d9c5bd2d04a1` | spec-hematology | 2,990 | — | — | — | no-regional |
| `cc7f3467-17b2-4f75-96b7-ce56dd1cbc39` | spec-hematology | 13,455 | — | — | — | no-regional |
| `77f4db68-466d-4874-ba04-88d3dccfad6b` | spec-hematology | 1,725 | — | — | — | no-regional |
| `fb41d6e4-1221-4b79-9b7d-b1dd512b93a3` | spec-hematology | 7,475 | — | — | — | no-regional |
| `aeea6eee-2a3a-4833-af8c-6ced381f76ea` | spec-hematology | 13,455 | — | — | — | no-regional |
| `d05d3fa7-81d5-4cbc-b5ec-cd96187f14c7` | spec-hematology | 3,680 | — | — | — | no-regional |
| `75ae2cee-6b8a-4cea-8240-89a821a47938` | spec-hematology | 7,475 | — | — | — | no-regional |
| `bef26bde-7f2c-4ed9-ac08-6d4ef3075e03` | spec-nephrology | 3,680 | — | — | — | no-regional |
| `6d7409bb-18a2-4659-a119-e7102ea3c2b0` | spec-nephrology | 5,980 | — | — | — | no-regional |
| `442081e7-0abb-490e-9df1-0ef7f0bd0397` | spec-nephrology | 3,680 | — | — | — | no-regional |
| `5318c5cf-9097-47a9-b1a7-a40c1ba68406` | spec-nephrology | 10,465 | — | — | — | no-regional |
| `cd428c90-e144-48a6-ae2d-e7321c47eb62` | spec-nephrology | 1,725 | — | — | — | no-regional |
| `90445995-81a2-4dfa-9c33-5b39cb6779ad` | spec-nephrology | 4,140 | — | — | — | no-regional |
| `3896c375-5e86-4b83-b978-6dcd4257bd23` | spec-nephrology | 2,185 | — | — | — | no-regional |
| `22028c6f-2f3a-427f-bc37-e65e3e518836` | spec-nephrology | 3,680 | — | — | — | no-regional |
| `neuro_brain_ct` | spec-neurology | 1,553 | 1,553 | +0 | +0.0% | equal |
| `neuro_brain_mri` | spec-neurology | 3,680 | 3,680 | +0 | +0.0% | equal |
| `neuro_eeg` | spec-neurology | 13,225 | 13,225 | +0 | +0.0% | equal |
| `neuro_emg_ncs` | spec-neurology | 6,900 | 6,900 | +0 | +0.0% | equal |
| `neuro_cta` | spec-neurology | 9,085 | 9,085 | +0 | +0.0% | equal |
| `neuro_mra` | spec-neurology | 6,210 | 6,210 | +0 | +0.0% | equal |
| `neuro_spine_mri` | spec-neurology | 9,315 | 9,315 | +0 | +0.0% | equal |
| `226a46c3-c09a-4bb4-9020-1aca84286456` | spec-obgyn | 2,990 | — | — | — | no-regional |
| `c3b25b89-abcb-4351-b784-29fda57e3303` | spec-obgyn | 5,980 | — | — | — | no-regional |
| `381228d3-9967-45aa-b37b-f5d52833a42e` | spec-obgyn | 3,680 | — | — | — | no-regional |
| `c8e6b8e3-eb44-4039-94f7-29d3fe510db2` | spec-obgyn | 2,185 | — | — | — | no-regional |
| `8dc26268-ce9f-4abc-b3ee-81e8bfa1bcf7` | spec-obgyn | 2,990 | — | — | — | no-regional |
| `86311863-9230-4181-a93a-1c8ad9c3d4b8` | spec-obgyn | 7,935 | — | — | — | no-regional |
| `751a96a3-4491-481e-b15f-85ecce841ab0` | spec-obgyn | 2,185 | — | — | — | no-regional |
| `914f690d-e65c-4374-aa77-c6cb5d020ebd` | spec-obgyn | 1,380 | — | — | — | no-regional |
| `804d2c86-e917-4003-bf85-78ae90e4fc46` | spec-obgyn | 1,725 | — | — | — | no-regional |
| `onc_bone_marrow_biopsy` | spec-oncology | 11,500 | 11,500 | +0 | +0.0% | equal |
| `onc_ct_mri_staging` | spec-oncology | 17,480 | 17,480 | +0 | +0.0% | equal |
| `7d87d268-800b-403e-bd4f-d5d6a6a60fa7` | spec-ophthalmology | 3,680 | — | — | — | no-regional |
| `8e52adb3-70ba-4f85-b31d-5c2c5d33c95f` | spec-ophthalmology | 6,555 | — | — | — | no-regional |
| `ce27136e-8334-487d-b0be-9394fa3a5c04` | spec-ophthalmology | 2,990 | — | — | — | no-regional |
| `0c4257f2-ce6f-4d6e-bcdf-43d5870c7483` | spec-ophthalmology | 5,175 | — | — | — | no-regional |
| `31caa261-6e99-490e-92b4-f41c063c0df6` | spec-ophthalmology | 7,475 | — | — | — | no-regional |
| `c479cb12-65f7-476f-891d-54b92e408437` | spec-ophthalmology | 3,680 | — | — | — | no-regional |
| `89022187-e714-4558-b460-8eb8576cb5a7` | spec-ophthalmology | 5,980 | — | — | — | no-regional |
| `b41eac6d-47d4-482f-888d-97ffb3070490` | spec-ophthalmology | 5,175 | — | — | — | no-regional |
| `53b8103b-a3b3-4f80-8c37-274e15758e97` | spec-ophthalmology | 2,645 | — | — | — | no-regional |
| `f7212d50-4ec9-4f75-93c4-38bb2953753f` | spec-orthopedics | 1,725 | — | — | — | no-regional |
| `bd9ae0ea-4516-4b0b-bedd-524847c20005` | spec-orthopedics | 4,140 | — | — | — | no-regional |
| `57749223-ea3b-43d6-9561-8641d4d4297d` | spec-orthopedics | 3,680 | — | — | — | no-regional |
| `6f068411-f7fb-461c-8725-5081543f80da` | spec-orthopedics | 4,715 | — | — | — | no-regional |
| `20782c32-9943-4867-abc0-c35d25b925ad` | spec-orthopedics | 4,715 | — | — | — | no-regional |
| `c48b7386-0877-4cb0-9725-4cafc809b895` | spec-orthopedics | 5,175 | — | — | — | no-regional |
| `e52f1bf2-11aa-4941-8100-387ecff881f2` | spec-orthopedics | 4,485 | — | — | — | no-regional |
| `95e10e76-4c56-401e-a5ce-b2f75d34fdea` | spec-orthopedics | 6,555 | — | — | — | no-regional |
| `eb2c20d7-f956-4b0f-a638-aafdd3d1e888` | spec-orthopedics | 4,715 | — | — | — | no-regional |
| `fcf976a7-d58d-49e3-b072-d2fcdc16d7ad` | spec-orthopedics | 5,175 | — | — | — | no-regional |
| `8df6ec54-9a42-4377-89af-7ffec238018a` | spec-orthopedics | 1,380 | — | — | — | no-regional |
| `svc-psychiatry-consultation` | spec-psychiatry | 1,500 | — | — | — | no-regional |
| `055b0b59-cb66-4312-9a25-dd69f6a37318` | spec-pulmonology | 6,555 | — | — | — | no-regional |
| `767d653b-0945-4ba6-b42e-44614b68fc85` | spec-pulmonology | 920 | — | — | — | no-regional |
| `570a903f-8e16-4a15-bcb2-f92740e27ffa` | spec-pulmonology | 5,175 | — | — | — | no-regional |
| `7d2407d6-a297-4fea-aed7-da4babb6c3ed` | spec-pulmonology | 7,475 | — | — | — | no-regional |
| `5d81155f-35ff-422e-807c-37a5cc7a9b5e` | spec-pulmonology | 3,680 | — | — | — | no-regional |
| `8142527a-dfc3-47a1-876c-606d86a6e6da` | spec-pulmonology | 3,680 | — | — | — | no-regional |
| `7de25d3f-363b-4db7-8853-2a6d90800401` | spec-pulmonology | 7,475 | — | — | — | no-regional |
| `64843aa5-6703-444a-9f5d-53e1e1342df4` | spec-pulmonology | 3,680 | — | — | — | no-regional |
| `92e584e4-1c16-4334-922a-5886672c9b6c` | spec-pulmonology | 6,555 | — | — | — | no-regional |
| `rad_abd_pelvis_ct_mri` | spec-radiology | 8,050 | 8,050 | +0 | +0.0% | equal |
| `rad_cardiac_ct` | spec-radiology | 7,935 | 7,935 | +0 | +0.0% | equal |
| `rad_cardiac_mri` | spec-radiology | 8,395 | 8,395 | +0 | +0.0% | equal |
| `rad_cxr_review` | spec-radiology | 1,250 | 633 | -617 | -49.4% | discount |
| `rad_ct_review` | spec-radiology | 9,085 | 9,085 | +0 | +0.0% | equal |
| `rad_ct_mr_angio` | spec-radiology | 17,480 | 17,480 | +0 | +0.0% | equal |
| `rad_mri_review` | spec-radiology | 8,395 | 8,395 | +0 | +0.0% | equal |
| `rad_msk_imaging` | spec-radiology | 1,840 | 1,840 | +0 | +0.0% | equal |
| `rad_neuro_imaging` | spec-radiology | 5,233 | 5,233 | +0 | +0.0% | equal |
| `rad_spine_mri` | spec-radiology | 9,315 | 9,315 | +0 | +0.0% | equal |
| `rad_us_review` | spec-radiology | 1,725 | 1,725 | +0 | +0.0% | equal |
| `svc-rheumatology-consultation` | spec-rheumatology | 1,500 | — | — | — | no-regional |
| `362481e4-1b61-4f37-9ee3-5c4109816a01` | spec-urology | 2,185 | — | — | — | no-regional |
| `18b1e5a5-3218-49a0-8ac5-fc545746d921` | spec-urology | 5,980 | — | — | — | no-regional |
| `efe933ea-e15e-4336-9e22-f1f487ea0762` | spec-urology | 4,140 | — | — | — | no-regional |
| `35242a11-0fad-4d0b-a6a9-be19d7b511fb` | spec-urology | 7,475 | — | — | — | no-regional |
| `96e8adde-dc99-4e60-a1ed-d1ea3cd18c8e` | spec-urology | 3,680 | — | — | — | no-regional |
| `43ab445f-68a3-46d1-9af5-0024fce4d0bb` | spec-urology | 2,185 | — | — | — | no-regional |
| `edb1d583-6dab-49af-af75-abea9bfdc571` | spec-urology | 3,680 | — | — | — | no-regional |
| `ca8cc7e9-80b3-450c-a1b8-793aa1eff45a` | spec-urology | 2,645 | — | — | — | no-regional |
| `784adb02-0189-41aa-8f89-724b2de39568` | spec-urology | 6,555 | — | — | — | no-regional |
| `svc-vascular-surgery-consultation` | spec-vascular-surgery | 2,500 | — | — | — | no-regional |

## Recommendation

**Pattern is discount-or-missing:** drifted rows are all discounts, some services have no regional row (those fall back to canonical). Consistent with **partial Egypt-discount rollout** — some services priced, others pending. Recommend: triage the no-regional services (105 rows) and decide whether they should also receive Egypt-specific pricing.

---

## Methodology

Query: visible services LEFT JOINed with `service_regional_prices` filtered to `country_code = 'EG' AND status = 'active'`. Deltas computed as `regional - canonical`; negative = discount, positive = markup. Currency assumed EGP throughout — no FX adjustment.
