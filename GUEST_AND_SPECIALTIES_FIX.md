# TWO QUICK FIXES — Guest Link Removal + Seed Specialties/Services

**Project root:** tashkheesa-portal

---

## FIX 1: Remove "Submit a case as guest" from login page

In `src/views/login.ejs`, find and DELETE this entire line (around line 76):

```ejs
<a href="/case/new"><%= tr('auth.login.guest_submit','Submit a case as guest','إرسال حالة كضيف') %></a>
```

Also in `src/server.js`, find the redirect route for `/case/new` and change it to redirect to `/login` instead of `/order/start`:

```javascript
app.get('/case/new', (req, res) => {
  return res.redirect('/login');
});
```

This way even if someone bookmarked `/case/new`, they'll be sent to login first.

---

## FIX 2: Seed production specialties and services

Create a new file `src/seed_specialties.js` that will be called once at server startup to ensure specialties and services exist. This uses INSERT OR IGNORE so it's safe to run repeatedly.

```javascript
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
```

Then in `src/server.js`, after the `migrate()` call (around line 1780, look for `try { migrate(); }`), add:

```javascript
// Ensure specialties and services are populated
try {
  const { seedSpecialtiesAndServices } = require('./seed_specialties');
  seedSpecialtiesAndServices();
} catch (err) {
  console.error('[seed] Failed to seed specialties:', err.message);
}
```

This goes AFTER `migrate()` but BEFORE the demo seed section.

---

## FIX 3: Ensure the new case form loads ALL services (not just first specialty)

In `src/routes/patient.js`, find the `GET /portal/patient/orders/new` route. Currently it only loads services for `selectedSpecialtyId`. The dropdown filtering is done client-side via `data-specialty` attribute on each `<option>`. So we should load ALL visible services, not just for one specialty.

Change the services query from:

```javascript
let services = [];
if (selectedSpecialtyId) {
  services = safeAll(
    (slaExpr) =>
      `SELECT sv.id, sv.specialty_id, sv.name, ...
       WHERE sv.specialty_id = ?
```

To load ALL services:

```javascript
const services = safeAll(
  (slaExpr) =>
    `SELECT sv.id, sv.specialty_id, sv.name,
            COALESCE(cp.tashkheesa_price, sv.base_price) AS base_price,
            COALESCE(cp.doctor_commission, sv.doctor_fee) AS doctor_fee,
            COALESCE(cp.currency, sv.currency) AS currency,
            sv.payment_link AS payment_link,
            ${slaExpr} AS sla_hours
     FROM services sv
     LEFT JOIN service_regional_prices cp
       ON cp.service_id = sv.id
      AND cp.country_code = ?
      AND COALESCE(cp.status, 'active') = 'active'
     WHERE ${servicesVisibleClause('sv')}
     ORDER BY sv.name ASC`,
  [countryCode]
);
```

Remove the `if (selectedSpecialtyId)` wrapper. The client-side JS in `public/js/patient_new_case.js` already filters the service dropdown based on the selected specialty using `data-specialty`.

---

## COMMIT

```
fix: remove guest case submission link, seed production specialties and services
```
