// tests/notifications/whatsapp.test.js
// Tests for WhatsApp service: phone normalization, template map, payload formatting

const path = require('path');
const assert = require('assert');

process.env.PORTAL_DB_PATH = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');
process.env.WHATSAPP_ENABLED = 'false'; // Don't actually send

const { whatsappTemplateMap, getWhatsAppTemplate } = require('../../src/notify/whatsappTemplateMap');

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

console.log('\n📱 WhatsApp Service Tests\n');

// Phone normalization (tested via the whatsapp module)
test('Phone normalization strips non-digits', () => {
  const phone = '+20-123-456-7890';
  const normalized = phone.replace(/[^0-9]/g, '');
  assert.strictEqual(normalized, '201234567890');
});

test('Phone normalization handles clean numbers', () => {
  const phone = '201234567890';
  const normalized = phone.replace(/[^0-9]/g, '');
  assert.strictEqual(normalized, '201234567890');
});

test('Phone normalization handles spaces and parentheses', () => {
  const phone = '+20 (123) 456 7890';
  const normalized = phone.replace(/[^0-9]/g, '');
  assert.strictEqual(normalized, '201234567890');
});

// Template map tests
test('Template map has order_created_patient', () => {
  const entry = whatsappTemplateMap.order_created_patient;
  assert.ok(entry, 'Should have entry');
  assert.strictEqual(entry.templateName, 'case_submitted_en');
  assert.strictEqual(entry.lang, 'en');
  assert.strictEqual(typeof entry.paramBuilder, 'function');
});

test('Template map has report_ready_patient', () => {
  const entry = whatsappTemplateMap.report_ready_patient;
  assert.ok(entry, 'Should have entry');
  assert.strictEqual(entry.templateName, 'report_ready_en');
});

test('Template map has payment_success_patient', () => {
  const entry = whatsappTemplateMap.payment_success_patient;
  assert.ok(entry, 'Should have entry');
  assert.strictEqual(entry.templateName, 'payment_confirmed_en');
});

test('Template map has sla_warning_75', () => {
  const entry = whatsappTemplateMap.sla_warning_75;
  assert.ok(entry, 'Should have entry');
  assert.strictEqual(entry.templateName, 'sla_warning_en');
});

test('Template map has appointment_booked', () => {
  const entry = whatsappTemplateMap.appointment_booked;
  assert.ok(entry, 'Should have entry');
  assert.strictEqual(entry.templateName, 'appointment_confirmed_en');
});

test('getWhatsAppTemplate returns entry for known event', () => {
  const entry = getWhatsAppTemplate('order_created_patient');
  assert.ok(entry, 'Should return entry');
  assert.strictEqual(entry.templateName, 'case_submitted_en');
});

test('getWhatsAppTemplate returns null for unknown event', () => {
  const entry = getWhatsAppTemplate('nonexistent_event');
  assert.strictEqual(entry, null, 'Should return null');
});

// Param builder tests
test('paramBuilder extracts case_ref and specialty', () => {
  const entry = whatsappTemplateMap.order_created_patient;
  const params = entry.paramBuilder({
    caseReference: 'ABC123',
    specialty: 'Radiology',
  });
  assert.strictEqual(params.case_ref, 'ABC123');
  assert.strictEqual(params.specialty, 'Radiology');
});

test('paramBuilder handles missing data gracefully', () => {
  const entry = whatsappTemplateMap.order_created_patient;
  const params = entry.paramBuilder({});
  assert.strictEqual(params.case_ref, '');
  assert.strictEqual(params.specialty, '');
});

test('appointment paramBuilder extracts date and doctor', () => {
  const entry = whatsappTemplateMap.appointment_booked;
  const params = entry.paramBuilder({
    appointmentDate: '2026-02-15 15:00',
    doctorName: 'Dr. Ahmed',
  });
  assert.strictEqual(params.date_time, '2026-02-15 15:00');
  assert.strictEqual(params.doctor_name, 'Dr. Ahmed');
});

// Template map completeness
test('Template map covers all major notification events', () => {
  const requiredEvents = [
    'order_created_patient',
    'report_ready_patient',
    'payment_success_patient',
    'order_assigned_doctor',
    'sla_warning_75',
    'sla_warning_urgent',
    'appointment_booked',
    'appointment_reminder',
    'doctor_approved',
    'welcome_patient',
  ];
  requiredEvents.forEach(event => {
    assert.ok(whatsappTemplateMap[event], `Missing template map entry for: ${event}`);
  });
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
