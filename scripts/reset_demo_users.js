/**
 * Single source of truth for demo credentials.
 * Run with: npm run reset:demo-users
 */
require('dotenv').config();
const { db, migrate } = require('../src/db');
const { hash } = require('../src/auth');

function upsertUsers() {
  const users = [
    {
      id: 'superadmin-1',
      name: 'Superadmin 1',
      email: 'ziad.wahsh@shifaegypt.com',
      role: 'superadmin',
      password: 'SuperAdmin123!'
    },
    {
      id: 'superadmin-2',
      name: 'Superadmin 2',
      email: 'zmelwahsh@gmail.com',
      role: 'superadmin',
      password: 'SuperAdmin123!'
    },
    {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@tashkheesa.com',
      role: 'admin',
      password: 'Admin123!'
    },
    {
      id: 'doctor-radiology-1',
      name: 'Dr Radiology',
      email: 'dr.radiology@tashkheesa.com',
      role: 'doctor',
      password: 'Doctor123!'
    },
    {
      id: 'patient-demo-1',
      name: 'Demo Patient',
      email: 'client@demo.com',
      role: 'patient',
      password: 'Client123!'
    }
  ];

  const stmt = db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, lang, is_active)
    VALUES (@id, @email, @password_hash, @name, @role, 'en', 1)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      name          = excluded.name,
      role          = excluded.role,
      lang          = excluded.lang,
      is_active     = 1
  `);

  const tx = db.transaction(() => {
    users.forEach((u) => {
      stmt.run({
        id: u.id,
        email: u.email,
        password_hash: hash(u.password),
        name: u.name,
        role: u.role
      });
    });
  });

  tx();
  console.log(`Updated ${users.length} demo users.`);
}

function main() {
  migrate();
  upsertUsers();
}

main();
