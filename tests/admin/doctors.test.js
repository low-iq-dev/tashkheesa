// tests/admin/doctors.test.js
// Doctor CRUD operations tests

const path = require('path');
const assert = require('assert');

process.env.PORTAL_DB_PATH = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

console.log('\n👨‍⚕️ Doctor CRUD Tests\n');

let db;
try {
  db = require('../../src/db').db;
} catch (e) {
  console.error('Cannot load db:', e.message);
  process.exit(1);
}

// Test 1: Doctor list query works
test('doctor list query returns array', () => {
  const doctors = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.notify_whatsapp, u.is_active, u.specialty_id,
           u.created_at AS joined_at,
           s.name AS specialty_name,
           (SELECT COUNT(*) FROM orders WHERE doctor_id = u.id AND LOWER(COALESCE(status, '')) = 'completed') AS cases_completed,
           (SELECT COUNT(*) FROM orders WHERE doctor_id = u.id) AS total_cases,
           (SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) FROM orders WHERE doctor_id = u.id AND LOWER(COALESCE(payment_status, '')) = 'paid') AS total_earnings
    FROM users u
    LEFT JOIN specialties s ON s.id = u.specialty_id
    WHERE u.role = 'doctor'
    ORDER BY u.created_at DESC, u.name ASC
  `).all();
  assert.ok(Array.isArray(doctors), 'should return array');
});

// Test 2: Doctor has expected columns
test('doctors have expected fields', () => {
  const doctor = db.prepare("SELECT id, name, email, role, is_active, specialty_id FROM users WHERE role = 'doctor' LIMIT 1").get();
  if (doctor) {
    assert.ok(doctor.id, 'should have id');
    assert.ok(doctor.role === 'doctor', 'role should be doctor');
    assert.ok(typeof doctor.is_active !== 'undefined', 'should have is_active');
  } else {
    // No doctors is fine for testing
    assert.ok(true, 'no doctors in db');
  }
});

// Test 3: Specialties list
test('specialties query works', () => {
  const specialties = db.prepare('SELECT id, name FROM specialties ORDER BY name ASC').all();
  assert.ok(Array.isArray(specialties), 'should return array');
});

// Test 4: Toggle active query works (dry run)
test('toggle active SQL is valid', () => {
  // Just verify the SQL compiles
  const stmt = db.prepare("UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND role = 'doctor'");
  assert.ok(stmt, 'should compile');
});

// Test 5: Doctor insert SQL is valid
test('doctor insert SQL is valid', () => {
  const stmt = db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, specialty_id, phone, lang, notify_whatsapp, is_active)
    VALUES (?, ?, ?, ?, 'doctor', ?, ?, 'en', ?, ?)
  `);
  assert.ok(stmt, 'should compile');
});

// Test 6: Doctor update SQL is valid
test('doctor update SQL is valid', () => {
  const stmt = db.prepare(`
    UPDATE users SET name = ?, email = ?, specialty_id = ?, phone = ?, notify_whatsapp = ?, is_active = ?
    WHERE id = ? AND role = 'doctor'
  `);
  assert.ok(stmt, 'should compile');
});

// Test 7: Doctor stats subqueries work
test('doctor cases completed subquery works', () => {
  const row = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE LOWER(COALESCE(status, '')) = 'completed'").get();
  assert.ok(typeof row.c === 'number');
});

test('doctor earnings subquery works', () => {
  const row = db.prepare("SELECT COALESCE(SUM(COALESCE(total_price_with_addons, price, 0)), 0) AS total FROM orders WHERE LOWER(COALESCE(payment_status, '')) = 'paid'").get();
  assert.ok(typeof row.total === 'number');
});

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
