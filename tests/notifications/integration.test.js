// tests/notifications/integration.test.js
// Integration test: queue → worker processing (with mocked external APIs)

const path = require('path');
const assert = require('assert');
const { randomUUID } = require('crypto');

process.env.PORTAL_DB_PATH = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', '..', 'data', 'portal.db');
process.env.EMAIL_ENABLED = 'false';
process.env.WHATSAPP_ENABLED = 'false';
process.env.NOTIFICATION_DRY_RUN = 'true';

const { db } = require('../../src/db');
const { queueNotification, queueMultiChannelNotification } = require('../../src/notify');

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

// Helper: create a test user
function createTestUser(id, email, phone) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, email, phone, name, role, lang, notify_whatsapp)
       VALUES (?, ?, ?, 'Test User', 'patient', 'en', 1)`
    ).run(id, email, phone);
  } catch (e) {
    // user may already exist
  }
}

// Helper: clean up test notifications
function cleanupTestNotifications(prefix) {
  try {
    db.prepare("DELETE FROM notifications WHERE template LIKE ?").run(prefix + '%');
  } catch (e) { /* ignore */ }
}

console.log('\n🔄 Integration Tests\n');

const testUserId = 'test-user-' + randomUUID().slice(0, 8);
const testEmail = `test-${Date.now()}@tashkheesa.test`;
createTestUser(testUserId, testEmail, '+201234567890');

// Clean up any prior test data
cleanupTestNotifications('test_integration_');

test('queueNotification inserts a notification row', () => {
  const result = queueNotification({
    orderId: 'test-order-1',
    toUserId: testUserId,
    channel: 'internal',
    template: 'test_integration_basic',
    response: { test: true },
  });

  assert.ok(result.ok, 'Should return ok: true');
  assert.ok(result.id, 'Should return a notification ID');

  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(result.id);
  assert.ok(row, 'Row should exist in DB');
  assert.strictEqual(row.channel, 'internal');
  assert.strictEqual(row.template, 'test_integration_basic');
  assert.strictEqual(row.status, 'queued');
  assert.strictEqual(row.to_user_id, testUserId);
});

test('queueNotification deduplicates with dedupe_key', () => {
  const dedupeKey = 'test:dedupe:' + Date.now();

  const result1 = queueNotification({
    orderId: 'test-order-2',
    toUserId: testUserId,
    channel: 'internal',
    template: 'test_integration_dedupe',
    dedupe_key: dedupeKey,
  });

  const result2 = queueNotification({
    orderId: 'test-order-2',
    toUserId: testUserId,
    channel: 'internal',
    template: 'test_integration_dedupe',
    dedupe_key: dedupeKey,
  });

  assert.ok(result1.ok, 'First should succeed');
  assert.ok(result1.id, 'First should have ID');
  assert.ok(result2.ok, 'Second should succeed (deduped)');
  assert.strictEqual(result2.skipped, 'deduped', 'Second should be deduped');
});

test('queueNotification rejects invalid user ID', () => {
  const result = queueNotification({
    orderId: 'test-order-3',
    toUserId: '',
    channel: 'internal',
    template: 'test_integration_invalid',
  });

  assert.strictEqual(result.ok, false, 'Should fail');
  assert.strictEqual(result.skipped, true, 'Should be skipped');
  assert.strictEqual(result.reason, 'invalid_to_user_id');
});

test('queueNotification stores response as JSON', () => {
  const responseData = { key: 'value', nested: { a: 1 } };
  const result = queueNotification({
    orderId: 'test-order-4',
    toUserId: testUserId,
    channel: 'internal',
    template: 'test_integration_json',
    response: responseData,
  });

  assert.ok(result.ok);
  const row = db.prepare('SELECT response FROM notifications WHERE id = ?').get(result.id);
  const parsed = JSON.parse(row.response);
  assert.strictEqual(parsed.key, 'value');
  assert.strictEqual(parsed.nested.a, 1);
});

test('queueMultiChannelNotification creates rows for each channel', () => {
  const result = queueMultiChannelNotification({
    orderId: 'test-order-5',
    toUserId: testUserId,
    channels: ['email', 'internal'],
    template: 'test_integration_multi',
    response: { multi: true },
  });

  assert.ok(result.ok, 'Should succeed');
  assert.ok(result.results, 'Should have results');
  assert.ok(result.results.email, 'Should have email result');
  assert.ok(result.results.internal, 'Should have internal result');

  // Verify DB rows
  const rows = db.prepare(
    "SELECT * FROM notifications WHERE order_id = 'test-order-5' AND template = 'test_integration_multi'"
  ).all();
  const channels = rows.map(r => r.channel).sort();
  assert.ok(channels.includes('email'), 'Should have email row');
  assert.ok(channels.includes('internal'), 'Should have internal row');
});

test('queueMultiChannelNotification skips WhatsApp if no phone', () => {
  const noPhoneUserId = 'test-nophone-' + randomUUID().slice(0, 8);
  createTestUser(noPhoneUserId, `nophone-${Date.now()}@test.com`, null);

  // Also set phone to empty
  db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(noPhoneUserId);

  const result = queueMultiChannelNotification({
    orderId: 'test-order-6',
    toUserId: noPhoneUserId,
    channels: ['whatsapp', 'internal'],
    template: 'test_integration_nophone',
  });

  assert.ok(result.ok);
  assert.ok(result.results.whatsapp.skipped, 'WhatsApp should be skipped');
  assert.strictEqual(result.results.whatsapp.reason, 'no_phone');
});

test('queueMultiChannelNotification expands both shorthand', () => {
  const result = queueMultiChannelNotification({
    orderId: 'test-order-7',
    toUserId: testUserId,
    channels: ['both'],
    template: 'test_integration_both',
    response: { both: true },
  });

  assert.ok(result.ok);
  assert.ok(result.results.email, 'Should have email result');
  assert.ok(result.results.whatsapp, 'Should have whatsapp result');
  assert.ok(result.results.internal, 'Should have internal result');
});

// Notification DB schema checks
test('notifications table has attempts column', () => {
  const cols = db.prepare("PRAGMA table_info('notifications')").all().map(c => c.name);
  assert.ok(cols.includes('attempts'), 'Should have attempts column');
});

test('notifications table has retry_after column', () => {
  const cols = db.prepare("PRAGMA table_info('notifications')").all().map(c => c.name);
  assert.ok(cols.includes('retry_after'), 'Should have retry_after column');
});

test('notifications table has dedupe_key column', () => {
  const cols = db.prepare("PRAGMA table_info('notifications')").all().map(c => c.name);
  assert.ok(cols.includes('dedupe_key'), 'Should have dedupe_key column');
});

// Cleanup test data
cleanupTestNotifications('test_integration_');
try {
  db.prepare("DELETE FROM users WHERE id LIKE 'test-%'").run();
} catch (e) { /* ignore */ }

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
