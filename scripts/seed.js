require('dotenv').config();

const { db, migrate } = require('../src/db');
const { hash } = require('../src/auth');
const dayjs = require('dayjs');
const { randomUUID } = require('crypto');

function seed() {
  console.log('Running migrations...');
  migrate();

  console.log('Clearing existing data...');
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM order_additional_files;
    DELETE FROM order_events;
    DELETE FROM orders;
    DELETE FROM services;
    DELETE FROM specialties;
    DELETE FROM users;
  `);

  // ----- Specialties -----
  console.log('Inserting specialties...');
  const specialties = [
    { id: 'radiology', name: 'Radiology' },
    { id: 'pathology', name: 'Pathology' },
    { id: 'cardiology', name: 'Cardiology' },
    { id: 'neurology', name: 'Neurology' },
    { id: 'oncology', name: 'Oncology' },
    { id: 'orthopedics', name: 'Orthopedics' },
    { id: 'gastroenterology', name: 'Gastroenterology' },
    { id: 'dermatology', name: 'Dermatology' }
  ];

  const insertSpecialty = db.prepare(`INSERT INTO specialties (id, name) VALUES (?, ?)`);
  specialties.forEach(s => insertSpecialty.run(s.id, s.name));

  // ----- Services -----
  console.log('Inserting services...');
  const services = [
    { id: 'rad-ct-head', specialty_id: 'radiology', code: 'RAD-CT-HEAD', name: 'CT Head / Brain' },
    { id: 'rad-mri-brain', specialty_id: 'radiology', code: 'RAD-MRI-BRAIN', name: 'MRI Brain' },
    { id: 'rad-ct-chest', specialty_id: 'radiology', code: 'RAD-CT-CHEST', name: 'CT Chest' },
    { id: 'rad-mri-spine', specialty_id: 'radiology', code: 'RAD-MRI-SPINE', name: 'MRI Spine' },
    { id: 'rad-xray-chest', specialty_id: 'radiology', code: 'RAD-XRAY-CHEST', name: 'Chest X-Ray' },
    { id: 'card-echo', specialty_id: 'cardiology', code: 'CARD-ECHO', name: 'Echocardiogram' },
    { id: 'card-ekg', specialty_id: 'cardiology', code: 'CARD-EKG', name: 'Electrocardiogram' },
    { id: 'card-stress', specialty_id: 'cardiology', code: 'CARD-STRESS', name: 'Stress Test' },
    { id: 'neuro-ct-spine', specialty_id: 'neurology', code: 'NEURO-CT-SPINE', name: 'CT Spine' },
    { id: 'neuro-eeg', specialty_id: 'neurology', code: 'NEURO-EEG', name: 'EEG' },
    { id: 'onco-ct-chest', specialty_id: 'oncology', code: 'ONCO-CT-CHEST', name: 'CT Chest (Oncology)' },
    { id: 'onco-pet', specialty_id: 'oncology', code: 'ONCO-PET', name: 'PET Scan' },
    { id: 'ortho-xray-limb', specialty_id: 'orthopedics', code: 'ORTHO-XRAY-LIMB', name: 'Limb X-Ray' },
    { id: 'ortho-mri-joint', specialty_id: 'orthopedics', code: 'ORTHO-MRI-JOINT', name: 'Joint MRI' },
    { id: 'gi-endoscopy', specialty_id: 'gastroenterology', code: 'GI-ENDOSCOPY', name: 'Upper Endoscopy' },
    { id: 'gi-colonoscopy', specialty_id: 'gastroenterology', code: 'GI-COLONOSCOPY', name: 'Colonoscopy' },
    { id: 'derm-biopsy', specialty_id: 'dermatology', code: 'DERM-BIOPSY', name: 'Skin Biopsy' },
    { id: 'derm-lesion', specialty_id: 'dermatology', code: 'DERM-LESION', name: 'Lesion Analysis' }
  ];

  const insertService = db.prepare(`INSERT INTO services (id, specialty_id, code, name) VALUES (?, ?, ?, ?)`);
  services.forEach(s => insertService.run(s.id, s.specialty_id, s.code, s.name));

  // ----- Users -----
  console.log('Inserting users...');

  const insertUser = db.prepare(`INSERT INTO users (id, email, password_hash, name, role, specialty_id, lang) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const superPass = hash('SuperAdmin123!');
  const adminPass = hash('Admin123!');
  const doctorPass = hash('Doctor123!');
  const patientPass = hash('Client123!');

  // FIXED IDs
  const patient = {
    id: 'patient-fixed-id-123456789',
    email: 'client@demo.com',
    password_hash: patientPass,
    name: 'Demo Patient',
    role: 'patient',
    specialty_id: null,
    lang: 'en'
  };

  const doctor = {
    id: 'doctor-fixed-id-123456789',
    email: 'dr.radiology@tashkheesa.com',
    password_hash: doctorPass,
    name: 'Dr Radiology Demo',
    role: 'doctor',
    specialty_id: 'radiology',
    lang: 'en'
  };

  // Insert patient and doctor
  insertUser.run(patient.id, patient.email, patient.password_hash, patient.name, patient.role, patient.specialty_id, patient.lang);
  insertUser.run(doctor.id, doctor.email, doctor.password_hash, doctor.name, doctor.role, doctor.specialty_id, doctor.lang);

  // Other users
  const otherUsers = [
    { id: randomUUID(), email: 'ziad.wahsh@shifaegypt.com', password_hash: superPass, name: 'Ziad El Wahsh', role: 'superadmin', specialty_id: null, lang: 'en' },
    { id: randomUUID(), email: 'zmelwahsh@gmail.com', password_hash: superPass, name: 'Ziad El Wahsh (Alt)', role: 'superadmin', specialty_id: null, lang: 'en' },
    { id: randomUUID(), email: 'admin@tashkheesa.com', password_hash: adminPass, name: 'Portal Admin', role: 'admin', specialty_id: null, lang: 'en' },
    { id: randomUUID(), email: 'dr.cardio@tashkheesa.com', password_hash: doctorPass, name: 'Dr Cardiology', role: 'doctor', specialty_id: 'cardiology', lang: 'en' },
    { id: randomUUID(), email: 'dr.neuro@tashkheesa.com', password_hash: doctorPass, name: 'Dr Neurology', role: 'doctor', specialty_id: 'neurology', lang: 'en' }
  ];

  otherUsers.forEach(u => insertUser.run(u.id, u.email, u.password_hash, u.name, u.role, u.specialty_id, u.lang));

  // ----- Demo orders - CREATE 100+ ORDERS -----
  console.log('Inserting 100+ demo orders...');

  const SLA_VIP = 24;
  const SLA_STANDARD = 72;
  const SLA_URGENT = 12;

  const now = dayjs();
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, patient_id, doctor_id, specialty_id, service_id,
      sla_hours, status, price, doctor_fee,
      created_at, updated_at, accepted_at, deadline_at,
      completed_at, breached_at, reassigned_count,
      report_url, notes, uploads_locked, additional_files_requested
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvent = db.prepare(`INSERT INTO order_events (id, order_id, label, meta) VALUES (?, ?, ?, ?)`);

  const statuses = ['submitted', 'assigned', 'accepted', 'in_progress', 'completed', 'cancelled'];
  const specialtiesList = ['radiology', 'cardiology', 'neurology', 'oncology', 'orthopedics', 'gastroenterology', 'dermatology'];

  let orderCount = 0;

  // Create 100+ orders with different statuses and dates
  for (let i = 1; i <= 120; i++) {
    const orderId = `order-${i}-fixed-id-${Date.now()}`;
    const daysAgo = Math.floor(Math.random() * 30); // Random days ago (0-30 days)
    const hoursAgo = Math.floor(Math.random() * 24); // Random hours ago
    
    const created = now.subtract(daysAgo, 'day').subtract(hoursAgo, 'hour');
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    
    let accepted = null;
    let completed = null;
    let deadline = null;
    let doctorId = null;
    
    // Only assign doctor and dates if order is beyond submitted status
    if (status !== 'submitted') {
      doctorId = doctor.id;
      accepted = created.add(Math.floor(Math.random() * 6), 'hour');
      
      const slaType = Math.random() > 0.7 ? SLA_VIP : (Math.random() > 0.5 ? SLA_URGENT : SLA_STANDARD);
      deadline = accepted.add(slaType, 'hour');
      
      if (status === 'completed') {
        completed = accepted.add(Math.floor(Math.random() * 48), 'hour');
      }
    }

    const specialty = specialtiesList[Math.floor(Math.random() * specialtiesList.length)];
    const serviceForSpecialty = services.filter(s => s.specialty_id === specialty);
    const service = serviceForSpecialty[Math.floor(Math.random() * serviceForSpecialty.length)];

    const price = status === 'completed' ? 
      (Math.random() > 0.7 ? 2500 : (Math.random() > 0.5 ? 1800 : 1200)) : 
      (Math.random() > 0.7 ? 2000 : (Math.random() > 0.5 ? 1500 : 1000));

    const doctorFee = price * 0.6;

    insertOrder.run(
      orderId,
      patient.id, // Always our demo patient
      doctorId,
      specialty,
      service.id,
      status !== 'submitted' ? (Math.random() > 0.7 ? SLA_VIP : (Math.random() > 0.5 ? SLA_URGENT : SLA_STANDARD)) : SLA_STANDARD,
      status,
      price,
      doctorFee,
      created.toISOString(),
      completed ? completed.toISOString() : created.toISOString(),
      accepted ? accepted.toISOString() : null,
      deadline ? deadline.toISOString() : null,
      completed ? completed.toISOString() : null,
      null,
      0,
      status === 'completed' ? `https://example.com/report/order-${i}-demo.pdf` : null,
      `${service.name} - ${specialty} case #${i}. ${status !== 'submitted' ? 'Doctor review in progress.' : 'Awaiting assignment.'}`,
      status !== 'submitted' ? 1 : 0,
      0
    );

    // Add events based on status
    insertEvent.run(randomUUID(), orderId, 'Order submitted', null);
    
    if (status !== 'submitted') {
      insertEvent.run(randomUUID(), orderId, `Assigned to ${doctor.name}`, null);
      insertEvent.run(randomUUID(), orderId, 'Accepted by doctor', null);
      
      if (status === 'completed') {
        insertEvent.run(randomUUID(), orderId, 'Completed by doctor', null);
      } else if (status === 'in_progress') {
        insertEvent.run(randomUUID(), orderId, 'Analysis in progress', null);
      }
    }

    orderCount++;
    
    // Progress indicator
    if (i % 20 === 0) {
      console.log(`   Created ${i} orders...`);
    }
  }

  console.log(`✅ Seed completed successfully!`);
  console.log(`📋 Demo patient: ${patient.email} ID: ${patient.id}`);
  console.log(`📦 Total orders created: ${orderCount}`);
  console.log(`🎯 Orders should now appear in the dashboard!`);
}

seed();