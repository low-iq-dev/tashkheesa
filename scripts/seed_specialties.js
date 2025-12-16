// scripts/seed_specialties.js
require('dotenv').config();
const { db, migrate } = require('../src/db');

const specialties = [
  { id: 'radiology', name: 'Radiology' },
  { id: 'cardiology', name: 'Cardiology' },
  { id: 'neurology', name: 'Neurology' },
  { id: 'gastroenterology', name: 'Gastroenterology' },
  { id: 'dermatology', name: 'Dermatology' },
  { id: 'orthopedics', name: 'Orthopedics' },
  { id: 'pediatrics', name: 'Pediatrics' },
  { id: 'oncology', name: 'Oncology' },
  { id: 'urology', name: 'Urology' },
  { id: 'nephrology', name: 'Nephrology' },
  { id: 'internal_medicine', name: 'Internal Medicine' },
  { id: 'endocrinology', name: 'Endocrinology' },
  { id: 'ent', name: 'ENT' },
  { id: 'ophthalmology', name: 'Ophthalmology' },
  { id: 'general_surgery', name: 'General Surgery' },
  { id: 'pulmonology', name: 'Pulmonology' }
];

async function run() {
  migrate();

  const findByName = db.prepare(
    `SELECT id FROM specialties WHERE name = ? LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO specialties (id, name) VALUES (?, ?)`
  );

  const transaction = db.transaction(() => {
    specialties.forEach((spec) => {
      const exists = findByName.get(spec.name);
      if (!exists) {
        insert.run(spec.id, spec.name);
      }
    });
  });

  transaction();
  console.log(`Seeded ${specialties.length} specialties (inserted or ensured existing).`);
}

run();
