// src/seed_specialties.js
//
// ⚠️  WARNING: DO NOT CALL seedSpecialtiesAndServices() — it produces Catalog B.
//
// Catalog B (specialty_id values like 'spec-cardiology', 'spec-radiology', etc.)
// was deleted from production in April 2026 via scripts/delete_catalog_b.js.
// The call site in src/server.js is commented out for the same reason.
//
// The canonical catalog is Catalog A: lowercase specialty_ids ('cardiology',
// 'radiology', 'lab_pathology', ...) with stable service IDs ('card_echo',
// 'rad_mri_review', 'neuro_brain_ct', ...). It is seeded by src/db.js
// seedPricingData() and the pricing CSV under scripts/.
//
// If you need to add a new specialty/service, add it to the Catalog A source
// (src/db.js), NOT to this file. Reintroducing 'spec-' prefixed IDs will
// recreate the demo rows that were just deleted, and (because migration 011
// adds UNIQUE (specialty_id, name)) may also fail mid-boot if the rows are
// only partially deleted.
//
// This file is preserved (not deleted) only as a record of what the early
// development seed looked like. Safe to delete in a future cleanup once nobody
// needs the historical reference.
//
// Original header (kept for context):
//   Ensures all Tashkheesa specialties and services exist in the database.
//   Safe to run multiple times (INSERT ... ON CONFLICT (specialty_id, name) DO NOTHING).
//   IDs are deterministic: re-running the seeder against rows it already inserted
//   is a no-op, and rows seeded historically with random UUIDs are preserved
//   (ON CONFLICT inference targets the specialty_id+name UNIQUE constraint
//   added in migration 011, not the primary key).

const { execute, queryOne, withTransaction } = require('./pg');

async function seedSpecialtiesAndServices() {
  // ── Specialties ──
  const specialties = [
    { id: 'spec-radiology', name: 'Radiology' },
    { id: 'spec-cardiology', name: 'Cardiology' },
    { id: 'spec-orthopedics', name: 'Orthopedics' },
    { id: 'spec-neurology', name: 'Neurology' },
    { id: 'spec-dermatology', name: 'Dermatology' },
    { id: 'spec-pathology', name: 'Pathology' },
    { id: 'spec-oncology', name: 'Oncology' },
    { id: 'spec-pulmonology', name: 'Pulmonology' },
    { id: 'spec-gastroenterology', name: 'Gastroenterology' },
    { id: 'spec-endocrinology', name: 'Endocrinology' },
    { id: 'spec-urology', name: 'Urology' },
    { id: 'spec-ophthalmology', name: 'Ophthalmology' },
    { id: 'spec-ent', name: 'ENT (Ear, Nose & Throat)' },
    { id: 'spec-general-surgery', name: 'General Surgery' },
    { id: 'spec-pediatrics', name: 'Pediatrics' },
    { id: 'spec-internal-medicine', name: 'Internal Medicine' },
  ];

  // ── Services (sub-specialties / service types per specialty) ──
  // Each service has: specialty_id, name, base_price (EGP), doctor_fee (EGP), sla_hours, currency
  // The 20% commission rule: doctor_fee = base_price * 0.80
  const services = [
    // Radiology
    { specialty: 'spec-radiology', name: 'X-Ray Review', price: 500, sla: 72 },
    { specialty: 'spec-radiology', name: 'CT Scan Review', price: 800, sla: 72 },
    { specialty: 'spec-radiology', name: 'MRI Review', price: 1000, sla: 72 },
    { specialty: 'spec-radiology', name: 'Ultrasound Review', price: 500, sla: 72 },
    { specialty: 'spec-radiology', name: 'Mammogram Review', price: 700, sla: 72 },

    // Cardiology
    { specialty: 'spec-cardiology', name: 'ECG Review', price: 500, sla: 72 },
    { specialty: 'spec-cardiology', name: 'Echocardiogram Review', price: 800, sla: 72 },
    { specialty: 'spec-cardiology', name: 'Holter Monitor Review', price: 700, sla: 72 },
    { specialty: 'spec-cardiology', name: 'Cardiac Catheterization Review', price: 1200, sla: 72 },

    // Orthopedics
    { specialty: 'spec-orthopedics', name: 'Bone X-Ray Review', price: 500, sla: 72 },
    { specialty: 'spec-orthopedics', name: 'Joint MRI Review', price: 1000, sla: 72 },
    { specialty: 'spec-orthopedics', name: 'Spine MRI Review', price: 1000, sla: 72 },
    { specialty: 'spec-orthopedics', name: 'DEXA Scan Review', price: 600, sla: 72 },

    // Neurology
    { specialty: 'spec-neurology', name: 'Brain MRI Review', price: 1000, sla: 72 },
    { specialty: 'spec-neurology', name: 'EEG Review', price: 700, sla: 72 },
    { specialty: 'spec-neurology', name: 'Nerve Conduction Study Review', price: 800, sla: 72 },

    // Dermatology
    { specialty: 'spec-dermatology', name: 'Skin Biopsy Review', price: 600, sla: 72 },
    { specialty: 'spec-dermatology', name: 'Dermoscopy Image Review', price: 500, sla: 72 },

    // Pathology
    { specialty: 'spec-pathology', name: 'Blood Work Review', price: 400, sla: 48 },
    { specialty: 'spec-pathology', name: 'Biopsy / Histopathology Review', price: 900, sla: 72 },
    { specialty: 'spec-pathology', name: 'Tumor Marker Review', price: 600, sla: 72 },

    // Oncology
    { specialty: 'spec-oncology', name: 'PET Scan Review', price: 1500, sla: 72 },
    { specialty: 'spec-oncology', name: 'Oncology Case Review', price: 1200, sla: 72 },

    // Pulmonology
    { specialty: 'spec-pulmonology', name: 'Chest X-Ray Review', price: 500, sla: 72 },
    { specialty: 'spec-pulmonology', name: 'Chest CT Review', price: 800, sla: 72 },
    { specialty: 'spec-pulmonology', name: 'Pulmonary Function Test Review', price: 600, sla: 72 },

    // Gastroenterology
    { specialty: 'spec-gastroenterology', name: 'Abdominal Ultrasound Review', price: 500, sla: 72 },
    { specialty: 'spec-gastroenterology', name: 'Endoscopy Report Review', price: 700, sla: 72 },
    { specialty: 'spec-gastroenterology', name: 'Abdominal CT Review', price: 800, sla: 72 },

    // Endocrinology
    { specialty: 'spec-endocrinology', name: 'Thyroid Panel Review', price: 400, sla: 48 },
    { specialty: 'spec-endocrinology', name: 'Hormonal Profile Review', price: 500, sla: 72 },
    { specialty: 'spec-endocrinology', name: 'Thyroid Ultrasound Review', price: 500, sla: 72 },

    // Urology
    { specialty: 'spec-urology', name: 'Kidney Ultrasound Review', price: 500, sla: 72 },
    { specialty: 'spec-urology', name: 'Urinalysis Review', price: 300, sla: 48 },
    { specialty: 'spec-urology', name: 'PSA / Prostate Review', price: 500, sla: 72 },

    // Ophthalmology
    { specialty: 'spec-ophthalmology', name: 'Retinal Scan Review', price: 600, sla: 72 },
    { specialty: 'spec-ophthalmology', name: 'OCT Scan Review', price: 700, sla: 72 },

    // ENT
    { specialty: 'spec-ent', name: 'Audiogram Review', price: 400, sla: 72 },
    { specialty: 'spec-ent', name: 'Sinus CT Review', price: 700, sla: 72 },

    // General Surgery
    { specialty: 'spec-general-surgery', name: 'Pre-operative Assessment Review', price: 800, sla: 72 },
    { specialty: 'spec-general-surgery', name: 'Post-operative Imaging Review', price: 700, sla: 72 },

    // Pediatrics
    { specialty: 'spec-pediatrics', name: 'Pediatric X-Ray Review', price: 500, sla: 72 },
    { specialty: 'spec-pediatrics', name: 'Pediatric Blood Work Review', price: 400, sla: 48 },
    { specialty: 'spec-pediatrics', name: 'Growth & Development Review', price: 500, sla: 72 },

    // Internal Medicine
    { specialty: 'spec-internal-medicine', name: 'Comprehensive Blood Panel Review', price: 500, sla: 48 },
    { specialty: 'spec-internal-medicine', name: 'General Second Opinion', price: 600, sla: 72 },
    { specialty: 'spec-internal-medicine', name: 'Chronic Disease Management Review', price: 700, sla: 72 },
  ];

  // Check which columns exist on services table
  const colRows = await require('./pg').queryAll(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'services'`
  );
  const cols = colRows.map(c => c.column_name);
  const hasBasePrice = cols.includes('base_price');
  const hasDoctorFee = cols.includes('doctor_fee');
  const hasCurrency = cols.includes('currency');
  const hasSlaHours = cols.includes('sla_hours');
  const hasIsVisible = cols.includes('is_visible');

  try {
    await withTransaction(async (client) => {
      // Insert specialties
      for (const sp of specialties) {
        await client.query(
          'INSERT INTO specialties (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [sp.id, sp.name]
        );
      }

      // Build dynamic INSERT for services
      const svcCols = ['id', 'specialty_id', 'name'];
      if (hasBasePrice) svcCols.push('base_price');
      if (hasDoctorFee) svcCols.push('doctor_fee');
      if (hasCurrency) svcCols.push('currency');
      if (hasSlaHours) svcCols.push('sla_hours');
      if (hasIsVisible) svcCols.push('is_visible');

      for (const svc of services) {
        const doctorFee = Math.round(svc.price * 0.80); // 20% commission
        const stableId = 'svc-'
          + svc.specialty.toLowerCase().replace(/[^a-z0-9]/g, '-')
          + '-'
          + svc.name.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 30);
        const params = [stableId, svc.specialty, svc.name];
        if (hasBasePrice) params.push(svc.price);
        if (hasDoctorFee) params.push(doctorFee);
        if (hasCurrency) params.push('EGP');
        if (hasSlaHours) params.push(svc.sla);
        if (hasIsVisible) params.push(true);

        const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO services (${svcCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (specialty_id, name) DO NOTHING`,
          params
        );
      }
    });

    const specRow = await queryOne('SELECT COUNT(*) AS c FROM specialties');
    const svcRow = await queryOne('SELECT COUNT(*) AS c FROM services');
    console.log(`[seed] Specialties: ${specRow.c}, Services: ${svcRow.c}`);
  } catch (err) {
    console.error('[seed] Error seeding specialties/services:', err.message);
  }
}

module.exports = { seedSpecialtiesAndServices };
