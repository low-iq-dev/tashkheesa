#!/usr/bin/env node
/**
 * Seed pricing into service_regional_prices for EG/EGP using a hardcoded mapping.
 *
 * Usage:
 *   node scripts/seed_pricing_v2.js              # apply UPSERTs
 *   node scripts/seed_pricing_v2.js --dry-run    # preview only
 *
 * Idempotent: UPSERT keyed on (service_id, country_code).
 * Refuses to touch any service_id in DO_NOT_TOUCH.
 */

require('dotenv').config();
const { pool } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

const PRICING = {
  'card_calcium_score':      { price: 1150, fee: 230 },
  'card_cmr':                { price: 1150, fee: 230 },
  'card_ctca':               { price: 1380, fee: 276 },
  'card_ecg_12lead':         { price: 1250, fee: 250 },
  'card_echo':               { price: 1500, fee: 300 },
  'card_holter_24_72':       { price: 1500, fee: 300 },
  'card_rhythm_strip':       { price: 1250, fee: 250 },
  'card_stress_treadmill':   { price: 1500, fee: 300 },
  'card_stress_echo':        { price: 1500, fee: 300 },
  'lab_autoimmune':          { price: 1500, fee: 300 },
  'lab_autoimmune_ana':      { price: 1500, fee: 300 },
  'lab_autoimmune_anca':     { price: 1500, fee: 300 },
  'lab_autoimmune_anti_dna': { price: 1500, fee: 300 },
  'lab_autoimmune_asma':     { price: 1500, fee: 300 },
  'lab_autoimmune_c3':       { price: 1500, fee: 300 },
  'lab_autoimmune_c4':       { price: 1500, fee: 300 },
  'lab_bm_smear_biopsy':     { price: 1495, fee: 299 },
  'lab_bone_marrow':         { price: 1495, fee: 299 },
  'lab_cbc':                 { price: 1250, fee: 250 },
  'lab_coag':                { price: 1250, fee: 250 },
  'lab_coag_pt':             { price: 1250, fee: 250 },
  'lab_coag_ptt':            { price: 1250, fee: 250 },
  'lab_cytology':            { price: 1250, fee: 250 },
  'lab_diabetes':            { price: 1250, fee: 250 },
  'lab_electrolytes':        { price: 1250, fee: 250 },
  'lab_electrolytes_k':      { price: 1250, fee: 250 },
  'lab_electrolytes_na':     { price: 1250, fee: 250 },
  'lab_histo_large':         { price: 1380, fee: 276 },
  'lab_histo_organ':         { price: 1380, fee: 276 },
  'lab_histo_small':         { price: 1250, fee: 250 },
  'lab_hormone_dhea':        { price: 1250, fee: 250 },
  'lab_hormone_e2':          { price: 1250, fee: 250 },
  'lab_hormone_fsh':         { price: 1250, fee: 250 },
  'lab_hormone_lh':          { price: 1250, fee: 250 },
  'lab_hormone_prl':         { price: 1250, fee: 250 },
  'lab_hormone_testo':       { price: 1250, fee: 250 },
  'lab_kidney_creat':        { price: 1250, fee: 250 },
  'lab_kidney_urea':         { price: 1250, fee: 250 },
  'lab_kidney_uric_acid':    { price: 1250, fee: 250 },
  'lab_liver_albumin':       { price: 1250, fee: 250 },
  'lab_liver_alp':           { price: 1250, fee: 250 },
  'lab_liver_alt':           { price: 1250, fee: 250 },
  'lab_liver_ast':           { price: 1250, fee: 250 },
  'lab_liver_ggt':           { price: 1250, fee: 250 },
  'lab_micro_blood_cs':      { price: 1500, fee: 300 },
  'lab_micro_sputum_cs':     { price: 1500, fee: 300 },
  'lab_micro_stool_cs':      { price: 1500, fee: 300 },
  'lab_micro_urine_cs':      { price: 1500, fee: 300 },
  'lab_stool_analysis':      { price: 1250, fee: 250 },
  'lab_stool_culture':       { price: 1500, fee: 300 },
  'lab_tumor_afp':           { price: 1250, fee: 250 },
  'lab_tumor_ca125':         { price: 1250, fee: 250 },
  'lab_tumor_ca153':         { price: 1250, fee: 250 },
  'lab_tumor_ca199':         { price: 1250, fee: 250 },
  'lab_tumor_cea':           { price: 1250, fee: 250 },
  'lab_tumor_psa':           { price: 1250, fee: 250 },
  'lab_urinalysis':          { price: 1250, fee: 250 },
  'lab_urine_culture':       { price: 1500, fee: 300 },
  'neuro_brain_ct':          { price: 1500, fee: 300 },
  'neuro_brain_mri':         { price: 1150, fee: 230 },
  'neuro_cta':               { price: 1150, fee: 230 },
  'neuro_eeg':               { price: 1500, fee: 300 },
  'neuro_emg_ncs':           { price: 1500, fee: 300 },
  'neuro_mra':               { price: 1150, fee: 230 },
  'neuro_spine_mri':         { price: 1150, fee: 230 },
  'onc_bone_marrow_biopsy':  { price: 1495, fee: 299 },
  'onc_ct_mri_staging':      { price: 1150, fee: 230 },
  'onc_histo_reports':       { price: 1380, fee: 276 },
  'onc_rt_planning_scan':    { price: 1725, fee: 345 },
  'rad_abd_pelvis_ct_mri':   { price: 1500, fee: 300 },
  'rad_cardiac_ct':          { price: 1150, fee: 230 },
  'rad_cardiac_mri':         { price: 1150, fee: 230 },
  'rad_ct_mr_angio':         { price: 1150, fee: 230 },
  'rad_ct_review':           { price: 1500, fee: 300 },
  'rad_cxr_review':          { price: 1250, fee: 250 },
  'rad_mri_review':          { price: 1035, fee: 207 },
  'rad_msk_imaging':         { price: 1035, fee: 207 },
  'rad_neuro_imaging':       { price: 1500, fee: 300 },
  'rad_spine_mri':           { price: 1150, fee: 230 },
  'rad_us_review':           { price: 1500, fee: 300 },
};

const DO_NOT_TOUCH = new Set([
  'card_event_monitor', 'card_preop_clearance',
  'neuro_epilepsy_imaging', 'neuro_neurovascular', 'neuro_perfusion', 'neuro_stroke_imaging',
  'onc_cytology_reports', 'onc_heme_onc_blood', 'onc_petct_imaging', 'onc_recist_response',
  'rad_onc_petct_staging',
  'lab_body_fluids', 'lab_fna', 'lab_genetic_molecular', 'lab_pap_smear', 'lab_sensitivity',
]);

const UPSERT_SQL = `
  INSERT INTO service_regional_prices (id, service_id, country_code, currency, tashkheesa_price, doctor_commission, status, updated_at)
  VALUES (gen_random_uuid()::text, $1, 'EG', 'EGP', $2, $3, 'active', NOW())
  ON CONFLICT (service_id, country_code)
  DO UPDATE SET tashkheesa_price  = EXCLUDED.tashkheesa_price,
                doctor_commission = EXCLUDED.doctor_commission,
                status            = 'active',
                updated_at        = NOW()
`;

async function main() {
  console.log(DRY_RUN ? '[DRY-RUN] No DB writes will be performed.' : '[LIVE] Will UPSERT into service_regional_prices.');
  console.log(`PRICING entries: ${Object.keys(PRICING).length}`);
  console.log('');

  // Safety: refuse if PRICING overlaps DO_NOT_TOUCH
  const overlap = Object.keys(PRICING).filter(k => DO_NOT_TOUCH.has(k));
  if (overlap.length > 0) {
    console.error('ABORT: PRICING contains DO_NOT_TOUCH keys:', overlap);
    process.exit(1);
  }

  // Pre-check: which PRICING keys actually exist as services? (no FK declared, so we warn instead of fail)
  const existing = await pool.query(
    'SELECT id FROM services WHERE id = ANY($1::text[])',
    [Object.keys(PRICING)]
  );
  const existingIds = new Set(existing.rows.map(r => r.id));
  const orphans = Object.keys(PRICING).filter(k => !existingIds.has(k));
  if (orphans.length > 0) {
    console.warn(`⚠️  ${orphans.length} PRICING keys reference service IDs that DO NOT exist in services table:`);
    for (const o of orphans) console.warn('    - ' + o);
    console.warn('   These rows would be inserted but reference no service. Continue?');
    console.warn('');
  }

  // Pre-check: show which already have an EG row vs new
  const existingEg = await pool.query(
    `SELECT service_id, tashkheesa_price, doctor_commission, status
     FROM service_regional_prices
     WHERE country_code = 'EG' AND service_id = ANY($1::text[])`,
    [Object.keys(PRICING)]
  );
  const egByService = new Map(existingEg.rows.map(r => [r.service_id, r]));

  let ok = 0;
  let fail = 0;
  let unchanged = 0;
  let inserted = 0;
  let updated = 0;

  for (const [serviceId, p] of Object.entries(PRICING)) {
    const cur = egByService.get(serviceId);
    let action;
    if (!cur) {
      action = 'INSERT';
    } else if (
      Number(cur.tashkheesa_price) === p.price &&
      Number(cur.doctor_commission) === p.fee &&
      String(cur.status) === 'active'
    ) {
      action = 'UNCHANGED';
    } else {
      action = 'UPDATE';
    }

    const fromText = cur
      ? `(was: price=${cur.tashkheesa_price ?? 'NULL'}, fee=${cur.doctor_commission ?? 'NULL'}, status=${cur.status ?? 'NULL'})`
      : '(no existing EG row)';

    if (DRY_RUN) {
      console.log(`[${action.padEnd(9)}] ${serviceId.padEnd(28)} → price=${p.price} fee=${p.fee} ${fromText}`);
      ok++;
      if (action === 'INSERT')   inserted++;
      if (action === 'UPDATE')   updated++;
      if (action === 'UNCHANGED') unchanged++;
      continue;
    }

    try {
      await pool.query(UPSERT_SQL, [serviceId, p.price, p.fee]);
      ok++;
      if (action === 'INSERT')    inserted++;
      else if (action === 'UPDATE')   updated++;
      else                            unchanged++;
    } catch (e) {
      console.error(`FAIL: ${serviceId}: ${e.message}`);
      fail++;
    }
  }

  console.log('');
  console.log(`✅ ${DRY_RUN ? 'Would upsert' : 'Upserted'}: ${ok} rows into service_regional_prices (EG/EGP)`);
  console.log(`   ├─ inserts:   ${inserted}`);
  console.log(`   ├─ updates:   ${updated}`);
  console.log(`   └─ unchanged: ${unchanged}`);
  console.log(`❌ Failed: ${fail}`);

  await pool.end();
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
