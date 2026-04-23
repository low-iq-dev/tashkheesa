#!/usr/bin/env node
/**
 * Tashkheesa Pricing Sync v2
 *
 * Seeds exactly 10 specialties and 92 services with authoritative pricing.
 * Idempotent: safe to run multiple times.
 *
 * Usage: node src/sync_pricing_v2.js
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Canonical 10 specialties ───────────────────────────────

const SPECIALTIES = [
  { id: 'spec-orthopedics',      name: 'Orthopedics' },
  { id: 'spec-gastroenterology', name: 'Gastroenterology' },
  { id: 'spec-endocrinology',    name: 'Endocrinology' },
  { id: 'spec-pulmonology',      name: 'Pulmonology' },
  { id: 'spec-nephrology',       name: 'Nephrology' },
  { id: 'spec-obgyn',            name: 'OB/GYN' },
  { id: 'spec-dermatology',      name: 'Dermatology' },
  { id: 'spec-ophthalmology',    name: 'Ophthalmology' },
  { id: 'spec-urology',          name: 'Urology' },
  { id: 'spec-hematology',       name: 'Hematology' },
];

// ─── All 92 services with multi-currency pricing ────────────

const SERVICES = [
  // Orthopedics (11)
  { specialty: 'spec-orthopedics', name: 'X-Ray Review', usd: 249, gbp: 210, aed: 550, egp: 1380, docFee: 276 },
  { specialty: 'spec-orthopedics', name: 'Orthopedic MRI Review', usd: 379, gbp: 275, aed: 680, egp: 5175, docFee: 1035 },
  { specialty: 'spec-orthopedics', name: 'CT Scan Review', usd: 319, gbp: 250, aed: 640, egp: 4140, docFee: 828 },
  { specialty: 'spec-orthopedics', name: 'Spine Imaging Review', usd: 379, gbp: 275, aed: 680, egp: 5175, docFee: 1035 },
  { specialty: 'spec-orthopedics', name: 'Knee MRI Review', usd: 379, gbp: 275, aed: 680, egp: 4715, docFee: 943 },
  { specialty: 'spec-orthopedics', name: 'Shoulder MRI Review', usd: 379, gbp: 275, aed: 680, egp: 4715, docFee: 943 },
  { specialty: 'spec-orthopedics', name: 'Hip MRI Review', usd: 379, gbp: 275, aed: 680, egp: 4715, docFee: 943 },
  { specialty: 'spec-orthopedics', name: 'Fracture Management Review', usd: 449, gbp: 300, aed: 730, egp: 3680, docFee: 736 },
  { specialty: 'spec-orthopedics', name: 'Pre-Operative Opinion', usd: 499, gbp: 350, aed: 820, egp: 6555, docFee: 1311 },
  { specialty: 'spec-orthopedics', name: 'Post-Operative Review', usd: 449, gbp: 300, aed: 730, egp: 4485, docFee: 897 },
  { specialty: 'spec-orthopedics', name: 'Bone Density (DEXA) Review', usd: 249, gbp: 210, aed: 550, egp: 1725, docFee: 345 },

  // Gastroenterology (10)
  { specialty: 'spec-gastroenterology', name: 'Endoscopy Report Review', usd: 429, gbp: 250, aed: 680, egp: 4485, docFee: 897 },
  { specialty: 'spec-gastroenterology', name: 'Colonoscopy Report Review', usd: 429, gbp: 250, aed: 680, egp: 4485, docFee: 897 },
  { specialty: 'spec-gastroenterology', name: 'Liver Ultrasound Review', usd: 319, gbp: 240, aed: 640, egp: 2185, docFee: 437 },
  { specialty: 'spec-gastroenterology', name: 'Liver MRI Review', usd: 449, gbp: 275, aed: 730, egp: 8970, docFee: 1794 },
  { specialty: 'spec-gastroenterology', name: 'MRCP Review', usd: 449, gbp: 285, aed: 750, egp: 9545, docFee: 1909 },
  { specialty: 'spec-gastroenterology', name: 'Liver Biopsy Report Review', usd: 499, gbp: 300, aed: 780, egp: 10465, docFee: 2093 },
  { specialty: 'spec-gastroenterology', name: 'FibroScan/Elastography Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-gastroenterology', name: 'Hepatitis B/C Panel Review', usd: 379, gbp: 250, aed: 650, egp: 3105, docFee: 621 },
  { specialty: 'spec-gastroenterology', name: 'IBD Investigation Review', usd: 499, gbp: 285, aed: 750, egp: 5980, docFee: 1196 },
  { specialty: 'spec-gastroenterology', name: 'Capsule Endoscopy Review', usd: 549, gbp: 325, aed: 820, egp: 10465, docFee: 2093 },

  // Endocrinology (10)
  { specialty: 'spec-endocrinology', name: 'Full Thyroid Panel Review', usd: 249, gbp: 215, aed: 550, egp: 1725, docFee: 345 },
  { specialty: 'spec-endocrinology', name: 'Thyroid Ultrasound Review', usd: 319, gbp: 235, aed: 600, egp: 2185, docFee: 437 },
  { specialty: 'spec-endocrinology', name: 'Diabetes Management Review', usd: 379, gbp: 250, aed: 640, egp: 2990, docFee: 598 },
  { specialty: 'spec-endocrinology', name: 'Adrenal Workup Review', usd: 499, gbp: 275, aed: 730, egp: 5175, docFee: 1035 },
  { specialty: 'spec-endocrinology', name: 'Pituitary MRI Review', usd: 449, gbp: 275, aed: 730, egp: 5175, docFee: 1035 },
  { specialty: 'spec-endocrinology', name: 'PCOS Panel Review', usd: 379, gbp: 250, aed: 640, egp: 2990, docFee: 598 },
  { specialty: 'spec-endocrinology', name: 'Osteoporosis Workup Review', usd: 319, gbp: 235, aed: 600, egp: 2645, docFee: 529 },
  { specialty: 'spec-endocrinology', name: 'Lipid Disorder Management', usd: 249, gbp: 215, aed: 550, egp: 1725, docFee: 345 },
  { specialty: 'spec-endocrinology', name: 'Obesity/Metabolic Review', usd: 379, gbp: 250, aed: 640, egp: 2990, docFee: 598 },
  { specialty: 'spec-endocrinology', name: 'Growth Hormone Panel Review', usd: 499, gbp: 275, aed: 730, egp: 5175, docFee: 1035 },

  // Pulmonology (9)
  { specialty: 'spec-pulmonology', name: 'Chest X-Ray Review', usd: 249, gbp: 215, aed: 550, egp: 920, docFee: 184 },
  { specialty: 'spec-pulmonology', name: 'CT Chest Review', usd: 319, gbp: 250, aed: 650, egp: 5175, docFee: 1035 },
  { specialty: 'spec-pulmonology', name: 'HRCT Chest Review', usd: 449, gbp: 275, aed: 720, egp: 7475, docFee: 1495 },
  { specialty: 'spec-pulmonology', name: 'Pulmonary Function Test Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-pulmonology', name: 'Sleep Study (PSG) Review', usd: 499, gbp: 285, aed: 760, egp: 7475, docFee: 1495 },
  { specialty: 'spec-pulmonology', name: 'Bronchoscopy Report Review', usd: 499, gbp: 285, aed: 760, egp: 6555, docFee: 1311 },
  { specialty: 'spec-pulmonology', name: 'Post-COVID Lung Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-pulmonology', name: 'TB Workup Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-pulmonology', name: 'V/Q Scan Review', usd: 449, gbp: 275, aed: 720, egp: 6555, docFee: 1311 },

  // Nephrology (8)
  { specialty: 'spec-nephrology', name: 'Kidney Function Panel Review', usd: 249, gbp: 215, aed: 550, egp: 1725, docFee: 345 },
  { specialty: 'spec-nephrology', name: 'Kidney Biopsy Report Review', usd: 549, gbp: 310, aed: 820, egp: 10465, docFee: 2093 },
  { specialty: 'spec-nephrology', name: 'Kidney Ultrasound Review', usd: 319, gbp: 240, aed: 620, egp: 2185, docFee: 437 },
  { specialty: 'spec-nephrology', name: 'CKD Staging & Management Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-nephrology', name: 'Dialysis Adequacy Review', usd: 499, gbp: 275, aed: 720, egp: 5980, docFee: 1196 },
  { specialty: 'spec-nephrology', name: 'Proteinuria Workup Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-nephrology', name: 'Kidney Stone CT Review', usd: 319, gbp: 240, aed: 620, egp: 4140, docFee: 828 },
  { specialty: 'spec-nephrology', name: 'Hypertension Workup Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },

  // OB/GYN (9)
  { specialty: 'spec-obgyn', name: 'Obstetric Ultrasound Review', usd: 319, gbp: 235, aed: 600, egp: 2185, docFee: 437 },
  { specialty: 'spec-obgyn', name: 'Fetal Echocardiography Review', usd: 499, gbp: 285, aed: 760, egp: 5980, docFee: 1196 },
  { specialty: 'spec-obgyn', name: 'Gynaecological Ultrasound Review', usd: 319, gbp: 235, aed: 600, egp: 2185, docFee: 437 },
  { specialty: 'spec-obgyn', name: 'Pap Smear Report Review', usd: 249, gbp: 215, aed: 550, egp: 1380, docFee: 276 },
  { specialty: 'spec-obgyn', name: 'MRI Pelvis Review', usd: 449, gbp: 275, aed: 720, egp: 7935, docFee: 1587 },
  { specialty: 'spec-obgyn', name: 'Fertility Panel Review', usd: 379, gbp: 250, aed: 650, egp: 2990, docFee: 598 },
  { specialty: 'spec-obgyn', name: 'Fibroid Management Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-obgyn', name: 'Prenatal Labs Review', usd: 249, gbp: 215, aed: 550, egp: 1725, docFee: 345 },
  { specialty: 'spec-obgyn', name: 'HSG Report Review', usd: 379, gbp: 245, aed: 630, egp: 2990, docFee: 598 },

  // Dermatology (8)
  { specialty: 'spec-dermatology', name: 'Clinical Photo Review', usd: 319, gbp: 275, aed: 690, egp: 2645, docFee: 529 },
  { specialty: 'spec-dermatology', name: 'Dermoscopy Review', usd: 379, gbp: 300, aed: 750, egp: 3680, docFee: 736 },
  { specialty: 'spec-dermatology', name: 'Skin Biopsy Report Review', usd: 499, gbp: 325, aed: 790, egp: 5980, docFee: 1196 },
  { specialty: 'spec-dermatology', name: 'Patch Test Review', usd: 379, gbp: 290, aed: 730, egp: 2990, docFee: 598 },
  { specialty: 'spec-dermatology', name: 'Autoimmune Skin Panel Review', usd: 499, gbp: 315, aed: 790, egp: 5980, docFee: 1196 },
  { specialty: 'spec-dermatology', name: 'Hair Loss Workup Review', usd: 379, gbp: 290, aed: 730, egp: 2990, docFee: 598 },
  { specialty: 'spec-dermatology', name: 'Psoriasis Management Review', usd: 379, gbp: 290, aed: 730, egp: 2990, docFee: 598 },
  { specialty: 'spec-dermatology', name: 'Chronic Wound Review', usd: 379, gbp: 275, aed: 690, egp: 2990, docFee: 598 },

  // Ophthalmology (9)
  { specialty: 'spec-ophthalmology', name: 'OCT Scan Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-ophthalmology', name: 'Fundus Photography Review', usd: 319, gbp: 240, aed: 620, egp: 2990, docFee: 598 },
  { specialty: 'spec-ophthalmology', name: 'Visual Field Test Review', usd: 319, gbp: 240, aed: 620, egp: 2645, docFee: 529 },
  { specialty: 'spec-ophthalmology', name: 'Glaucoma Workup Review', usd: 449, gbp: 275, aed: 720, egp: 5175, docFee: 1035 },
  { specialty: 'spec-ophthalmology', name: 'Retinal Imaging Review', usd: 449, gbp: 275, aed: 720, egp: 5175, docFee: 1035 },
  { specialty: 'spec-ophthalmology', name: 'Fluorescein Angiography Review', usd: 499, gbp: 300, aed: 780, egp: 6555, docFee: 1311 },
  { specialty: 'spec-ophthalmology', name: 'Diabetic Retinopathy Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-ophthalmology', name: 'MRI Orbit Review', usd: 449, gbp: 275, aed: 720, egp: 7475, docFee: 1495 },
  { specialty: 'spec-ophthalmology', name: 'Pre-Op Surgical Opinion', usd: 499, gbp: 300, aed: 780, egp: 5980, docFee: 1196 },

  // Urology (9)
  { specialty: 'spec-urology', name: 'Prostate Workup Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-urology', name: 'PSA & Prostate Panel Review', usd: 249, gbp: 220, aed: 570, egp: 2185, docFee: 437 },
  { specialty: 'spec-urology', name: 'MRI Prostate Review', usd: 499, gbp: 300, aed: 780, egp: 7475, docFee: 1495 },
  { specialty: 'spec-urology', name: 'Kidney/Ureter CT Review', usd: 319, gbp: 240, aed: 620, egp: 4140, docFee: 828 },
  { specialty: 'spec-urology', name: 'Bladder Ultrasound Review', usd: 249, gbp: 220, aed: 570, egp: 2185, docFee: 437 },
  { specialty: 'spec-urology', name: 'Cystoscopy Report Review', usd: 499, gbp: 285, aed: 760, egp: 5980, docFee: 1196 },
  { specialty: 'spec-urology', name: 'Urodynamics Study Review', usd: 499, gbp: 285, aed: 760, egp: 6555, docFee: 1311 },
  { specialty: 'spec-urology', name: 'Renal Stone Management Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-urology', name: 'Scrotal Ultrasound Review', usd: 319, gbp: 240, aed: 620, egp: 2645, docFee: 529 },

  // Hematology (9)
  { specialty: 'spec-hematology', name: 'Full CBC with Differential Review', usd: 249, gbp: 215, aed: 550, egp: 1725, docFee: 345 },
  { specialty: 'spec-hematology', name: 'Coagulation Panel Review', usd: 379, gbp: 250, aed: 650, egp: 2990, docFee: 598 },
  { specialty: 'spec-hematology', name: 'Bone Marrow Biopsy Review', usd: 549, gbp: 345, aed: 870, egp: 14950, docFee: 2990 },
  { specialty: 'spec-hematology', name: 'Flow Cytometry Review', usd: 549, gbp: 335, aed: 850, egp: 13455, docFee: 2691 },
  { specialty: 'spec-hematology', name: 'Lymphoma Staging Review', usd: 549, gbp: 345, aed: 870, egp: 13455, docFee: 2691 },
  { specialty: 'spec-hematology', name: 'Anemia Workup Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-hematology', name: 'Thrombophilia Panel Review', usd: 499, gbp: 300, aed: 780, egp: 7475, docFee: 1495 },
  { specialty: 'spec-hematology', name: 'Sickle Cell/Thalassemia Review', usd: 379, gbp: 250, aed: 650, egp: 3680, docFee: 736 },
  { specialty: 'spec-hematology', name: 'Immunoglobulins/SPEP Review', usd: 499, gbp: 300, aed: 780, egp: 7475, docFee: 1495 },
];

// ─── Main ───────────────────────────────────────────────────

async function run() {
  console.log('[sync] Starting pricing sync v2...');
  console.log(`[sync] ${SPECIALTIES.length} specialties, ${SERVICES.length} services\n`);

  const canonicalSpecIds = new Set(SPECIALTIES.map(s => s.id));
  const canonicalServiceKeys = new Set(SERVICES.map(s => `${s.specialty}::${s.name}`));

  // 1. Ensure is_visible column exists on specialties
  await pool.query(`ALTER TABLE specialties ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT true`);

  // 2. Add unique constraint on services(specialty_id, name) if missing
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_services_specialty_name ON services(specialty_id, name)`);
  } catch (err) {
    // If duplicates exist, we need to clean them up first
    console.log('[sync] Removing duplicate services before adding unique constraint...');
    await pool.query(`
      DELETE FROM services WHERE id NOT IN (
        SELECT MIN(id) FROM services GROUP BY specialty_id, name
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_services_specialty_name ON services(specialty_id, name)`);
  }

  // 3. Upsert specialties
  let specInserted = 0;
  for (const spec of SPECIALTIES) {
    const res = await pool.query(`
      INSERT INTO specialties (id, name, is_visible)
      VALUES ($1, $2, true)
      ON CONFLICT (id) DO UPDATE SET name = $2, is_visible = true
    `, [spec.id, spec.name]);
    specInserted++;
  }
  console.log(`[sync] Specialties upserted: ${specInserted}`);

  // 4. Set visibility: canonical = true, everything else = false
  await pool.query(`UPDATE specialties SET is_visible = false`);
  const showSpecRes = await pool.query(`
    UPDATE specialties SET is_visible = true WHERE id = ANY($1::text[])
  `, [SPECIALTIES.map(s => s.id)]);
  console.log(`[sync] Specialties shown: ${showSpecRes.rowCount}, all others hidden`);

  // 5. Upsert services
  let svcUpserted = 0;
  const serviceIds = []; // track IDs of canonical services

  for (const svc of SERVICES) {
    const svcId = randomUUID();
    const res = await pool.query(`
      INSERT INTO services (id, specialty_id, name, base_price, doctor_fee, currency, sla_hours, is_visible)
      VALUES ($1, $2, $3, $4, $5, 'EGP', 72, true)
      ON CONFLICT (specialty_id, name)
      DO UPDATE SET base_price = $4, doctor_fee = $5, currency = 'EGP', sla_hours = 72, is_visible = true
      RETURNING id
    `, [svcId, svc.specialty, svc.name, svc.egp, svc.docFee]);

    serviceIds.push(res.rows[0].id);
    svcUpserted++;
  }
  console.log(`[sync] Services upserted: ${svcUpserted}`);

  // 6. Hide services NOT in the canonical list (services whose specialty+name combo is not canonical)
  const hideRes = await pool.query(`
    UPDATE services SET is_visible = false
    WHERE is_visible = true
      AND id != ALL($1::text[])
  `, [serviceIds]);
  console.log(`[sync] Services hidden: ${hideRes.rowCount}`);

  // 7. Upsert regional prices (US, UK, UAE)
  let pricesSet = 0;
  for (let i = 0; i < SERVICES.length; i++) {
    const svc = SERVICES[i];
    const svcId = serviceIds[i];

    const regions = [
      { code: 'US', price: svc.usd, currency: 'USD' },
      { code: 'GB', price: svc.gbp, currency: 'GBP' },
      { code: 'AE', price: svc.aed, currency: 'AED' },
    ];

    for (const r of regions) {
      await pool.query(`
        INSERT INTO service_regional_prices (id, service_id, country_code, currency, tashkheesa_price, doctor_commission, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (service_id, country_code)
        DO UPDATE SET tashkheesa_price = $5, currency = $4, doctor_commission = $6, status = 'active'
      `, [randomUUID(), svcId, r.code, r.currency, r.price, svc.docFee]);
      pricesSet++;
    }
  }
  console.log(`[sync] Regional prices set: ${pricesSet}`);

  // 8. Summary
  const totalVisible = await pool.query(`SELECT COUNT(*) as c FROM services WHERE is_visible = true`);
  const totalSpecs = await pool.query(`SELECT COUNT(*) as c FROM specialties WHERE is_visible = true`);
  console.log(`\n[sync] ✅ Done.`);
  console.log(`[sync] Visible specialties: ${totalSpecs.rows[0].c}`);
  console.log(`[sync] Visible services: ${totalVisible.rows[0].c}`);

  await pool.end();
}

run().catch((err) => {
  console.error('[sync] FATAL:', err);
  process.exit(1);
});
