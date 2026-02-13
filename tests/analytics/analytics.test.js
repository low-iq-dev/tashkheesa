// tests/analytics/analytics.test.js
// Analytics KPI calculations, period comparisons, and CSV export tests

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

console.log('\n📊 Analytics Tests\n');

let db;
try {
  db = require('../../src/db').db;
} catch (e) {
  console.error('Cannot load db:', e.message);
  process.exit(1);
}

// Period helpers
function periodStartDate(period) {
  var d = new Date();
  if (period === '7d') d.setDate(d.getDate() - 7);
  else if (period === '30d') d.setDate(d.getDate() - 30);
  else if (period === '90d') d.setDate(d.getDate() - 90);
  else d.setMonth(d.getMonth() - 12);
  return d.toISOString();
}

function prevPeriodStartDate(period) {
  var d = new Date();
  if (period === '7d') d.setDate(d.getDate() - 14);
  else if (period === '30d') d.setDate(d.getDate() - 60);
  else if (period === '90d') d.setDate(d.getDate() - 180);
  else d.setMonth(d.getMonth() - 24);
  return d.toISOString();
}

function pctChange(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

// Test 1: Period date calculations
test('periodStartDate returns valid ISO string', () => {
  ['7d', '30d', '90d', '12m'].forEach(p => {
    const d = periodStartDate(p);
    assert.ok(d, 'should return a string for period ' + p);
    assert.ok(new Date(d).getTime() > 0, 'should be valid date for ' + p);
  });
});

test('prevPeriodStartDate is earlier than periodStartDate', () => {
  ['7d', '30d', '90d', '12m'].forEach(p => {
    const prev = new Date(prevPeriodStartDate(p)).getTime();
    const curr = new Date(periodStartDate(p)).getTime();
    assert.ok(prev < curr, 'prev should be earlier for ' + p);
  });
});

// Test 2: Percentage change calculation
test('pctChange calculates correctly', () => {
  assert.strictEqual(pctChange(110, 100), 10);
  assert.strictEqual(pctChange(90, 100), -10);
  assert.strictEqual(pctChange(100, 100), 0);
  assert.strictEqual(pctChange(50, 0), 100);
  assert.strictEqual(pctChange(0, 0), 0);
});

// Test 3: KPI queries
test('total cases query works for 30d', () => {
  const startDate = periodStartDate('30d');
  const row = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at >= ?").get(startDate);
  assert.ok(typeof row.c === 'number');
});

test('revenue query works for 30d', () => {
  const startDate = periodStartDate('30d');
  const row = db.prepare("SELECT COALESCE(SUM(price), 0) as t FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ?").get(startDate);
  assert.ok(typeof row.t === 'number');
});

test('SLA compliance query works', () => {
  const startDate = periodStartDate('30d');
  const completed = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('completed','done','delivered') AND created_at >= ?").get(startDate);
  const onTime = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND datetime(completed_at) <= datetime(deadline_at) AND created_at >= ?").get(startDate);
  assert.ok(typeof completed.c === 'number');
  assert.ok(typeof onTime.c === 'number');
  assert.ok(onTime.c <= completed.c, 'on time <= completed');
});

// Test 4: Chart data queries
test('revenue trend query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('revenue by service query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT COALESCE(sv.name, 'Unknown') as name, COALESCE(SUM(o.price), 0) as revenue FROM orders o LEFT JOIN services sv ON sv.id = o.service_id WHERE o.payment_status IN ('paid','captured') AND o.created_at >= ? GROUP BY o.service_id ORDER BY revenue DESC LIMIT 8").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('cases by status query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT LOWER(status) as status, COUNT(*) as count FROM orders WHERE created_at >= ? GROUP BY LOWER(status) ORDER BY count DESC").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('top doctors query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT u.id, u.name, COUNT(o.id) as cases, COALESCE(SUM(o.price), 0) as revenue FROM users u LEFT JOIN orders o ON u.id = o.doctor_id AND o.payment_status IN ('paid','captured') AND o.created_at >= ? LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.role = 'doctor' AND u.is_active = 1 GROUP BY u.id ORDER BY revenue DESC LIMIT 10").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('SLA trend query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT strftime('%Y-%m-%d', completed_at) as date, COUNT(*) as total, SUM(CASE WHEN datetime(completed_at) <= datetime(deadline_at) THEN 1 ELSE 0 END) as on_time FROM orders WHERE status IN ('completed','done','delivered') AND completed_at IS NOT NULL AND deadline_at IS NOT NULL AND created_at >= ? GROUP BY strftime('%Y-%m-%d', completed_at) ORDER BY date ASC").all(startDate);
  assert.ok(Array.isArray(rows));
});

// Test 5: New Phase 3 charts
test('payment methods query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT COALESCE(payment_method, 'unknown') as method, COUNT(*) as count FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY COALESCE(payment_method, 'unknown') ORDER BY count DESC").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('doctor workload query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT COALESCE(u.name, 'Unassigned') as name, COUNT(o.id) as cases FROM orders o LEFT JOIN users u ON u.id = o.doctor_id WHERE o.created_at >= ? GROUP BY o.doctor_id HAVING COUNT(o.id) > 0 ORDER BY cases DESC LIMIT 15").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('notification stats query returns array', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT COALESCE(channel, 'unknown') as channel, status, COUNT(*) as count FROM notifications WHERE created_at >= ? GROUP BY channel, status ORDER BY channel, status").all(startDate);
  assert.ok(Array.isArray(rows));
});

// Test 6: CSV export queries
test('CSV cases export query works', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT o.id, o.status, COALESCE(sv.name, '') as service, o.price, o.created_at, o.completed_at FROM orders o LEFT JOIN services sv ON sv.id = o.service_id WHERE o.created_at >= ? ORDER BY o.created_at DESC").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('CSV revenue export query works', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price), 0) as revenue, COUNT(*) as cases FROM orders WHERE payment_status IN ('paid','captured') AND created_at >= ? GROUP BY strftime('%Y-%m', created_at) ORDER BY month ASC").all(startDate);
  assert.ok(Array.isArray(rows));
});

test('CSV doctors export query works', () => {
  const startDate = periodStartDate('30d');
  const rows = db.prepare("SELECT u.name as doctor, COALESCE(sp.name, '') as specialty, COUNT(o.id) as cases, COALESCE(SUM(o.price), 0) as revenue FROM users u LEFT JOIN orders o ON u.id = o.doctor_id AND o.payment_status IN ('paid','captured') AND o.created_at >= ? LEFT JOIN specialties sp ON sp.id = u.specialty_id WHERE u.role = 'doctor' GROUP BY u.id ORDER BY revenue DESC").all(startDate);
  assert.ok(Array.isArray(rows));
});

// Test 7: Period comparison
test('period comparison gives reasonable results', () => {
  const startDate = periodStartDate('30d');
  const prevStart = prevPeriodStartDate('30d');

  const currentCases = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at >= ?").get(startDate).c;
  const prevCases = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at < ?").get(prevStart, startDate).c;

  const change = pctChange(currentCases, prevCases);
  assert.ok(typeof change === 'number', 'change should be a number');
  assert.ok(change >= -100, 'change should be >= -100');
});

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
