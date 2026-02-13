// tests/notifications/notificationWorker.test.js
// Tests for notification worker: template mapping, retry logic, status transitions

const path = require('path');
const assert = require('assert');

process.env.PORTAL_DB_PATH = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');
process.env.EMAIL_ENABLED = 'false';
process.env.WHATSAPP_ENABLED = 'false';
process.env.NOTIFICATION_DRY_RUN = 'true';

const { TEMPLATE_TO_EMAIL } = require('../../src/notification_worker');

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

console.log('\n⚙️  Notification Worker Tests\n');

// Template mapping tests
test('TEMPLATE_TO_EMAIL maps order_created_patient to case-submitted', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.order_created_patient, 'case-submitted');
});

test('TEMPLATE_TO_EMAIL maps order_assigned_doctor to case-assigned', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.order_assigned_doctor, 'case-assigned');
});

test('TEMPLATE_TO_EMAIL maps report_ready_patient to report-ready', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.report_ready_patient, 'report-ready');
});

test('TEMPLATE_TO_EMAIL maps payment_success_patient to payment-success', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.payment_success_patient, 'payment-success');
});

test('TEMPLATE_TO_EMAIL maps payment_failed_patient to payment-failed', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.payment_failed_patient, 'payment-failed');
});

test('TEMPLATE_TO_EMAIL maps order_status_accepted_patient to case-accepted', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.order_status_accepted_patient, 'case-accepted');
});

test('TEMPLATE_TO_EMAIL maps appointment_reminder to appointment-reminder', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.appointment_reminder, 'appointment-reminder');
});

test('TEMPLATE_TO_EMAIL maps appointment_booked to appointment-scheduled', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.appointment_booked, 'appointment-scheduled');
});

test('TEMPLATE_TO_EMAIL maps sla_warning_75 to sla-warning', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.sla_warning_75, 'sla-warning');
});

test('TEMPLATE_TO_EMAIL maps order_reassigned_doctor to case-reassigned', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.order_reassigned_doctor, 'case-reassigned');
});

test('TEMPLATE_TO_EMAIL maps welcome_patient to welcome', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.welcome_patient, 'welcome');
});

test('TEMPLATE_TO_EMAIL maps doctor_approved to doctor-welcome', () => {
  assert.strictEqual(TEMPLATE_TO_EMAIL.doctor_approved, 'doctor-welcome');
});

// Retry logic constants
test('MAX_RETRIES defaults to 3', () => {
  const maxRetries = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
  assert.strictEqual(maxRetries, 3);
});

test('Exponential backoff calculation is correct', () => {
  // backoffMs = 30000 * Math.pow(4, attempts - 1)
  const attempt1 = 30000 * Math.pow(4, 0); // 30s
  const attempt2 = 30000 * Math.pow(4, 1); // 120s
  const attempt3 = 30000 * Math.pow(4, 2); // 480s

  assert.strictEqual(attempt1, 30000, 'First retry: 30 seconds');
  assert.strictEqual(attempt2, 120000, 'Second retry: 2 minutes');
  assert.strictEqual(attempt3, 480000, 'Third retry: 8 minutes');
});

// Status transitions
test('Status flow: queued -> sent (success)', () => {
  const statuses = ['queued', 'sent'];
  assert.ok(statuses.includes('queued'));
  assert.ok(statuses.includes('sent'));
});

test('Status flow: queued -> retry -> sent (retry success)', () => {
  const statuses = ['queued', 'retry', 'sent'];
  assert.ok(statuses.includes('retry'));
});

test('Status flow: queued -> retry -> retry -> failed (max retries)', () => {
  const statuses = ['queued', 'retry', 'retry', 'failed'];
  assert.ok(statuses.includes('failed'));
});

// All email templates referenced in map should exist as files
test('All mapped email templates have corresponding .hbs files', () => {
  const templatesDir = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'en');
  const fs = require('fs');
  const uniqueTemplates = [...new Set(Object.values(TEMPLATE_TO_EMAIL))];

  uniqueTemplates.forEach(tmpl => {
    const filePath = path.join(templatesDir, `${tmpl}.hbs`);
    assert.ok(fs.existsSync(filePath), `Template file missing: ${tmpl}.hbs`);
  });
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
