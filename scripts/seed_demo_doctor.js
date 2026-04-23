#!/usr/bin/env node
/**
 * Idempotent seed for the marketing/demo doctor account.
 *
 *   Email: dr.ahmed@tashkheesas.com
 *   Password: DemoDoctor123!
 *
 * Running the script twice produces the same final state (no duplicates).
 * Only touches this doctor, the demo patient rows we create, and the
 * orders / order_events / reviews linked to those rows. All seeded row
 * IDs use deterministic prefixes (`doctor-demo-ahmed`, `patient-demo-ahmed-*`,
 * `order-demo-ahmed-*`, `evt-demo-ahmed-*`, `review-demo-ahmed-*`) so we can
 * wipe-and-rewrite child rows safely on every run.
 *
 * Usage:   node scripts/seed_demo_doctor.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DOCTOR_EMAIL = 'dr.ahmed@tashkheesas.com';
const DOCTOR_PASSWORD = 'DemoDoctor123!';
const DOCTOR_ID = 'doctor-demo-ahmed';
const ID_PREFIX = 'demo-ahmed';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' || !process.env.PG_SSL ? false : { rejectUnauthorized: false }
});

// ---- helpers ---------------------------------------------------------------

function hoursFromNow(h) { return new Date(Date.now() + h * 3600 * 1000); }
function daysAgo(d) { return new Date(Date.now() - d * 24 * 3600 * 1000); }
function at(iso) { return new Date(iso); }
function addHours(date, h) { return new Date(date.getTime() + h * 3600 * 1000); }

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return res.rowCount > 0;
}

async function tableExists(client, table) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return res.rowCount > 0;
}

async function lookupSpecialtyId(client) {
  // Prefer the id that matches services.specialty_id for cardiology, since
  // the dashboard joins services.service_id → services.specialty_id.
  const rows = (await client.query(
    "SELECT id FROM specialties WHERE LOWER(name)='cardiology' ORDER BY id"
  )).rows;
  if (!rows.length) throw new Error('No Cardiology specialty row found');
  // Prefer 'cardiology' over 'spec-cardiology' because services.specialty_id='cardiology'.
  const preferred = rows.find(r => r.id === 'cardiology');
  return (preferred || rows[0]).id;
}

async function resolveService(client, patternList) {
  // Returns the first services row whose name matches one of the case-insensitive
  // substrings, from an allow-list scoped to the given specialty.
  for (const pattern of patternList) {
    const r = await client.query(
      `SELECT id, name FROM services
        WHERE specialty_id IN ('cardiology','spec-cardiology')
          AND LOWER(name) LIKE LOWER($1)
        ORDER BY CASE WHEN specialty_id='cardiology' THEN 0 ELSE 1 END
        LIMIT 1`,
      ['%' + pattern + '%']
    );
    if (r.rows.length) return r.rows[0];
  }
  throw new Error('No matching cardiology service for patterns: ' + patternList.join(', '));
}

// ---- seed data -------------------------------------------------------------

// Patient roster. Each patient has a deterministic demo id so idempotency works.
// Age is stored via date_of_birth (text), gender via gender.
const PATIENTS = [
  // In-review
  { slug: 'mona-saad',        name: 'Mona Saad',        gender: 'F', age: 62 },
  { slug: 'khaled-mahmoud',   name: 'Khaled Mahmoud',   gender: 'M', age: 54 },
  { slug: 'laila-fawzy',      name: 'Laila Fawzy',      gender: 'F', age: 71 },
  // New assignments
  { slug: 'tamer-abdelaziz',  name: 'Tamer Abdel Aziz', gender: 'M', age: 48 },
  { slug: 'nour-elshazly',    name: 'Nour El-Shazly',   gender: 'F', age: 39 },
  // Completed this month (April 2026)
  { slug: 'hala-ibrahim',     name: 'Hala Ibrahim',     gender: 'F', age: 58 },
  { slug: 'mahmoud-farouk',   name: 'Mahmoud Farouk',   gender: 'M', age: 67 },
  { slug: 'rania-samir',      name: 'Rania Samir',      gender: 'F', age: 45 },
  { slug: 'omar-khalil',      name: 'Omar Khalil',      gender: 'M', age: 52 },
  { slug: 'samira-elmasry',   name: 'Samira El-Masry',  gender: 'F', age: 63 },
  { slug: 'amir-zaki',        name: 'Amir Zaki',        gender: 'M', age: 70 },
  { slug: 'dina-helmy',       name: 'Dina Helmy',       gender: 'F', age: 41 },
  { slug: 'youssef-nagy',     name: 'Youssef Nagy',     gender: 'M', age: 59 },
  // Older completed (Feb–Mar 2026)
  { slug: 'amr-shawky',       name: 'Amr Shawky',       gender: 'M', age: 55 },
  { slug: 'ingy-salah',       name: 'Ingy Salah',       gender: 'F', age: 48 },
  { slug: 'bassem-hosny',     name: 'Bassem Hosny',     gender: 'M', age: 63 },
  { slug: 'maha-gamal',       name: 'Maha Gamal',       gender: 'F', age: 50 },
  { slug: 'karim-ezz',        name: 'Karim Ezz',        gender: 'M', age: 44 },
  { slug: 'nada-elleithy',    name: 'Nada El-Leithy',   gender: 'F', age: 39 },
  { slug: 'hossam-abbas',     name: 'Hossam Abbas',     gender: 'M', age: 67 },
  { slug: 'salma-tawfik',     name: 'Salma Tawfik',     gender: 'F', age: 55 },
  { slug: 'mostafa-adel',     name: 'Mostafa Adel',     gender: 'M', age: 72 },
  { slug: 'farida-ragab',     name: 'Farida Ragab',     gender: 'F', age: 62 },
  { slug: 'yehia-labib',      name: 'Yehia Labib',      gender: 'M', age: 58 },
  { slug: 'noha-hashem',      name: 'Noha Hashem',      gender: 'F', age: 46 }
];

function patientId(slug) { return 'patient-' + ID_PREFIX + '-' + slug; }
function orderId(bucket, n) { return 'order-' + ID_PREFIX + '-' + bucket + '-' + String(n).padStart(2, '0'); }
function eventId(ordId, stage) { return 'evt-' + ID_PREFIX + '-' + ordId.replace('order-' + ID_PREFIX + '-', '') + '-' + stage; }
function reviewId(ordId) { return 'review-' + ID_PREFIX + '-' + ordId.replace('order-' + ID_PREFIX + '-', ''); }
function patientEmail(slug) { return 'p.' + ID_PREFIX + '.' + slug + '@demo.local'; }

// Deterministic birth-year derived from (age, slug) so reruns stay stable.
function dobFromAge(age, slug) {
  const today = new Date(); // Apr 23 2026 in the demo env
  // Use month/day derived from slug so every patient doesn't share a birthday.
  const h = slug.split('').reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 365, 0);
  const base = new Date(today.getFullYear() - age, 0, 1);
  base.setDate(base.getDate() + h);
  return base.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---- upserts ---------------------------------------------------------------

async function upsertDoctor(client, specialtyId) {
  const passwordHash = await bcrypt.hash(DOCTOR_PASSWORD, 10);
  const bio = 'Consultant cardiologist with over 15 years of experience in ' +
    'interventional cardiology and cardiac imaging. Fellowship trained at ' +
    'Cleveland Clinic. Specializes in complex coronary artery disease, ' +
    'structural heart interventions, and cardio-oncology. Committed to ' +
    'evidence-based second opinions that empower patients and their families.';

  // Probe for proposed migration-017 columns so the script doesn't fail on
  // older schemas. name_ar / bio_ar / sub_specialties / years_of_experience
  // land when migration 017 is applied.
  const hasNameAr = await columnExists(client, 'users', 'name_ar');
  const hasBioAr = await columnExists(client, 'users', 'bio_ar');

  const cols = [
    'id', 'email', 'password_hash', 'name', 'role', 'specialty_id', 'phone',
    'country_code', 'country', 'lang', 'date_of_birth', 'bio',
    'is_active', 'pending_approval', 'approved_at', 'onboarding_complete', 'created_at'
  ];
  const vals = [
    DOCTOR_ID, DOCTOR_EMAIL, passwordHash, 'Ahmed Hassan', 'doctor', specialtyId,
    '+20 100 123 4567', 'EG', 'EG', 'en', '1978-05-14', bio,
    true, false, new Date(), true, new Date()
  ];
  if (hasNameAr) { cols.push('name_ar'); vals.push('أحمد حسن'); }
  if (hasBioAr)  { cols.push('bio_ar');  vals.push('استشاري أمراض القلب مع أكثر من 15 عامًا من الخبرة في قسطرة القلب والتصوير القلبي.'); }

  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  const updates = cols.filter(c => c !== 'id' && c !== 'created_at')
    .map(c => c + ' = EXCLUDED.' + c).join(', ');

  await client.query(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    vals
  );

  // If a row already existed under the same email but a different id (possible
  // from a previous manual seed), align it to our deterministic id so the rest
  // of this seed lands cleanly.
  await client.query(
    `UPDATE users SET id = $1 WHERE email = $2 AND id <> $1`,
    [DOCTOR_ID, DOCTOR_EMAIL]
  ).catch(() => { /* email unique + id PK: another row with our id will block, but we just inserted ours above */ });

  // Mirror the specialty link through doctor_specialties (handler is resilient
  // to either, but some legacy filters lean on it).
  await client.query(
    `INSERT INTO doctor_specialties (id, doctor_id, specialty_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    ['ds-' + ID_PREFIX, DOCTOR_ID, specialtyId]
  );

  return { hasNameAr, hasBioAr };
}

async function upsertPatients(client) {
  let n = 0;
  for (const p of PATIENTS) {
    await client.query(
      `INSERT INTO users (id, email, name, role, gender, date_of_birth, country, country_code, lang, is_active, created_at)
       VALUES ($1, $2, $3, 'patient', $4, $5, 'EG', 'EG', 'en', true, NOW())
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         gender = EXCLUDED.gender,
         date_of_birth = EXCLUDED.date_of_birth`,
      [patientId(p.slug), patientEmail(p.slug), p.name, p.gender, dobFromAge(p.age, p.slug)]
    );
    n++;
  }
  return n;
}

async function clearDemoChildRows(client) {
  // Wipe children first so re-runs never orphan or duplicate:
  await client.query(
    `DELETE FROM order_events WHERE order_id LIKE 'order-' || $1 || '-%'`,
    [ID_PREFIX]
  );
  if (await tableExists(client, 'reviews')) {
    await client.query(
      `DELETE FROM reviews WHERE doctor_id = $1`,
      [DOCTOR_ID]
    );
  }
  if (await tableExists(client, 'doctor_assignments')) {
    await client.query(
      `DELETE FROM doctor_assignments WHERE case_id LIKE 'order-' || $1 || '-%'`,
      [ID_PREFIX]
    );
  }
}

async function upsertOrder(client, specialtyId, o) {
  // o: { id, patientSlug, serviceId, status, urgencyTier, urgencyFlag, urgent,
  //      createdAt, acceptedAt, completedAt, deadlineAt, breachedAt,
  //      doctorFee, price, slaHours, referenceId, clinicalQuestion, notes }
  const cols = [
    'id', 'patient_id', 'doctor_id', 'specialty_id', 'service_id', 'sla_hours',
    'status', 'language', 'urgency_flag', 'urgent', 'urgency_tier',
    'price', 'doctor_fee', 'currency',
    'created_at', 'updated_at', 'accepted_at', 'deadline_at', 'completed_at', 'breached_at',
    'reference_id', 'clinical_question', 'notes',
    'payment_status', 'source', 'country', 'tier'
  ];
  const vals = [
    o.id, patientId(o.patientSlug), DOCTOR_ID, specialtyId, o.serviceId, o.slaHours || 72,
    o.status, 'en', !!o.urgencyFlag, !!o.urgent, o.urgencyTier || 'standard',
    o.price, o.doctorFee, 'EGP',
    o.createdAt, o.completedAt || o.acceptedAt || o.createdAt, o.acceptedAt || null,
    o.deadlineAt || null, o.completedAt || null, o.breachedAt || null,
    o.referenceId, o.clinicalQuestion || null, o.notes || null,
    'paid', 'website_portal', 'EG', o.urgencyTier === 'fast_track' ? 'fast_track' : 'standard'
  ];
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  const updates = cols.filter(c => c !== 'id').map(c => c + ' = EXCLUDED.' + c).join(', ');
  await client.query(
    `INSERT INTO orders (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    vals
  );

  // Mirror into doctor_assignments for handlers that read from it.
  await client.query(
    `INSERT INTO doctor_assignments (id, case_id, doctor_id, assigned_at, accepted_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       assigned_at = EXCLUDED.assigned_at,
       accepted_at = EXCLUDED.accepted_at,
       completed_at = EXCLUDED.completed_at`,
    ['da-' + ID_PREFIX + '-' + o.id.replace('order-' + ID_PREFIX + '-', ''),
     o.id, DOCTOR_ID, o.createdAt, o.acceptedAt || null, o.completedAt || null]
  );
}

async function insertEvent(client, ordId, stage, label, at, actorRole = 'doctor', actorUserId = DOCTOR_ID, meta = null) {
  await client.query(
    `INSERT INTO order_events (id, order_id, label, at, actor_user_id, actor_role, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, at = EXCLUDED.at`,
    [eventId(ordId, stage), ordId, label, at, actorUserId, actorRole, meta ? JSON.stringify(meta) : null]
  );
}

async function insertReview(client, ordId, patientSlug, rating, text, createdAt) {
  await client.query(
    `INSERT INTO reviews (id, order_id, patient_id, doctor_id, rating, review_text, is_anonymous, is_visible, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, true, $7, $7)
     ON CONFLICT (id) DO UPDATE SET
       rating = EXCLUDED.rating,
       review_text = EXCLUDED.review_text,
       updated_at = EXCLUDED.updated_at`,
    [reviewId(ordId), ordId, patientId(patientSlug), DOCTOR_ID, rating, text, createdAt]
  );
}

// ---- main ------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (in .env)');
  }

  const client = await pool.connect();
  const counts = { users: 0, patients: 0, orders: 0, events: 0, reviews: 0, doctorAssignments: 0 };
  const report = { missingColumns: [], missingTables: [] };

  try {
    await client.query('BEGIN');

    const specialtyId = await lookupSpecialtyId(client);

    const { hasNameAr, hasBioAr } = await upsertDoctor(client, specialtyId);
    counts.users = 1;
    if (!hasNameAr) report.missingColumns.push('users.name_ar (migration 017 not applied)');
    if (!hasBioAr)  report.missingColumns.push('users.bio_ar (migration 017 not applied)');
    if (!(await columnExists(client, 'users', 'sub_specialties')))     report.missingColumns.push('users.sub_specialties (migration 017 not applied)');
    if (!(await columnExists(client, 'users', 'years_of_experience'))) report.missingColumns.push('users.years_of_experience (migration 017 not applied)');

    counts.patients = await upsertPatients(client);

    await clearDemoChildRows(client);

    // Resolve the real cardiology service IDs we need from the DB.
    const svcCtca     = await resolveService(client, ['Coronary Angiography', 'Cardiac CT', 'CTCA']);
    const svcEcho     = await resolveService(client, ['Echocardiogram', 'Echo Review']);
    const svcPreop    = await resolveService(client, ['Pre-Op', 'Pre-operative', 'Pre-Operative']);
    const svcStress   = await resolveService(client, ['Stress Treadmill', 'Stress Test', 'Stress Echo']);
    const svcHolter   = await resolveService(client, ['Holter']);
    const svcCmr      = await resolveService(client, ['Cardiac MR', 'CMR']);
    const svcStressE  = await resolveService(client, ['Stress Echo']);
    const svcCalc     = await resolveService(client, ['Calcium Score']);

    // ---------------- IN-REVIEW (3) ----------------
    // Hours tuned to produce the SLA colour bands used by the dashboard:
    //   onTrack > 48h (green), warn 24–48h (amber), urgent < 24h (red).
    const nowIso = new Date();
    const inReview = [
      {
        id: orderId('review', 1),
        patientSlug: 'mona-saad',
        service: svcCtca,
        urgencyTier: 'standard', urgencyFlag: false, urgent: false,
        createdAt: daysAgo(2),
        acceptedAt: daysAgo(1),
        deadlineAt: hoursFromNow(52),     // green band
        slaHours: 72,
        doctorFee: 1700, price: 7935,
        referenceId: 'TSH-2026-DEMO-R01',
        clinicalQuestion: 'Need a second opinion on CT coronary angiography findings — mild plaque burden vs. obstructive disease?',
        notes: 'Prior TTE 2024 unremarkable. Typical anginal symptoms on exertion for 6 weeks.'
      },
      {
        id: orderId('review', 2),
        patientSlug: 'khaled-mahmoud',
        service: svcEcho,
        urgencyTier: 'fast_track', urgencyFlag: true, urgent: false,
        createdAt: daysAgo(3),
        acceptedAt: daysAgo(2),
        deadlineAt: hoursFromNow(36),     // amber band
        slaHours: 48,
        doctorFee: 550, price: 1380,
        referenceId: 'TSH-2026-DEMO-R02',
        clinicalQuestion: 'Confirm LV systolic function and valve assessment on transthoracic echo.',
        notes: 'Referred post-MI rehab. Routine follow-up imaging.'
      },
      {
        id: orderId('review', 3),
        patientSlug: 'laila-fawzy',
        service: svcPreop,
        urgencyTier: 'fast_track', urgencyFlag: true, urgent: true,
        createdAt: daysAgo(1),
        acceptedAt: new Date(),
        deadlineAt: hoursFromNow(6),      // red band
        slaHours: 24,
        doctorFee: 2200, price: 4500,
        referenceId: 'TSH-2026-DEMO-R03',
        clinicalQuestion: 'Pre-operative cardiac clearance for planned hip replacement — HTN, prior PCI 2021.',
        notes: 'Surgery scheduled 48h. Requires ASA/clopidogrel guidance.'
      }
    ];
    for (const o of inReview) {
      await upsertOrder(client, specialtyId, { ...o, status: 'in_review', serviceId: o.service.id });
      counts.orders++;
      counts.doctorAssignments++;
      await insertEvent(client, o.id, 'created',   'Order created by patient', o.createdAt, 'patient', patientId(o.patientSlug));
      await insertEvent(client, o.id, 'accepted',  'doctor_accepted',          o.acceptedAt);
      counts.events += 2;
    }

    // ---------------- NEW ASSIGNMENTS (2) ----------------
    const newAssigned = [
      {
        id: orderId('new', 1),
        patientSlug: 'tamer-abdelaziz',
        service: svcStress,
        urgencyTier: 'standard', urgencyFlag: false, urgent: false,
        createdAt: hoursFromNow(-4),
        doctorFee: 400, price: 1553,
        referenceId: 'TSH-2026-DEMO-N01',
        clinicalQuestion: 'Interpret treadmill stress test — atypical chest pain, low-intermediate risk.'
      },
      {
        id: orderId('new', 2),
        patientSlug: 'nour-elshazly',
        service: svcHolter,
        urgencyTier: 'standard', urgencyFlag: false, urgent: false,
        createdAt: hoursFromNow(-2),
        doctorFee: 700, price: 3450,
        referenceId: 'TSH-2026-DEMO-N02',
        clinicalQuestion: 'Evaluate 48h Holter for paroxysmal palpitations — rule out SVT.'
      }
    ];
    for (const o of newAssigned) {
      await upsertOrder(client, specialtyId, {
        ...o, status: 'assigned', serviceId: o.service.id,
        acceptedAt: null, completedAt: null, breachedAt: null,
        deadlineAt: addHours(o.createdAt, 72), slaHours: 72
      });
      counts.orders++;
      counts.doctorAssignments++;
      await insertEvent(client, o.id, 'created', 'Order created by patient', o.createdAt, 'patient', patientId(o.patientSlug));
      counts.events++;
    }

    // ---------------- COMPLETED THIS MONTH (8) ----------------
    // Spread completed_at across April 2026. Sum of doctor_fee targets ~15–20k EGP.
    // One case has breached_at set → ~87.5% SLA compliance (7/8).
    const thisMonth = [
      { slug: 'hala-ibrahim',   service: svcCtca,    day:  3, turnaroundH: 34, fee: 1800, price: 7935 },
      { slug: 'mahmoud-farouk', service: svcEcho,    day:  6, turnaroundH: 28, fee: 1600, price: 1380 },
      { slug: 'rania-samir',    service: svcCmr,     day:  9, turnaroundH: 44, fee: 2400, price: 8395 },
      { slug: 'omar-khalil',    service: svcStressE, day: 12, turnaroundH: 30, fee: 2000, price: 2070 },
      { slug: 'samira-elmasry', service: svcHolter,  day: 14, turnaroundH: 36, fee: 2100, price: 3450 },
      // Breached case — completed after the deadline window.
      { slug: 'amir-zaki',      service: svcPreop,   day: 17, turnaroundH: 60, fee: 2500, price: 4500, breached: true },
      { slug: 'dina-helmy',     service: svcCalc,    day: 19, turnaroundH: 32, fee: 1400, price: 3680 },
      { slug: 'youssef-nagy',   service: svcCtca,    day: 22, turnaroundH: 38, fee: 1900, price: 7935 }
    ];
    let cthisN = 0;
    for (const row of thisMonth) {
      cthisN++;
      const completedAt = at('2026-04-' + String(row.day).padStart(2,'0') + 'T14:00:00');
      const createdAt   = addHours(completedAt, -(row.turnaroundH + 8));
      const acceptedAt  = addHours(createdAt, 3);
      const deadlineAt  = addHours(createdAt, row.service.id === 'card_preop_clearance' ? 48 : 72);
      const id = orderId('cthis', cthisN);
      await upsertOrder(client, specialtyId, {
        id, patientSlug: row.slug, serviceId: row.service.id,
        status: 'completed', urgencyTier: 'standard', urgencyFlag: false, urgent: false,
        createdAt, acceptedAt, deadlineAt,
        completedAt,
        breachedAt: row.breached ? addHours(deadlineAt, 2) : null,
        doctorFee: row.fee, price: row.price, slaHours: 72,
        referenceId: 'TSH-2026-DEMO-C' + String(cthisN).padStart(2, '0')
      });
      counts.orders++;
      counts.doctorAssignments++;
      await insertEvent(client, id, 'created',     'Order created by patient', createdAt, 'patient', patientId(row.slug));
      await insertEvent(client, id, 'accepted',    'doctor_accepted',          acceptedAt);
      await insertEvent(client, id, 'diagnosis',   'doctor_diagnosis_saved',   addHours(acceptedAt, Math.max(4, Math.floor(row.turnaroundH / 3))));
      if (row.breached) {
        await insertEvent(client, id, 'breached',  'SLA breached',             addHours(deadlineAt, 1), 'system', null);
      }
      await insertEvent(client, id, 'report',      'report_completed',         completedAt);
      await insertEvent(client, id, 'closed',      'order_completed',          addHours(completedAt, 1));
      counts.events += row.breached ? 6 : 5;
    }

    // ---------------- OLDER COMPLETED (12 — Feb & Mar 2026) ----------------
    const older = [
      { slug: 'amr-shawky',    service: svcEcho,    date: '2026-03-28T16:00:00', turnaroundH: 30, fee: 1500, price: 1380 },
      { slug: 'ingy-salah',    service: svcCtca,    date: '2026-03-22T13:00:00', turnaroundH: 36, fee: 1700, price: 7935 },
      { slug: 'bassem-hosny',  service: svcStress,  date: '2026-03-17T15:00:00', turnaroundH: 28, fee: 1500, price: 1553 },
      { slug: 'maha-gamal',    service: svcCmr,     date: '2026-03-11T14:00:00', turnaroundH: 42, fee: 2200, price: 8395 },
      { slug: 'karim-ezz',     service: svcEcho,    date: '2026-03-05T12:00:00', turnaroundH: 34, fee: 1600, price: 1380 },
      { slug: 'nada-elleithy', service: svcHolter,  date: '2026-02-27T16:00:00', turnaroundH: 30, fee: 1800, price: 3450 },
      { slug: 'hossam-abbas',  service: svcPreop,   date: '2026-02-22T13:00:00', turnaroundH: 44, fee: 2400, price: 4500 },
      { slug: 'salma-tawfik',  service: svcCalc,    date: '2026-02-17T11:00:00', turnaroundH: 26, fee: 1400, price: 3680 },
      { slug: 'mostafa-adel',  service: svcCtca,    date: '2026-02-12T14:00:00', turnaroundH: 40, fee: 1900, price: 7935 },
      { slug: 'farida-ragab',  service: svcStressE, date: '2026-02-08T15:00:00', turnaroundH: 32, fee: 1800, price: 2070 },
      { slug: 'yehia-labib',   service: svcEcho,    date: '2026-03-19T10:00:00', turnaroundH: 36, fee: 1500, price: 1380 },
      { slug: 'noha-hashem',   service: svcCmr,     date: '2026-03-01T12:00:00', turnaroundH: 38, fee: 2200, price: 8395 }
    ];
    let coldN = 0;
    for (const row of older) {
      coldN++;
      const completedAt = at(row.date);
      const createdAt   = addHours(completedAt, -(row.turnaroundH + 8));
      const acceptedAt  = addHours(createdAt, 4);
      const deadlineAt  = addHours(createdAt, 72);
      const id = orderId('cold', coldN);
      await upsertOrder(client, specialtyId, {
        id, patientSlug: row.slug, serviceId: row.service.id,
        status: 'completed', urgencyTier: 'standard', urgencyFlag: false, urgent: false,
        createdAt, acceptedAt, deadlineAt,
        completedAt, breachedAt: null,
        doctorFee: row.fee, price: row.price, slaHours: 72,
        referenceId: 'TSH-2026-DEMO-H' + String(coldN).padStart(2, '0')
      });
      counts.orders++;
      counts.doctorAssignments++;
      await insertEvent(client, id, 'created',   'Order created by patient', createdAt, 'patient', patientId(row.slug));
      await insertEvent(client, id, 'accepted',  'doctor_accepted',          acceptedAt);
      await insertEvent(client, id, 'diagnosis', 'doctor_diagnosis_saved',   addHours(acceptedAt, Math.max(4, Math.floor(row.turnaroundH / 3))));
      await insertEvent(client, id, 'report',    'report_completed',         completedAt);
      await insertEvent(client, id, 'closed',    'order_completed',          addHours(completedAt, 1));
      counts.events += 5;
    }

    // ---------------- REVIEWS (7) ----------------
    // Seed against completed orders only. Mix EN/AR, 5 & 4 stars.
    if (await tableExists(client, 'reviews')) {
      const reviewSeeds = [
        { ord: orderId('cthis', 1), slug: 'hala-ibrahim',   rating: 5, text: 'Extremely thorough review of my CT coronary angiogram. Dr. Ahmed explained everything in clear, practical terms and gave me confidence in the next steps.', daysOffsetAfter: 1 },
        { ord: orderId('cthis', 3), slug: 'rania-samir',    rating: 5, text: 'تقرير ممتاز وواضح جدًا. د. أحمد شرح كل النقاط المهمة بصبر وساعدني أفهم حالتي بدون قلق.', daysOffsetAfter: 2 },
        { ord: orderId('cthis', 5), slug: 'samira-elmasry', rating: 5, text: 'Fast, professional, and compassionate. His Holter interpretation caught a detail my local doctor missed.', daysOffsetAfter: 1 },
        { ord: orderId('cold',  1), slug: 'amr-shawky',     rating: 5, text: 'Second opinion worth every pound. The echo report came back with a clear plan and referral pathway.', daysOffsetAfter: 3 },
        { ord: orderId('cold',  4), slug: 'maha-gamal',     rating: 4, text: 'تقرير جيد جدًا وتفسير مفصل للـ MRI. كنت أتمنى لو كان أسرع قليلاً لكن النتيجة كانت مفيدة.', daysOffsetAfter: 2 },
        { ord: orderId('cold',  7), slug: 'hossam-abbas',   rating: 5, text: 'Pre-op clearance was handled with real care. Clear risk stratification and practical recommendations for surgery.', daysOffsetAfter: 2 },
        { ord: orderId('cold', 11), slug: 'yehia-labib',    rating: 4, text: 'Solid review with helpful recommendations. Very responsive to follow-up questions.', daysOffsetAfter: 3 }
      ];
      for (const r of reviewSeeds) {
        const baseRow = (await client.query('SELECT completed_at FROM orders WHERE id = $1', [r.ord])).rows[0];
        const createdAt = baseRow && baseRow.completed_at
          ? new Date(new Date(baseRow.completed_at).getTime() + r.daysOffsetAfter * 86400000)
          : new Date();
        await insertReview(client, r.ord, r.slug, r.rating, r.text, createdAt);
        counts.reviews++;
      }
    } else {
      report.missingTables.push('reviews');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('\n✅ Seed complete for ' + DOCTOR_EMAIL + '\n');
  console.log('Rows seeded:');
  console.log('  users (doctor):        ' + counts.users);
  console.log('  users (patients):      ' + counts.patients);
  console.log('  orders:                ' + counts.orders);
  console.log('  order_events:          ' + counts.events);
  console.log('  doctor_assignments:    ' + counts.doctorAssignments);
  console.log('  reviews:               ' + counts.reviews);
  if (report.missingColumns.length) {
    console.log('\n⚠️  Columns skipped (schema gap):');
    report.missingColumns.forEach(c => console.log('   - ' + c));
  }
  if (report.missingTables.length) {
    console.log('\n⚠️  Tables skipped (not found):');
    report.missingTables.forEach(t => console.log('   - ' + t));
  }
  console.log('\nLogin:');
  console.log('  Email:    ' + DOCTOR_EMAIL);
  console.log('  Password: ' + DOCTOR_PASSWORD);
  console.log('  Dashboard: http://localhost:3000/portal/doctor/dashboard');
}

main()
  .then(() => pool.end())
  .catch(err => {
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    pool.end();
    process.exit(1);
  });
