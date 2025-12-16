/**
 * Demo data seeder for Tashkheesa Portal (schema-aligned version).
 * Works with actual `orders` schema in ./data/portal.db.
 * Note: demo user credentials are maintained in scripts/reset_demo_users.js
 * (single source of truth for passwords). Run that script to refresh logins.
 */
require('dotenv').config();
const { db, migrate } = require('../src/db');
const { randomUUID } = require('crypto');

const specialtySeeds = [
  { id: 'radiology', name: 'Radiology' },
  { id: 'cardiology', name: 'Cardiology' },
  { id: 'orthopedics', name: 'Orthopedics' },
  { id: 'gastroenterology', name: 'Gastroenterology' },
  { id: 'dermatology', name: 'Dermatology' },
  { id: 'neurology', name: 'Neurology' }
];

function ensurePatient() {
  const email = 'client@demo.com';
  const existing = db
    .prepare("SELECT * FROM users WHERE email = ? AND role = 'patient'")
    .get(email);
  if (existing) return existing;

  const p = {
    id: randomUUID(),
    name: 'Demo Patient',
    email,
    role: 'patient',
    password_hash: '',
    created_at: new Date().toISOString()
  };

  db.prepare(
    `INSERT INTO users (id, name, email, role, password_hash, created_at)
     VALUES (@id, @name, @email, @role, @password_hash, @created_at)`
  ).run(p);

  return p;
}

function ensureDoctor() {
  const email = 'dr.radiology@tashkheesa.com';
  const existing = db
    .prepare("SELECT * FROM users WHERE email = ? AND role = 'doctor'")
    .get(email);
  if (existing) return existing;

  const d = {
    id: randomUUID(),
    name: 'Dr Radiology Demo',
    email,
    role: 'doctor',
    password_hash: '',
    created_at: new Date().toISOString()
  };

  db.prepare(
    `INSERT INTO users (id, name, email, role, password_hash, created_at)
     VALUES (@id, @name, @email, @role, @password_hash, @created_at)`
  ).run(d);

  return d;
}

function ensureSpecialties() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO specialties (id, name) VALUES (?, ?)'
  );
  specialtySeeds.forEach((s) => insert.run(s.id, s.name));
  const all = db.prepare('SELECT id, name FROM specialties').all();
  return all.reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});
}

function ensureServices(specMap) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO services (id, specialty_id, name) VALUES (?, ?, ?)'
  );
  Object.values(specMap).forEach((spec) => {
    const existing = db
      .prepare('SELECT id FROM services WHERE specialty_id = ? LIMIT 1')
      .get(spec.id);
    if (!existing) {
      insert.run(`${spec.id}-svc`, spec.id, `${spec.name} Service`);
    }
  });
  const all = db.prepare('SELECT id, specialty_id FROM services').all();
  const bySpec = {};
  all.forEach((svc) => {
    if (!bySpec[svc.specialty_id]) bySpec[svc.specialty_id] = svc;
  });
  return bySpec;
}

function deleteOldDemoOrders(patientId) {
  const demoIds = db
    .prepare("SELECT id FROM orders WHERE patient_id = ? AND id LIKE 'demo-order-%'")
    .all(patientId);

  if (demoIds.length === 0) return;

  const ids = demoIds.map(o => o.id);
  const ph = ids.map(() => "?").join(",");

  db.prepare(`DELETE FROM order_events WHERE order_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM orders WHERE id IN (${ph})`).run(...ids);
}

function insertOrders({ patient, doctor, specialty, service }) {
  const now = Date.now();
  const mkId = (n) => `demo-order-${n}-${now}`;
  const ts = () => new Date().toISOString();

  const demoOrders = [
    {
      id: mkId(1),
      status: 'new',
      sla_hours: 24,
      created_at: ts(),
      accepted_at: null,
      deadline_at: null,
      completed_at: null,
      notes: null,
      report_url: null
    },
    {
      id: mkId(2),
      status: 'accepted',
      sla_hours: 72,
      created_at: ts(),
      accepted_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      deadline_at: new Date(now + 70 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
      notes: null,
      report_url: null
    },
    {
      id: mkId(3),
      status: 'completed',
      sla_hours: 72,
      created_at: ts(),
      accepted_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      deadline_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      completed_at: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      notes: 'Findings consistent with stable disease. Recommend follow-up in 3 months.',
      report_url: 'https://example.com/demo-report.pdf'
    }
  ];

  const insertOrder = db.prepare(
    `INSERT INTO orders
      (id, patient_id, doctor_id, specialty_id, service_id,
       sla_hours, status, price, doctor_fee,
       created_at, accepted_at, deadline_at, completed_at,
       breached_at, reassigned_count,
       report_url, notes)
     VALUES
      (@id, @patient_id, @doctor_id, @specialty_id, @service_id,
       @sla_hours, @status, @price, @doctor_fee,
       @created_at, @accepted_at, @deadline_at, @completed_at,
       NULL, 0,
       @report_url, @notes)`
  );

  const insertEvent = db.prepare(
    `INSERT INTO order_events (id, order_id, label, meta, at)
     VALUES (?, ?, ?, ?, ?)`
  );

  demoOrders.forEach((o, idx) => {
    const order = {
      ...o,
      patient_id: patient.id,
      doctor_id: doctor.id,
      specialty_id: specialty.id,
      service_id: service.id,
      price: 2500 + idx * 200,
      doctor_fee: 1200 + idx * 100
    };

    insertOrder.run(order);

    const events = [
      { label: 'Order submitted', at: order.created_at },
      { label: `Assigned to ${doctor.name}`, at: new Date(now + 5 * 60 * 1000).toISOString() }
    ];

    if (order.accepted_at) {
      events.push({ label: 'Accepted by doctor', at: order.accepted_at });
    }

    if (order.completed_at) {
      events.push({ label: 'Report completed', at: order.completed_at });
    }

    events.forEach(ev =>
      insertEvent.run(randomUUID(), order.id, ev.label, null, ev.at)
    );
  });
}

function main() {
  console.log("Running demo seed...");
  migrate();

  const specMap = ensureSpecialties();
  const servicesBySpec = ensureServices(specMap);
  const radiology = specMap.radiology || Object.values(specMap)[0];

  const patient = ensurePatient();
  const doctor = ensureDoctor();
  const service =
    (radiology && servicesBySpec[radiology.id]) ||
    servicesBySpec[Object.keys(servicesBySpec)[0]];

  console.log(`Using patient: ${patient.id} (${patient.email})`);
  console.log(`Using doctor: ${doctor.id} (${doctor.email})`);
  console.log(`Using specialty: ${radiology.id} (${radiology.name})`);
  console.log(`Using service: ${service.id} (${service.name})`);

  db.transaction(() => {
    deleteOldDemoOrders(patient.id);
    insertOrders({ patient, doctor, specialty: radiology, service });
  })();

  console.log("Demo seed complete.");
}

main();
