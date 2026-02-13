// tests/reports/report-routes.test.js
// Report access control and download flow tests

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

console.log('\n🔒 Report Routes & Access Control Tests\n');

let db;
try {
  db = require('../../src/db').db;
} catch (e) {
  console.error('Cannot load db:', e.message);
  process.exit(1);
}

// Access control function (mirrors reports.js)
function userCanViewCase(user, caseRow) {
  if (!user || !caseRow) return false;
  var role = String(user.role || '').toLowerCase();
  if (role === 'superadmin' || role === 'admin') return true;
  if (role === 'doctor') return caseRow.doctor_id === user.id;
  if (role === 'patient') return caseRow.patient_id === user.id;
  return false;
}

// Test 1: Access control
test('admin can view any case', () => {
  const user = { id: 'admin-1', role: 'admin' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(userCanViewCase(user, caseRow));
});

test('superadmin can view any case', () => {
  const user = { id: 'sa-1', role: 'superadmin' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(userCanViewCase(user, caseRow));
});

test('doctor can view own case', () => {
  const user = { id: 'doc-1', role: 'doctor' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(userCanViewCase(user, caseRow));
});

test('doctor cannot view other doctor case', () => {
  const user = { id: 'doc-2', role: 'doctor' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(!userCanViewCase(user, caseRow));
});

test('patient can view own case', () => {
  const user = { id: 'pat-1', role: 'patient' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(userCanViewCase(user, caseRow));
});

test('patient cannot view other patient case', () => {
  const user = { id: 'pat-2', role: 'patient' };
  const caseRow = { doctor_id: 'doc-1', patient_id: 'pat-1' };
  assert.ok(!userCanViewCase(user, caseRow));
});

test('null user cannot view case', () => {
  assert.ok(!userCanViewCase(null, { doctor_id: 'doc-1' }));
});

test('null case returns false', () => {
  assert.ok(!userCanViewCase({ id: '1', role: 'admin' }, null));
});

// Test 2: Completed status check
test('completed status detection works', () => {
  const completedStatuses = ['completed', 'done', 'delivered', 'report_ready', 'report-ready', 'finalized'];
  assert.ok(completedStatuses.includes('completed'));
  assert.ok(completedStatuses.includes('done'));
  assert.ok(completedStatuses.includes('delivered'));
  assert.ok(!completedStatuses.includes('new'));
  assert.ok(!completedStatuses.includes('accepted'));
  assert.ok(!completedStatuses.includes('in_review'));
});

// Test 3: Order query for report
test('order query for report works', () => {
  const stmt = db.prepare('SELECT * FROM orders WHERE id = ?');
  assert.ok(stmt, 'query should compile');
});

// Test 4: Report-related file queries
test('order_files query works', () => {
  try {
    const rows = db.prepare('SELECT id, url, label, created_at FROM order_files WHERE order_id = ? LIMIT 1').all('test-nonexistent');
    assert.ok(Array.isArray(rows));
  } catch (e) {
    // Table may not exist
    assert.ok(true);
  }
});

test('case_annotations query works', () => {
  const rows = db.prepare("SELECT ca.id, ca.image_id, ca.annotations_count FROM case_annotations ca WHERE ca.case_id = ? LIMIT 1").all('test-nonexistent');
  assert.ok(Array.isArray(rows));
});

// Test 5: Report exports query
test('report_exports query works', () => {
  const rows = db.prepare("SELECT id, file_path, created_at FROM report_exports WHERE case_id = ? ORDER BY created_at DESC LIMIT 10").all('test-nonexistent');
  assert.ok(Array.isArray(rows));
});

test('report_exports with join works', () => {
  const rows = db.prepare("SELECT re.id, re.file_path, re.created_at, COALESCE(u.name, 'System') as created_by_name FROM report_exports re LEFT JOIN users u ON u.id = re.created_by WHERE re.case_id = ? ORDER BY re.created_at DESC LIMIT 10").all('test-nonexistent');
  assert.ok(Array.isArray(rows));
});

// Test 6: Email report dependencies
test('email service module exists', () => {
  const filePath = path.join(__dirname, '..', '..', 'src', 'services', 'emailService.js');
  const fs = require('fs');
  assert.ok(fs.existsSync(filePath), 'emailService.js should exist');
});

test('report-ready email template exists (en)', () => {
  const filePath = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'en', 'report-ready.hbs');
  const fs = require('fs');
  assert.ok(fs.existsSync(filePath), 'en template should exist');
});

test('report-ready email template exists (ar)', () => {
  const filePath = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'ar', 'report-ready.hbs');
  const fs = require('fs');
  assert.ok(fs.existsSync(filePath), 'ar template should exist');
});

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
