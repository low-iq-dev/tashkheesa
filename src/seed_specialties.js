// src/seed_specialties.js
// Ensures all Tashkheesa specialties and services exist in the database.
// Safe to run multiple times (INSERT OR IGNORE).

const { db } = require('./db');
const { randomUUID } = require('crypto');

function seedSpecialtiesAndServices() {
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

  const insertSpecialty = db.prepare(
    'INSERT OR IGNORE INTO specialties (id, name) VALUES (?, ?)'
  );

  // Check which columns exist on services
  const cols = db.prepare("PRAGMA table_info(services)").all().map(c => c.name);
  const hasBasePrice = cols.includes('base_price');
  const hasDoctorFee = cols.includes('doctor_fee');
  const hasCurrency = cols.includes('currency');
  const hasSlaHours = cols.includes('sla_hours');
  const hasIsVisible = cols.includes('is_visible');

  // Build dynamic INSERT for services
  const svcCols = ['id', 'specialty_id', 'name'];
  const svcPlaceholders = ['?', '?', '?'];
  if (hasBasePrice) { svcCols.push('base_price'); svcPlaceholders.push('?'); }
  if (hasDoctorFee) { svcCols.push('doctor_fee'); svcPlaceholders.push('?'); }
  if (hasCurrency) { svcCols.push('currency'); svcPlaceholders.push('?'); }
  if (hasSlaHours) { svcCols.push('sla_hours'); svcPlaceholders.push('?'); }
  if (hasIsVisible) { svcCols.push('is_visible'); svcPlaceholders.push('?'); }

  const insertService = db.prepare(
    `INSERT OR IGNORE INTO services (${svcCols.join(', ')}) VALUES (${svcPlaceholders.join(', ')})`
  );

  const tx = db.transaction(() => {
    // Insert specialties
    for (const sp of specialties) {
      insertSpecialty.run(sp.id, sp.name);
    }

    // Insert services
    for (const svc of services) {
      const doctorFee = Math.round(svc.price * 0.80); // 20% commission
      const params = [randomUUID(), svc.specialty, svc.name];
      if (hasBasePrice) params.push(svc.price);
      if (hasDoctorFee) params.push(doctorFee);
      if (hasCurrency) params.push('EGP');
      if (hasSlaHours) params.push(svc.sla);
      if (hasIsVisible) params.push(1);
      insertService.run(...params);
    }
  });

  try {
    tx();
    const specCount = db.prepare('SELECT COUNT(*) as c FROM specialties').get().c;
    const svcCount = db.prepare('SELECT COUNT(*) as c FROM services').get().c;
    console.log(`[seed] Specialties: ${specCount}, Services: ${svcCount}`);
  } catch (err) {
    console.error('[seed] Error seeding specialties/services:', err.message);
  }
}

module.exports = { seedSpecialtiesAndServices };
