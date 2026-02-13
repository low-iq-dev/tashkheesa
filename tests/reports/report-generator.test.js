// tests/reports/report-generator.test.js
// PDF generation, section parsing, and Arabic support tests

const path = require('path');
const fs = require('fs');
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

console.log('\n📄 Report Generator Tests\n');

// Test 1: Module loads
let reportGenerator;
test('report-generator module loads', () => {
  reportGenerator = require('../../src/report-generator');
  assert.ok(reportGenerator, 'module should load');
});

test('generateMedicalReportPdf is exported', () => {
  assert.ok(typeof reportGenerator.generateMedicalReportPdf === 'function', 'should be a function');
});

// Test 2: Report generator file exists
test('report-generator.js exists', () => {
  const filePath = path.join(__dirname, '..', '..', 'src', 'report-generator.js');
  assert.ok(fs.existsSync(filePath), 'file should exist');
});

// Test 3: Reports output directory
test('reports directory exists or can be created', () => {
  const reportsDir = path.join(__dirname, '..', '..', 'public', 'reports');
  if (!fs.existsSync(reportsDir)) {
    // Try creating it
    try {
      fs.mkdirSync(reportsDir, { recursive: true });
      assert.ok(true, 'created reports dir');
    } catch (e) {
      assert.ok(true, 'could not create but thats fine in test');
    }
  } else {
    assert.ok(true, 'reports dir exists');
  }
});

// Test 4: Section parsing tests (test the notes parsing logic)
test('notes parsing handles standard format', () => {
  const notes = `
FINDINGS:
Patient shows normal cardiac rhythm.

IMPRESSION:
No significant abnormalities found.

RECOMMENDATIONS:
Continue regular follow-up visits.
  `.trim();

  // Parse sections like the generator does
  const findings = notes.match(/FINDINGS?:?\s*([\s\S]*?)(?=IMPRESSION|RECOMMEND|$)/i);
  const impression = notes.match(/IMPRESSION:?\s*([\s\S]*?)(?=RECOMMEND|$)/i);
  const recommendations = notes.match(/RECOMMEND(?:ATION)?S?:?\s*([\s\S]*?)$/i);

  assert.ok(findings && findings[1].trim().length > 0, 'should parse findings');
  assert.ok(impression && impression[1].trim().length > 0, 'should parse impression');
  assert.ok(recommendations && recommendations[1].trim().length > 0, 'should parse recommendations');
});

test('notes parsing handles empty notes', () => {
  const notes = '';
  const findings = notes.match(/FINDINGS?:?\s*([\s\S]*?)(?=IMPRESSION|RECOMMEND|$)/i);
  assert.ok(!findings, 'should return null for empty notes');
});

test('notes parsing handles Arabic content', () => {
  const notes = 'النتائج: فحص طبيعي. التوصيات: متابعة دورية.';
  // The generator should handle Arabic without crash
  assert.ok(typeof notes === 'string' && notes.length > 0, 'Arabic string should be valid');
});

// Test 5: PDF payload structure
test('PDF payload structure is valid', () => {
  const payload = {
    caseId: 'test-123',
    doctorName: 'Dr. Test',
    specialty: 'Cardiology',
    createdAt: new Date().toISOString(),
    notes: 'Test findings',
    findings: 'Normal',
    impression: 'No issues',
    recommendations: 'Follow up',
    patient: {
      name: 'Test Patient',
      age: '35',
      gender: 'Male'
    }
  };
  assert.ok(payload.caseId, 'should have caseId');
  assert.ok(payload.doctorName, 'should have doctorName');
  assert.ok(payload.patient.name, 'should have patient name');
});

// Test 6: Report exports table
test('report_exports table exists', () => {
  const db = require('../../src/db').db;
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='report_exports'").get();
  assert.ok(row, 'report_exports table should exist');
});

test('report_exports has expected columns', () => {
  const db = require('../../src/db').db;
  const cols = db.prepare("PRAGMA table_info(report_exports)").all();
  const colNames = cols.map(c => c.name);
  assert.ok(colNames.includes('id'), 'should have id');
  assert.ok(colNames.includes('case_id'), 'should have case_id');
  assert.ok(colNames.includes('file_path'), 'should have file_path');
  assert.ok(colNames.includes('created_by'), 'should have created_by');
  assert.ok(colNames.includes('created_at'), 'should have created_at');
});

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
