var fs = require('fs');
var path = require('path');
var { pool, queryOne, queryAll, execute, withTransaction } = require('./pg');
var { major: logMajor } = require('./logger');

// ---------------------------------------------------------------------------
// File-based migration runner
// Reads .sql files from src/migrations/ in filename order.
// Tracks completed migrations in schema_migrations table.
// All .sql files must be idempotent (IF NOT EXISTS / DO $$ blocks).
// ---------------------------------------------------------------------------
var MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  // Ensure the tracking table exists
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, filename TEXT UNIQUE NOT NULL, ran_at TIMESTAMP DEFAULT NOW())'
  );

  // Read all .sql files, sorted by filename
  var files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(function(f) { return f.endsWith('.sql'); })
    .sort();

  for (var i = 0; i < files.length; i++) {
    var filename = files[i];

    // Check if already ran
    var existing = await queryOne(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [filename]
    );
    if (existing) continue;

    // Read and execute the SQL file
    var sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    await pool.query(sql);

    // Record it
    await execute(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename]
    );
    logMajor('Migration: ' + filename);
  }

  // Data fixups (idempotent, run every boot)
  await runDataFixups();

  // Seed pricing data if table is empty
  await seedPricingData();
}

// ---------------------------------------------------------------------------
// Data fixups — idempotent statements that run every boot
// (not suitable for .sql files because they depend on conditional JS logic)
// ---------------------------------------------------------------------------
async function runDataFixups() {
  // Normalize order statuses to lowercase
  await pool.query("UPDATE orders SET status = LOWER(status) WHERE status IS NOT NULL AND status != LOWER(status)");

  // Hide unpriced specialties from patient-facing pages
  var unpricedSpecialties = [
    'spec-dermatology', 'spec-ent', 'spec-endocrinology', 'spec-gastroenterology',
    'spec-general-surgery', 'spec-internal-medicine', 'spec-ophthalmology',
    'spec-orthopedics', 'spec-pediatrics', 'spec-pulmonology', 'spec-urology'
  ];
  var ph = unpricedSpecialties.map(function(_, idx) { return '$' + (idx + 1); }).join(', ');
  await pool.query(
    'UPDATE specialties SET is_visible = false WHERE id IN (' + ph + ') AND is_visible != false',
    unpricedSpecialties
  );

  // Remove generic placeholder services
  await pool.query(
    "DELETE FROM services WHERE id IN ('dermatology-svc', 'gastroenterology-svc', 'orthopedics-svc')"
  );
}

// ---------------------------------------------------------------------------
// Pricing seed data (only runs if service_regional_prices is empty)
// ---------------------------------------------------------------------------
async function seedPricingData() {
  var existingCount = 0;
  try {
    var row = await queryOne('SELECT COUNT(*) as c FROM service_regional_prices');
    existingCount = row ? row.c : 0;
  } catch (_) {}
  if (existingCount > 0) return;

  logMajor('Seeding regional pricing data...');

  var specialties = [
    { id: 'radiology', name: 'Radiology' },
    { id: 'cardiology', name: 'Cardiology' },
    { id: 'oncology', name: 'Oncology' },
    { id: 'neurology', name: 'Neurology' },
    { id: 'lab_pathology', name: 'Lab & Pathology' },
    { id: 'orthopedics', name: 'Orthopedics' },
    { id: 'gastroenterology', name: 'Gastroenterology' },
    { id: 'endocrinology', name: 'Endocrinology' },
    { id: 'pulmonology', name: 'Pulmonology' },
    { id: 'nephrology', name: 'Nephrology' },
    { id: 'obgyn', name: 'Obstetrics & Gynecology' },
    { id: 'dermatology', name: 'Dermatology' },
    { id: 'ophthalmology', name: 'Ophthalmology' },
    { id: 'urology', name: 'Urology' },
    { id: 'hematology', name: 'Hematology' },
    { id: 'psychiatry', name: 'Psychiatry' }
  ];

  var services = [
    { id: 'rad_ct_review', specialty_id: 'radiology', name: 'CT Scan Review' },
    { id: 'rad_mri_review', specialty_id: 'radiology', name: 'MRI Review' },
    { id: 'rad_cxr_review', specialty_id: 'radiology', name: 'Chest X-Ray Review' },
    { id: 'rad_us_review', specialty_id: 'radiology', name: 'Ultrasound Review' },
    { id: 'rad_neuro_imaging', specialty_id: 'radiology', name: 'Neuro Imaging Review' },
    { id: 'rad_spine_mri', specialty_id: 'radiology', name: 'Spine MRI Review' },
    { id: 'rad_ct_mr_angio', specialty_id: 'radiology', name: 'CT/MR Angiography Review' },
    { id: 'rad_onc_petct_staging', specialty_id: 'radiology', name: 'Oncology PET-CT Staging' },
    { id: 'rad_abd_pelvis_ct_mri', specialty_id: 'radiology', name: 'Abdomen/Pelvis CT/MRI Review' },
    { id: 'rad_msk_imaging', specialty_id: 'radiology', name: 'Musculoskeletal Imaging Review' },
    { id: 'rad_cardiac_ct', specialty_id: 'radiology', name: 'Cardiac CT Review' },
    { id: 'rad_cardiac_mri', specialty_id: 'radiology', name: 'Cardiac MRI Review' },
    { id: 'card_ecg_12lead', specialty_id: 'cardiology', name: '12-Lead ECG Interpretation' },
    { id: 'card_rhythm_strip', specialty_id: 'cardiology', name: 'Rhythm Strip Analysis' },
    { id: 'card_echo', specialty_id: 'cardiology', name: 'Echocardiogram Review' },
    { id: 'card_stress_treadmill', specialty_id: 'cardiology', name: 'Stress Treadmill Test Review' },
    { id: 'card_stress_echo', specialty_id: 'cardiology', name: 'Stress Echo Review' },
    { id: 'card_holter_24_72', specialty_id: 'cardiology', name: 'Holter Monitor (24-72h) Review' },
    { id: 'card_event_monitor', specialty_id: 'cardiology', name: 'Event Monitor Review' },
    { id: 'card_ctca', specialty_id: 'cardiology', name: 'CT Coronary Angiography Review' },
    { id: 'card_calcium_score', specialty_id: 'cardiology', name: 'Calcium Score Review' },
    { id: 'card_cmr', specialty_id: 'cardiology', name: 'Cardiac MR Review' },
    { id: 'card_preop_clearance', specialty_id: 'cardiology', name: 'Pre-Op Cardiac Clearance' },
    { id: 'onc_petct_imaging', specialty_id: 'oncology', name: 'PET-CT Imaging Review' },
    { id: 'onc_ct_mri_staging', specialty_id: 'oncology', name: 'CT/MRI Staging Review' },
    { id: 'onc_histo_reports', specialty_id: 'oncology', name: 'Histopathology Report Review' },
    { id: 'onc_cytology_reports', specialty_id: 'oncology', name: 'Cytology Report Review' },
    { id: 'onc_heme_onc_blood', specialty_id: 'oncology', name: 'Hemato-Oncology Blood Review' },
    { id: 'onc_bone_marrow_biopsy', specialty_id: 'oncology', name: 'Bone Marrow Biopsy Review' },
    { id: 'onc_tumor_markers', specialty_id: 'oncology', name: 'Tumor Markers Review' },
    { id: 'onc_recist_response', specialty_id: 'oncology', name: 'RECIST Response Assessment' },
    { id: 'onc_rt_planning_scan', specialty_id: 'oncology', name: 'RT Planning Scan Review' },
    { id: 'neuro_brain_mri', specialty_id: 'neurology', name: 'Brain MRI Review' },
    { id: 'neuro_brain_ct', specialty_id: 'neurology', name: 'Brain CT Review' },
    { id: 'neuro_spine_mri', specialty_id: 'neurology', name: 'Neuro Spine MRI Review' },
    { id: 'neuro_eeg', specialty_id: 'neurology', name: 'EEG Interpretation' },
    { id: 'neuro_emg_ncs', specialty_id: 'neurology', name: 'EMG/NCS Review' },
    { id: 'neuro_cta', specialty_id: 'neurology', name: 'Neuro CTA Review' },
    { id: 'neuro_mra', specialty_id: 'neurology', name: 'Neuro MRA Review' },
    { id: 'neuro_neurovascular', specialty_id: 'neurology', name: 'Neurovascular Review' },
    { id: 'neuro_perfusion', specialty_id: 'neurology', name: 'Perfusion Imaging Review' },
    { id: 'neuro_epilepsy_imaging', specialty_id: 'neurology', name: 'Epilepsy Imaging Review' },
    { id: 'neuro_stroke_imaging', specialty_id: 'neurology', name: 'Stroke Imaging Review' },
    { id: 'lab_cbc', specialty_id: 'lab_pathology', name: 'Complete Blood Count (CBC)' },
    { id: 'lab_kidney_urea', specialty_id: 'lab_pathology', name: 'Kidney Function - Urea' },
    { id: 'lab_kidney_creat', specialty_id: 'lab_pathology', name: 'Kidney Function - Creatinine' },
    { id: 'lab_kidney_uric_acid', specialty_id: 'lab_pathology', name: 'Kidney Function - Uric Acid' },
    { id: 'lab_liver_ast', specialty_id: 'lab_pathology', name: 'Liver Function - AST' },
    { id: 'lab_liver_alt', specialty_id: 'lab_pathology', name: 'Liver Function - ALT' },
    { id: 'lab_liver_ggt', specialty_id: 'lab_pathology', name: 'Liver Function - GGT' },
    { id: 'lab_liver_alp', specialty_id: 'lab_pathology', name: 'Liver Function - ALP' },
    { id: 'lab_liver_albumin', specialty_id: 'lab_pathology', name: 'Liver Function - Albumin' },
    { id: 'lab_electrolytes_na', specialty_id: 'lab_pathology', name: 'Electrolytes - Sodium' },
    { id: 'lab_electrolytes_k', specialty_id: 'lab_pathology', name: 'Electrolytes - Potassium' },
    { id: 'lab_thyroid_panel', specialty_id: 'lab_pathology', name: 'Thyroid Panel' },
    { id: 'lab_lipid_profile', specialty_id: 'lab_pathology', name: 'Lipid Profile' },
    { id: 'lab_diabetes', specialty_id: 'lab_pathology', name: 'Diabetes Panel (HbA1c/FBS)' },
    { id: 'lab_autoimmune_ana', specialty_id: 'lab_pathology', name: 'Autoimmune - ANA' },
    { id: 'lab_autoimmune_anti_dna', specialty_id: 'lab_pathology', name: 'Autoimmune - Anti-DNA' },
    { id: 'lab_autoimmune_asma', specialty_id: 'lab_pathology', name: 'Autoimmune - ASMA' },
    { id: 'lab_autoimmune_anca', specialty_id: 'lab_pathology', name: 'Autoimmune - ANCA' },
    { id: 'lab_autoimmune_c3', specialty_id: 'lab_pathology', name: 'Autoimmune - Complement C3' },
    { id: 'lab_autoimmune_c4', specialty_id: 'lab_pathology', name: 'Autoimmune - Complement C4' },
    { id: 'lab_coag_pt', specialty_id: 'lab_pathology', name: 'Coagulation - PT/INR' },
    { id: 'lab_coag_ptt', specialty_id: 'lab_pathology', name: 'Coagulation - PTT' },
    { id: 'lab_tumor_cea', specialty_id: 'lab_pathology', name: 'Tumor Marker - CEA' },
    { id: 'lab_tumor_ca153', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 15-3' },
    { id: 'lab_tumor_ca199', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 19-9' },
    { id: 'lab_tumor_ca125', specialty_id: 'lab_pathology', name: 'Tumor Marker - CA 125' },
    { id: 'lab_tumor_psa', specialty_id: 'lab_pathology', name: 'Tumor Marker - PSA' },
    { id: 'lab_tumor_afp', specialty_id: 'lab_pathology', name: 'Tumor Marker - AFP' },
    { id: 'lab_hormone_dhea', specialty_id: 'lab_pathology', name: 'Hormone - DHEA-S' },
    { id: 'lab_hormone_e2', specialty_id: 'lab_pathology', name: 'Hormone - Estradiol (E2)' },
    { id: 'lab_hormone_testo', specialty_id: 'lab_pathology', name: 'Hormone - Testosterone' },
    { id: 'lab_hormone_lh', specialty_id: 'lab_pathology', name: 'Hormone - LH' },
    { id: 'lab_hormone_fsh', specialty_id: 'lab_pathology', name: 'Hormone - FSH' },
    { id: 'lab_hormone_prl', specialty_id: 'lab_pathology', name: 'Hormone - Prolactin' },
    { id: 'lab_urinalysis', specialty_id: 'lab_pathology', name: 'Urinalysis' },
    { id: 'lab_urine_culture', specialty_id: 'lab_pathology', name: 'Urine Culture' },
    { id: 'lab_stool_analysis', specialty_id: 'lab_pathology', name: 'Stool Analysis' },
    { id: 'lab_stool_culture', specialty_id: 'lab_pathology', name: 'Stool Culture' },
    { id: 'lab_histo_small', specialty_id: 'lab_pathology', name: 'Histopathology - Small Biopsy' },
    { id: 'lab_histo_large', specialty_id: 'lab_pathology', name: 'Histopathology - Large Biopsy' },
    { id: 'lab_histo_organ', specialty_id: 'lab_pathology', name: 'Histopathology - Organ/Resection' },
    { id: 'lab_cytology', specialty_id: 'lab_pathology', name: 'Cytology' },
    { id: 'lab_micro_urine_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Urine C&S' },
    { id: 'lab_micro_stool_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Stool C&S' },
    { id: 'lab_micro_sputum_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Sputum C&S' },
    { id: 'lab_micro_blood_cs', specialty_id: 'lab_pathology', name: 'Microbiology - Blood C&S' },
    { id: 'lab_bone_marrow', specialty_id: 'lab_pathology', name: 'Bone Marrow Aspirate Review' },
    { id: 'lab_pap_smear', specialty_id: 'lab_pathology', name: 'Pap Smear' },
    { id: 'lab_body_fluids', specialty_id: 'lab_pathology', name: 'Body Fluids Analysis' },
    { id: 'lab_fna', specialty_id: 'lab_pathology', name: 'Fine Needle Aspiration (FNA)' },
    { id: 'lab_sensitivity', specialty_id: 'lab_pathology', name: 'Sensitivity Testing' },
    { id: 'lab_genetic_molecular', specialty_id: 'lab_pathology', name: 'Genetic/Molecular Testing' },
    { id: 'orth_xray_review', specialty_id: 'orthopedics', name: 'X-Ray Review' },
    { id: 'orth_mri_review', specialty_id: 'orthopedics', name: 'Orthopedic MRI Review' },
    { id: 'orth_ct_review', specialty_id: 'orthopedics', name: 'CT Scan Review' },
    { id: 'orth_spine_imaging', specialty_id: 'orthopedics', name: 'Spine Imaging Review' },
    { id: 'orth_knee_mri', specialty_id: 'orthopedics', name: 'Knee MRI Review' },
    { id: 'orth_shoulder_mri', specialty_id: 'orthopedics', name: 'Shoulder MRI Review' },
    { id: 'orth_hip_mri', specialty_id: 'orthopedics', name: 'Hip MRI Review' },
    { id: 'orth_fracture_review', specialty_id: 'orthopedics', name: 'Fracture Management Review' },
    { id: 'orth_preop_opinion', specialty_id: 'orthopedics', name: 'Pre-Operative Opinion' },
    { id: 'orth_postop_review', specialty_id: 'orthopedics', name: 'Post-Operative Review' },
    { id: 'orth_bone_density', specialty_id: 'orthopedics', name: 'Bone Density (DEXA) Review' },
    { id: 'gastro_endoscopy', specialty_id: 'gastroenterology', name: 'Endoscopy Report Review' },
    { id: 'gastro_colonoscopy', specialty_id: 'gastroenterology', name: 'Colonoscopy Report Review' },
    { id: 'gastro_liver_us', specialty_id: 'gastroenterology', name: 'Liver Ultrasound Review' },
    { id: 'gastro_liver_mri', specialty_id: 'gastroenterology', name: 'Liver MRI Review' },
    { id: 'gastro_mrcp', specialty_id: 'gastroenterology', name: 'MRCP Review' },
    { id: 'gastro_liver_biopsy', specialty_id: 'gastroenterology', name: 'Liver Biopsy Report Review' },
    { id: 'gastro_fibroscan', specialty_id: 'gastroenterology', name: 'FibroScan/Elastography Review' },
    { id: 'gastro_hbv_hcv', specialty_id: 'gastroenterology', name: 'Hepatitis B/C Panel Review' },
    { id: 'gastro_ibd_review', specialty_id: 'gastroenterology', name: 'IBD Investigation Review' },
    { id: 'gastro_capsule_endo', specialty_id: 'gastroenterology', name: 'Capsule Endoscopy Review' },
    { id: 'endo_thyroid_full', specialty_id: 'endocrinology', name: 'Full Thyroid Panel Review' },
    { id: 'endo_thyroid_us', specialty_id: 'endocrinology', name: 'Thyroid Ultrasound Review' },
    { id: 'endo_diabetes_mgmt', specialty_id: 'endocrinology', name: 'Diabetes Management Review' },
    { id: 'endo_adrenal', specialty_id: 'endocrinology', name: 'Adrenal Workup Review' },
    { id: 'endo_pituitary_mri', specialty_id: 'endocrinology', name: 'Pituitary MRI Review' },
    { id: 'endo_pcos', specialty_id: 'endocrinology', name: 'PCOS Panel Review' },
    { id: 'endo_osteoporosis', specialty_id: 'endocrinology', name: 'Osteoporosis Workup Review' },
    { id: 'endo_lipid_mgmt', specialty_id: 'endocrinology', name: 'Lipid Disorder Management' },
    { id: 'endo_obesity_review', specialty_id: 'endocrinology', name: 'Obesity/Metabolic Review' },
    { id: 'endo_growth_hormone', specialty_id: 'endocrinology', name: 'Growth Hormone Panel Review' },
    { id: 'pulm_cxr_review', specialty_id: 'pulmonology', name: 'Chest X-Ray Review' },
    { id: 'pulm_ct_chest', specialty_id: 'pulmonology', name: 'CT Chest Review' },
    { id: 'pulm_hrct', specialty_id: 'pulmonology', name: 'HRCT Chest Review' },
    { id: 'pulm_pft_review', specialty_id: 'pulmonology', name: 'Pulmonary Function Test Review' },
    { id: 'pulm_sleep_study', specialty_id: 'pulmonology', name: 'Sleep Study (PSG) Review' },
    { id: 'pulm_bronchoscopy', specialty_id: 'pulmonology', name: 'Bronchoscopy Report Review' },
    { id: 'pulm_post_covid', specialty_id: 'pulmonology', name: 'Post-COVID Lung Review' },
    { id: 'pulm_tb_workup', specialty_id: 'pulmonology', name: 'TB Workup Review' },
    { id: 'pulm_v_q_scan', specialty_id: 'pulmonology', name: 'V/Q Scan Review' },
    { id: 'neph_kidney_function', specialty_id: 'nephrology', name: 'Kidney Function Panel Review' },
    { id: 'neph_kidney_biopsy', specialty_id: 'nephrology', name: 'Kidney Biopsy Report Review' },
    { id: 'neph_kidney_us', specialty_id: 'nephrology', name: 'Kidney Ultrasound Review' },
    { id: 'neph_ckd_review', specialty_id: 'nephrology', name: 'CKD Staging & Management Review' },
    { id: 'neph_dialysis_review', specialty_id: 'nephrology', name: 'Dialysis Adequacy Review' },
    { id: 'neph_proteinuria', specialty_id: 'nephrology', name: 'Proteinuria Workup Review' },
    { id: 'neph_stone_review', specialty_id: 'nephrology', name: 'Kidney Stone CT Review' },
    { id: 'neph_htn_workup', specialty_id: 'nephrology', name: 'Hypertension Workup Review' },
    { id: 'obgyn_obs_us', specialty_id: 'obgyn', name: 'Obstetric Ultrasound Review' },
    { id: 'obgyn_fetal_echo', specialty_id: 'obgyn', name: 'Fetal Echocardiography Review' },
    { id: 'obgyn_gynae_us', specialty_id: 'obgyn', name: 'Gynaecological Ultrasound Review' },
    { id: 'obgyn_pap_smear', specialty_id: 'obgyn', name: 'Pap Smear Report Review' },
    { id: 'obgyn_mri_pelvis', specialty_id: 'obgyn', name: 'MRI Pelvis Review' },
    { id: 'obgyn_fertility_panel', specialty_id: 'obgyn', name: 'Fertility Panel Review' },
    { id: 'obgyn_fibroid_review', specialty_id: 'obgyn', name: 'Fibroid Management Review' },
    { id: 'obgyn_prenatal_labs', specialty_id: 'obgyn', name: 'Prenatal Labs Review' },
    { id: 'obgyn_hsg', specialty_id: 'obgyn', name: 'HSG Report Review' },
    { id: 'derm_clinical_photos', specialty_id: 'dermatology', name: 'Clinical Photo Review' },
    { id: 'derm_dermoscopy', specialty_id: 'dermatology', name: 'Dermoscopy Review' },
    { id: 'derm_skin_biopsy', specialty_id: 'dermatology', name: 'Skin Biopsy Report Review' },
    { id: 'derm_patch_test', specialty_id: 'dermatology', name: 'Patch Test Review' },
    { id: 'derm_autoimmune_skin', specialty_id: 'dermatology', name: 'Autoimmune Skin Panel Review' },
    { id: 'derm_hair_loss', specialty_id: 'dermatology', name: 'Hair Loss Workup Review' },
    { id: 'derm_psoriasis', specialty_id: 'dermatology', name: 'Psoriasis Management Review' },
    { id: 'derm_wound_review', specialty_id: 'dermatology', name: 'Chronic Wound Review' },
    { id: 'opht_oct_review', specialty_id: 'ophthalmology', name: 'OCT Scan Review' },
    { id: 'opht_fundus_photo', specialty_id: 'ophthalmology', name: 'Fundus Photography Review' },
    { id: 'opht_visual_field', specialty_id: 'ophthalmology', name: 'Visual Field Test Review' },
    { id: 'opht_glaucoma_review', specialty_id: 'ophthalmology', name: 'Glaucoma Workup Review' },
    { id: 'opht_retinal_review', specialty_id: 'ophthalmology', name: 'Retinal Imaging Review' },
    { id: 'opht_fluorescein_angio', specialty_id: 'ophthalmology', name: 'Fluorescein Angiography Review' },
    { id: 'opht_diabetic_retina', specialty_id: 'ophthalmology', name: 'Diabetic Retinopathy Review' },
    { id: 'opht_mri_orbit', specialty_id: 'ophthalmology', name: 'MRI Orbit Review' },
    { id: 'opht_preop_opinion', specialty_id: 'ophthalmology', name: 'Pre-Op Surgical Opinion' },
    { id: 'urol_prostate_review', specialty_id: 'urology', name: 'Prostate Workup Review' },
    { id: 'urol_psa_review', specialty_id: 'urology', name: 'PSA & Prostate Panel Review' },
    { id: 'urol_mri_prostate', specialty_id: 'urology', name: 'MRI Prostate Review' },
    { id: 'urol_kidney_ct', specialty_id: 'urology', name: 'Kidney/Ureter CT Review' },
    { id: 'urol_bladder_us', specialty_id: 'urology', name: 'Bladder Ultrasound Review' },
    { id: 'urol_cystoscopy', specialty_id: 'urology', name: 'Cystoscopy Report Review' },
    { id: 'urol_urodynamics', specialty_id: 'urology', name: 'Urodynamics Study Review' },
    { id: 'urol_stone_review', specialty_id: 'urology', name: 'Renal Stone Management Review' },
    { id: 'urol_scrotal_us', specialty_id: 'urology', name: 'Scrotal Ultrasound Review' },
    { id: 'hema_cbc_full', specialty_id: 'hematology', name: 'Full CBC with Differential Review' },
    { id: 'hema_coag_panel', specialty_id: 'hematology', name: 'Coagulation Panel Review' },
    { id: 'hema_bone_marrow', specialty_id: 'hematology', name: 'Bone Marrow Biopsy Review' },
    { id: 'hema_flow_cytometry', specialty_id: 'hematology', name: 'Flow Cytometry Review' },
    { id: 'hema_lymphoma_staging', specialty_id: 'hematology', name: 'Lymphoma Staging Review' },
    { id: 'hema_anemia_workup', specialty_id: 'hematology', name: 'Anemia Workup Review' },
    { id: 'hema_thrombophilia', specialty_id: 'hematology', name: 'Thrombophilia Panel Review' },
    { id: 'hema_sickle_cell', specialty_id: 'hematology', name: 'Sickle Cell/Thalassemia Review' },
    { id: 'hema_immunoglobulins', specialty_id: 'hematology', name: 'Immunoglobulins/SPEP Review' },
    { id: 'psych_diagnosis_review', specialty_id: 'psychiatry', name: 'Psychiatric Diagnosis Review' },
    { id: 'psych_medication_review', specialty_id: 'psychiatry', name: 'Medication Regimen Review' },
    { id: 'psych_assessment_review', specialty_id: 'psychiatry', name: 'Psychological Assessment Review' },
    { id: 'psych_adhd_review', specialty_id: 'psychiatry', name: 'ADHD Assessment Review' },
    { id: 'psych_anxiety_review', specialty_id: 'psychiatry', name: 'Anxiety Disorder Review' },
    { id: 'psych_depression_review', specialty_id: 'psychiatry', name: 'Depression Management Review' },
    { id: 'psych_bipolar_review', specialty_id: 'psychiatry', name: 'Bipolar Disorder Review' },
    { id: 'psych_autism_review', specialty_id: 'psychiatry', name: 'Autism Spectrum Review' },
    { id: 'psych_substance_review', specialty_id: 'psychiatry', name: 'Substance Use Disorder Review' },
    { id: 'psych_mri_brain_psych', specialty_id: 'psychiatry', name: 'Psychiatric Brain MRI Review' }
  ];

  var egPricing = {
    rad_ct_review: { cost: 7900, status: 'active' }, rad_mri_review: { cost: 7300, status: 'active' }, rad_cxr_review: { cost: 550, status: 'active' }, rad_us_review: { cost: 1500, status: 'active' }, rad_neuro_imaging: { cost: 4550, status: 'active' }, rad_spine_mri: { cost: 8100, status: 'active' }, rad_ct_mr_angio: { cost: 15200, status: 'active' }, rad_onc_petct_staging: { cost: null, status: 'not_available' }, rad_abd_pelvis_ct_mri: { cost: 7000, status: 'active' }, rad_msk_imaging: { cost: 1600, status: 'active' }, rad_cardiac_ct: { cost: 6900, status: 'active' }, rad_cardiac_mri: { cost: 7300, status: 'active' },
    card_ecg_12lead: { cost: 500, status: 'active' }, card_rhythm_strip: { cost: 500, status: 'active' }, card_echo: { cost: 1200, status: 'active' }, card_stress_treadmill: { cost: 1350, status: 'active' }, card_stress_echo: { cost: 1800, status: 'active' }, card_holter_24_72: { cost: 3000, status: 'active' }, card_event_monitor: { cost: null, status: 'not_available' }, card_ctca: { cost: 6900, status: 'active' }, card_calcium_score: { cost: 3200, status: 'active' }, card_cmr: { cost: 7300, status: 'active' }, card_preop_clearance: { cost: null, status: 'not_available' },
    onc_petct_imaging: { cost: null, status: 'not_available' }, onc_ct_mri_staging: { cost: 15200, status: 'active' }, onc_histo_reports: { cost: null, status: 'external' }, onc_cytology_reports: { cost: null, status: 'external' }, onc_heme_onc_blood: { cost: null, status: 'external' }, onc_bone_marrow_biopsy: { cost: 10000, status: 'active' }, onc_tumor_markers: { cost: null, status: 'external' }, onc_recist_response: { cost: null, status: 'not_available' }, onc_rt_planning_scan: { cost: null, status: 'not_available' },
    neuro_brain_mri: { cost: 3200, status: 'active' }, neuro_brain_ct: { cost: 1350, status: 'active' }, neuro_spine_mri: { cost: 8100, status: 'active' }, neuro_eeg: { cost: 11500, status: 'active' }, neuro_emg_ncs: { cost: 6000, status: 'active' }, neuro_cta: { cost: 7900, status: 'active' }, neuro_mra: { cost: 5400, status: 'active' }, neuro_neurovascular: { cost: null, status: 'needs_clarification' }, neuro_perfusion: { cost: null, status: 'needs_clarification' }, neuro_epilepsy_imaging: { cost: null, status: 'needs_clarification' }, neuro_stroke_imaging: { cost: null, status: 'needs_clarification' },
    lab_cbc: { cost: 380, status: 'active' }, lab_kidney_urea: { cost: 180, status: 'active' }, lab_kidney_creat: { cost: 180, status: 'active' }, lab_kidney_uric_acid: { cost: 180, status: 'active' }, lab_liver_ast: { cost: 180, status: 'active' }, lab_liver_alt: { cost: 180, status: 'active' }, lab_liver_ggt: { cost: 220, status: 'active' }, lab_liver_alp: { cost: 190, status: 'active' }, lab_liver_albumin: { cost: 190, status: 'active' }, lab_electrolytes_na: { cost: 230, status: 'active' }, lab_electrolytes_k: { cost: 230, status: 'active' }, lab_thyroid_panel: { cost: 1010, status: 'active' }, lab_lipid_profile: { cost: 680, status: 'active' }, lab_diabetes: { cost: 620, status: 'active' }, lab_autoimmune_ana: { cost: 700, status: 'active' }, lab_autoimmune_anti_dna: { cost: 1300, status: 'active' }, lab_autoimmune_asma: { cost: 1300, status: 'active' }, lab_autoimmune_anca: { cost: 2200, status: 'active' }, lab_autoimmune_c3: { cost: 400, status: 'active' }, lab_autoimmune_c4: { cost: 400, status: 'active' }, lab_coag_pt: { cost: 250, status: 'active' }, lab_coag_ptt: { cost: 270, status: 'active' }, lab_tumor_cea: { cost: 440, status: 'active' }, lab_tumor_ca153: { cost: 600, status: 'active' }, lab_tumor_ca199: { cost: 600, status: 'active' }, lab_tumor_ca125: { cost: 600, status: 'active' }, lab_tumor_psa: { cost: 460, status: 'active' }, lab_tumor_afp: { cost: 440, status: 'active' }, lab_hormone_dhea: { cost: 440, status: 'active' }, lab_hormone_e2: { cost: 330, status: 'active' }, lab_hormone_testo: { cost: 680, status: 'active' }, lab_hormone_lh: { cost: 300, status: 'active' }, lab_hormone_fsh: { cost: 330, status: 'active' }, lab_hormone_prl: { cost: 330, status: 'active' }, lab_urinalysis: { cost: 160, status: 'active' }, lab_urine_culture: { cost: 540, status: 'active' }, lab_stool_analysis: { cost: 170, status: 'active' }, lab_stool_culture: { cost: 600, status: 'active' }, lab_histo_small: { cost: 1450, status: 'active' }, lab_histo_large: { cost: 2600, status: 'active' }, lab_histo_organ: { cost: 3700, status: 'active' }, lab_cytology: { cost: 900, status: 'active' }, lab_micro_urine_cs: { cost: 540, status: 'active' }, lab_micro_stool_cs: { cost: 600, status: 'active' }, lab_micro_sputum_cs: { cost: 6000, status: 'active' }, lab_micro_blood_cs: { cost: 830, status: 'active' }, lab_bone_marrow: { cost: 10000, status: 'active' }, lab_pap_smear: { cost: null, status: 'needs_clarification' }, lab_body_fluids: { cost: null, status: 'needs_clarification' }, lab_fna: { cost: null, status: 'needs_clarification' }, lab_sensitivity: { cost: null, status: 'needs_clarification' }, lab_genetic_molecular: { cost: null, status: 'needs_clarification' },
    orth_xray_review: { cost: 900, status: 'active' }, orth_mri_review: { cost: 3500, status: 'active' }, orth_ct_review: { cost: 2800, status: 'active' }, orth_spine_imaging: { cost: 3500, status: 'active' }, orth_knee_mri: { cost: 3200, status: 'active' }, orth_shoulder_mri: { cost: 3200, status: 'active' }, orth_hip_mri: { cost: 3200, status: 'active' }, orth_fracture_review: { cost: 2500, status: 'active' }, orth_preop_opinion: { cost: 4500, status: 'active' }, orth_postop_review: { cost: 3000, status: 'active' }, orth_bone_density: { cost: 1200, status: 'active' },
    gastro_endoscopy: { cost: 3000, status: 'active' }, gastro_colonoscopy: { cost: 3000, status: 'active' }, gastro_liver_us: { cost: 1500, status: 'active' }, gastro_liver_mri: { cost: 6000, status: 'active' }, gastro_mrcp: { cost: 6500, status: 'active' }, gastro_liver_biopsy: { cost: 7000, status: 'active' }, gastro_fibroscan: { cost: 2500, status: 'active' }, gastro_hbv_hcv: { cost: 2000, status: 'active' }, gastro_ibd_review: { cost: 4000, status: 'active' }, gastro_capsule_endo: { cost: 7000, status: 'active' },
    endo_thyroid_full: { cost: 1200, status: 'active' }, endo_thyroid_us: { cost: 1500, status: 'active' }, endo_diabetes_mgmt: { cost: 2000, status: 'active' }, endo_adrenal: { cost: 3500, status: 'active' }, endo_pituitary_mri: { cost: 3500, status: 'active' }, endo_pcos: { cost: 2000, status: 'active' }, endo_osteoporosis: { cost: 1800, status: 'active' }, endo_lipid_mgmt: { cost: 1200, status: 'active' }, endo_obesity_review: { cost: 2000, status: 'active' }, endo_growth_hormone: { cost: 3500, status: 'active' },
    pulm_cxr_review: { cost: 550, status: 'active' }, pulm_ct_chest: { cost: 3500, status: 'active' }, pulm_hrct: { cost: 5000, status: 'active' }, pulm_pft_review: { cost: 2500, status: 'active' }, pulm_sleep_study: { cost: 5000, status: 'active' }, pulm_bronchoscopy: { cost: 4500, status: 'active' }, pulm_post_covid: { cost: 2500, status: 'active' }, pulm_tb_workup: { cost: 2500, status: 'active' }, pulm_v_q_scan: { cost: 4500, status: 'active' },
    neph_kidney_function: { cost: 1200, status: 'active' }, neph_kidney_biopsy: { cost: 7000, status: 'active' }, neph_kidney_us: { cost: 1500, status: 'active' }, neph_ckd_review: { cost: 2500, status: 'active' }, neph_dialysis_review: { cost: 4000, status: 'active' }, neph_proteinuria: { cost: 2500, status: 'active' }, neph_stone_review: { cost: 2800, status: 'active' }, neph_htn_workup: { cost: 2500, status: 'active' },
    obgyn_obs_us: { cost: 1500, status: 'active' }, obgyn_fetal_echo: { cost: 4000, status: 'active' }, obgyn_gynae_us: { cost: 1500, status: 'active' }, obgyn_pap_smear: { cost: 900, status: 'active' }, obgyn_mri_pelvis: { cost: 5500, status: 'active' }, obgyn_fertility_panel: { cost: 2000, status: 'active' }, obgyn_fibroid_review: { cost: 2500, status: 'active' }, obgyn_prenatal_labs: { cost: 1200, status: 'active' }, obgyn_hsg: { cost: 2000, status: 'active' },
    derm_clinical_photos: { cost: 1800, status: 'active' }, derm_dermoscopy: { cost: 2500, status: 'active' }, derm_skin_biopsy: { cost: 4000, status: 'active' }, derm_patch_test: { cost: 2000, status: 'active' }, derm_autoimmune_skin: { cost: 4000, status: 'active' }, derm_hair_loss: { cost: 2000, status: 'active' }, derm_psoriasis: { cost: 2000, status: 'active' }, derm_wound_review: { cost: 2000, status: 'active' },
    opht_oct_review: { cost: 2500, status: 'active' }, opht_fundus_photo: { cost: 2000, status: 'active' }, opht_visual_field: { cost: 1800, status: 'active' }, opht_glaucoma_review: { cost: 3500, status: 'active' }, opht_retinal_review: { cost: 3500, status: 'active' }, opht_fluorescein_angio: { cost: 4500, status: 'active' }, opht_diabetic_retina: { cost: 2500, status: 'active' }, opht_mri_orbit: { cost: 5000, status: 'active' }, opht_preop_opinion: { cost: 4000, status: 'active' },
    urol_prostate_review: { cost: 2500, status: 'active' }, urol_psa_review: { cost: 1500, status: 'active' }, urol_mri_prostate: { cost: 5000, status: 'active' }, urol_kidney_ct: { cost: 2800, status: 'active' }, urol_bladder_us: { cost: 1500, status: 'active' }, urol_cystoscopy: { cost: 4000, status: 'active' }, urol_urodynamics: { cost: 4500, status: 'active' }, urol_stone_review: { cost: 2500, status: 'active' }, urol_scrotal_us: { cost: 1800, status: 'active' },
    hema_cbc_full: { cost: 1200, status: 'active' }, hema_coag_panel: { cost: 2000, status: 'active' }, hema_bone_marrow: { cost: 10000, status: 'active' }, hema_flow_cytometry: { cost: 9000, status: 'active' }, hema_lymphoma_staging: { cost: 9000, status: 'active' }, hema_anemia_workup: { cost: 2500, status: 'active' }, hema_thrombophilia: { cost: 5000, status: 'active' }, hema_sickle_cell: { cost: 2500, status: 'active' }, hema_immunoglobulins: { cost: 5000, status: 'active' },
    psych_diagnosis_review: { cost: null, status: 'not_available' }, psych_medication_review: { cost: null, status: 'not_available' }, psych_assessment_review: { cost: null, status: 'not_available' }, psych_adhd_review: { cost: null, status: 'not_available' }, psych_anxiety_review: { cost: null, status: 'not_available' }, psych_depression_review: { cost: null, status: 'not_available' }, psych_bipolar_review: { cost: null, status: 'not_available' }, psych_autism_review: { cost: null, status: 'not_available' }, psych_substance_review: { cost: null, status: 'not_available' }, psych_mri_brain_psych: { cost: null, status: 'not_available' }
  };

  var otherRegions = [
    { code: 'SA', currency: 'SAR' },
    { code: 'AE', currency: 'AED' },
    { code: 'GB', currency: 'GBP' },
    { code: 'US', currency: 'USD' }
  ];

  var now = new Date().toISOString();
  var idCounter = 0;
  function nextId() { return 'srp_' + (++idCounter); }

  try {
    await withTransaction(async function(client) {
      for (var si = 0; si < specialties.length; si++) {
        var sp = specialties[si];
        await client.query('INSERT INTO specialties (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [sp.id, sp.name]);
      }
      for (var svi = 0; svi < services.length; svi++) {
        var sv = services[svi];
        await client.query('INSERT INTO services (id, specialty_id, code, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [sv.id, sv.specialty_id, sv.id, sv.name]);
      }
      var egCount = 0;
      var placeholderCount = 0;
      for (var pi = 0; pi < services.length; pi++) {
        var svc = services[pi];
        var p = egPricing[svc.id];
        if (!p) continue;
        var hc = p.cost;
        var tp = (hc !== null) ? Math.ceil(hc * 1.15) : null;
        var dc = (tp !== null) ? Math.ceil(tp * 0.20) : null;
        await client.query(
          'INSERT INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (service_id, country_code) DO NOTHING',
          [nextId(), svc.id, 'EG', 'EGP', hc, tp, dc, p.status, null, now, now]
        );
        egCount++;
        for (var ri = 0; ri < otherRegions.length; ri++) {
          var r = otherRegions[ri];
          await client.query(
            'INSERT INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (service_id, country_code) DO NOTHING',
            [nextId(), svc.id, r.code, r.currency, null, null, null, 'pending_pricing', 'Awaiting regional pricing', now, now]
          );
          placeholderCount++;
        }
      }
      logMajor('Seeded ' + egCount + ' EG prices + ' + placeholderCount + ' regional placeholders');
    });
  } catch (e) {
    logMajor('Pricing seed failed (may already exist): ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Business logic functions (unchanged)
// ---------------------------------------------------------------------------

async function acceptOrder(orderId, doctorId) {
  return await withTransaction(async function(client) {
    var result = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    var order = result.rows[0] || null;
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'new') throw new Error('ORDER_ALREADY_ACCEPTED');
    var now = new Date().toISOString();
    await client.query(
      "UPDATE orders SET doctor_id = $1, status = 'review', accepted_at = $2, updated_at = $3 WHERE id = $4",
      [doctorId, now, now, orderId]
    );
    await client.query(
      'INSERT INTO order_events (id, order_id, label, actor_user_id, actor_role) VALUES ($1, $2, $3, $4, $5)',
      ['evt-' + Date.now() + '-' + Math.random().toString(36).slice(2), orderId, 'doctor_accepted', doctorId, 'doctor']
    );
    return true;
  });
}

async function getActiveCasesForDoctor(doctorId) {
  return await queryAll(
    "SELECT * FROM orders WHERE doctor_id = $1 AND status IN ('review') AND completed_at IS NULL ORDER BY accepted_at DESC",
    [doctorId]
  );
}

async function getOrdersColumns() {
  try {
    var rows = await queryAll("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'");
    return rows.map(function(r) { return r.column_name; });
  } catch (e) { return []; }
}

async function getOrderEventsColumns() {
  try {
    var rows = await queryAll("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_events'");
    return rows.map(function(r) { return r.column_name; });
  } catch (e) { return []; }
}

async function markOrderCompleted(opts) {
  var orderId = opts.orderId;
  var doctorId = opts.doctorId;
  var reportUrl = opts.reportUrl;
  if (!orderId) throw new Error('orderId is required');

  var now = new Date().toISOString();
  var ordersCols = await getOrdersColumns();

  return await withTransaction(async function(client) {
    var sets = ["status = 'completed'"];
    var params = [];
    var paramIdx = 0;

    if (ordersCols.indexOf('completed_at') !== -1) { paramIdx++; sets.push('completed_at = COALESCE(completed_at, $' + paramIdx + ')'); params.push(now); }
    if (ordersCols.indexOf('updated_at') !== -1) { paramIdx++; sets.push('updated_at = $' + paramIdx); params.push(now); }
    if (doctorId && ordersCols.indexOf('doctor_id') !== -1) { paramIdx++; sets.push('doctor_id = COALESCE(doctor_id, $' + paramIdx + ')'); params.push(doctorId); }
    if (ordersCols.indexOf('report_url') !== -1) { paramIdx++; sets.push('report_url = $' + paramIdx); params.push(reportUrl || null); }

    paramIdx++;
    params.push(orderId);
    await client.query('UPDATE orders SET ' + sets.join(', ') + ' WHERE id = $' + paramIdx, params);

    var evCols = await getOrderEventsColumns();
    if (evCols.indexOf('id') !== -1 && evCols.indexOf('order_id') !== -1 && evCols.indexOf('label') !== -1) {
      var evId = 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var cols = ['id', 'order_id', 'label'];
      var vals = [evId, orderId, 'report_completed'];
      if (evCols.indexOf('meta') !== -1) { cols.push('meta'); vals.push(JSON.stringify({ reportUrl: reportUrl || null })); }
      if (evCols.indexOf('at') !== -1) { cols.push('at'); vals.push(now); }
      if (evCols.indexOf('actor_user_id') !== -1) { cols.push('actor_user_id'); vals.push(doctorId || null); }
      if (evCols.indexOf('actor_role') !== -1) { cols.push('actor_role'); vals.push('doctor'); }
      var placeholders = cols.map(function(_, idx) { return '$' + (idx + 1); }).join(', ');
      await client.query('INSERT INTO order_events (' + cols.join(', ') + ') VALUES (' + placeholders + ')', vals);
    }

    return true;
  });
}

module.exports = {
  pool: pool,
  migrate: migrate,
  acceptOrder: acceptOrder,
  getActiveCasesForDoctor: getActiveCasesForDoctor,
  markOrderCompleted: markOrderCompleted,
  queryOne: queryOne,
  queryAll: queryAll,
  execute: execute,
  withTransaction: withTransaction
};
