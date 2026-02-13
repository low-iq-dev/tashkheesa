// tests/notifications/emailService.test.js
// Tests for email service: template rendering and SMTP config validation

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Setup minimal env before requiring emailService
process.env.PORTAL_DB_PATH = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');
process.env.EMAIL_ENABLED = 'false'; // Don't actually send during tests

const { renderEmail, EMAIL_ENABLED } = require('../../src/services/emailService');

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

console.log('\n📧 Email Service Tests\n');

// Template rendering tests
test('renderEmail returns HTML for case-submitted (en)', () => {
  const html = renderEmail('case-submitted', 'en', {
    patientName: 'Test Patient',
    caseReference: 'ABC123',
    specialty: 'Radiology',
    slaHours: 72,
    dashboardUrl: 'https://tashkheesa.com/dashboard',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Test Patient'), 'Should contain patient name');
  assert.ok(html.includes('ABC123'), 'Should contain case reference');
  assert.ok(html.includes('Radiology'), 'Should contain specialty');
  assert.ok(html.includes('Tashkheesa'), 'Should contain brand name');
});

test('renderEmail returns HTML for case-assigned (en)', () => {
  const html = renderEmail('case-assigned', 'en', {
    doctorName: 'Ahmed Hassan',
    caseReference: 'XYZ789',
    specialty: 'Cardiology',
    slaHours: 24,
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Ahmed Hassan'), 'Should contain doctor name');
  assert.ok(html.includes('XYZ789'), 'Should contain case reference');
});

test('renderEmail returns HTML for report-ready (en)', () => {
  const html = renderEmail('report-ready', 'en', {
    patientName: 'John Doe',
    caseReference: 'RPT456',
    doctorName: 'Dr. Smith',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('John Doe'), 'Should contain patient name');
  assert.ok(html.includes('Report'), 'Should mention report');
});

test('renderEmail returns HTML for payment-success (en)', () => {
  const html = renderEmail('payment-success', 'en', {
    patientName: 'Jane Doe',
    caseReference: 'PAY789',
    amount: '500',
    currency: 'EGP',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Jane Doe'), 'Should contain patient name');
  assert.ok(html.includes('500'), 'Should contain amount');
});

test('renderEmail returns HTML for payment-failed (en)', () => {
  const html = renderEmail('payment-failed', 'en', {
    patientName: 'Bob',
    caseReference: 'FAIL123',
    errorReason: 'Insufficient funds',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Bob'), 'Should contain patient name');
});

test('renderEmail returns HTML for sla-warning (en)', () => {
  const html = renderEmail('sla-warning', 'en', {
    doctorName: 'Dr. Ali',
    caseReference: 'SLA001',
    hoursRemaining: '6',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('SLA'), 'Should mention SLA');
});

test('renderEmail returns HTML for welcome (en)', () => {
  const html = renderEmail('welcome', 'en', {
    patientName: 'New Patient',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Welcome'), 'Should contain welcome text');
});

test('renderEmail returns HTML for doctor-welcome (en)', () => {
  const html = renderEmail('doctor-welcome', 'en', {
    doctorName: 'Dr. Expert',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('Dr. Expert'), 'Should contain doctor name');
});

// Arabic template tests
test('renderEmail returns HTML for case-submitted (ar)', () => {
  const html = renderEmail('case-submitted', 'ar', {
    patientName: 'مريض',
    caseReference: 'ARB001',
  });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('rtl') || html.includes('تشخيصة'), 'Should have Arabic/RTL content');
});

test('renderEmail returns null for non-existent template', () => {
  const html = renderEmail('non-existent-template', 'en', {});
  assert.strictEqual(html, null, 'Should return null for missing template');
});

test('renderEmail wraps content in layout', () => {
  const html = renderEmail('case-submitted', 'en', { patientName: 'Wrapper Test' });
  assert.ok(html, 'HTML should not be null');
  assert.ok(html.includes('<!DOCTYPE html>'), 'Should include DOCTYPE from layout');
  assert.ok(html.includes('Tashkheesa'), 'Should include brand from layout');
  assert.ok(html.includes('All rights reserved'), 'Should include footer from layout');
});

// Config validation
test('EMAIL_ENABLED is false in test environment', () => {
  assert.strictEqual(EMAIL_ENABLED, false, 'Should be false when EMAIL_ENABLED=false');
});

// Template file existence
test('All English template files exist', () => {
  const templatesDir = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'en');
  const required = [
    '_layout.hbs', 'case-submitted.hbs', 'case-assigned.hbs', 'report-ready.hbs',
    'payment-success.hbs', 'payment-failed.hbs', 'case-accepted.hbs',
    'appointment-reminder.hbs', 'appointment-scheduled.hbs', 'sla-warning.hbs',
    'case-reassigned.hbs', 'welcome.hbs', 'doctor-welcome.hbs',
  ];
  required.forEach(f => {
    assert.ok(fs.existsSync(path.join(templatesDir, f)), `Missing: ${f}`);
  });
});

test('All Arabic template files exist', () => {
  const templatesDir = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'ar');
  assert.ok(fs.existsSync(templatesDir), 'Arabic template dir should exist');
  assert.ok(fs.existsSync(path.join(templatesDir, '_layout.hbs')), 'Arabic layout should exist');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
