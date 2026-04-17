#!/usr/bin/env node
/**
 * Create test doctor account on production.
 *
 * Usage: DATABASE_URL="postgresql://..." node src/create_test_doctor.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const client = await pool.connect();
  try {
    const email = 'dr.ahmed@tashkheesa.com';
    const password = 'Doctor123!';
    const passwordHash = await bcrypt.hash(password, 10);

    // 1. Create doctor user (or update if exists)
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    let doctorId;

    if (existing.rows.length > 0) {
      doctorId = existing.rows[0].id;
      await client.query(
        `UPDATE users SET password_hash = $1, name = $2, phone = $3, role = 'doctor',
         country = $4, lang = $5, pending_approval = false, is_active = true,
         approved_at = NOW() WHERE id = $6`,
        [passwordHash, 'Dr. Ahmed Hassan', '+201000000002', 'Egypt', 'en', doctorId]
      );
      console.log('Updated existing doctor:', doctorId);
    } else {
      const res = await client.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role, country, lang,
         pending_approval, is_active, approved_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'doctor', $5, $6, false, true, NOW(), NOW())
         RETURNING id`,
        ['Dr. Ahmed Hassan', email, passwordHash, '+201000000002', 'Egypt', 'en']
      );
      doctorId = res.rows[0].id;
      console.log('Created doctor:', doctorId);
    }

    // 2. Link specialties
    for (const specId of ['spec-orthopedics', 'spec-gastroenterology']) {
      const exists = await client.query(
        'SELECT 1 FROM doctor_specialties WHERE doctor_id = $1 AND specialty_id = $2',
        [doctorId, specId]
      );
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO doctor_specialties (id, doctor_id, specialty_id)
           VALUES (gen_random_uuid()::text, $1, $2)`,
          [doctorId, specId]
        );
      }
      console.log('Linked specialty:', specId);
    }

    console.log('\nDoctor account ready:');
    console.log('  Email:', email);
    console.log('  Password:', password);
    console.log('  ID:', doctorId);
    console.log('\nTest login:');
    console.log(`  curl -s -X POST https://tashkheesa.onrender.com/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"${email}","password":"${password}"}'`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
