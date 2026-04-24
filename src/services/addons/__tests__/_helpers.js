'use strict';

// Shared helpers for node --test runs against the live local tashkheesa DB.
// Strategy: every test-created row has an id (or order_id) prefixed with
// 'test-addon-'. A single teardown in each test file DELETEs on that
// prefix across addon_earnings, order_addons, orders, users.
//
// No separate schema is created. The Phase 2 migration is the test
// schema. If migration 019 has not been applied, these tests fail loudly
// on the first query.

const crypto = require('node:crypto');
const { pool, queryOne, execute } = require('../../../pg');

const TEST_PREFIX = 'test-addon-';

function uid(label) {
  return TEST_PREFIX + (label ? label + '-' : '') + crypto.randomBytes(4).toString('hex');
}

async function createDisposableDoctor() {
  const id = uid('doc');
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active)
     VALUES ($1, $2, $3, 'doctor', 'x', NOW(), true)`,
    [id, id + '@test.local', 'Test Doctor ' + id.slice(-6)]
  );
  return { id, email: id + '@test.local', name: 'Test Doctor ' + id.slice(-6), role: 'doctor' };
}

async function createDisposableOrder({ patientId, doctorId, serviceId }) {
  const id = uid('order');
  // orders in this codebase have a text PK (id). Minimum insert must
  // satisfy any NOT NULLs. Check the schema; current NOT NULLs as of
  // migration 017 are id, created_at (defaulted). Everything else is
  // nullable. We set patient_id / doctor_id / service_id / status for
  // realism — and price so the addon math has something to layer against.
  await execute(
    `INSERT INTO orders (id, patient_id, doctor_id, service_id, price, status, created_at)
     VALUES ($1, $2, $3, $4, 1500, 'new', NOW())`,
    [id, patientId || null, doctorId || null, serviceId || null]
  );
  return await queryOne(`SELECT * FROM orders WHERE id = $1`, [id]);
}

async function getAddonService(id) {
  return await queryOne(`SELECT * FROM addon_services WHERE id = $1`, [id]);
}

async function getOrderAddon(id) {
  return await queryOne(`SELECT * FROM order_addons WHERE id = $1`, [id]);
}

async function getEarningsFor(orderAddonId) {
  return await queryOne(`SELECT * FROM addon_earnings WHERE order_addon_id = $1`, [orderAddonId]);
}

async function cleanupAll() {
  // Order matters: addon_earnings → order_addons → orders → users (FKs).
  await execute(`DELETE FROM addon_earnings WHERE order_addon_id IN (SELECT id FROM order_addons WHERE order_id LIKE $1)`, [TEST_PREFIX + '%']);
  await execute(`DELETE FROM order_addons   WHERE order_id LIKE $1`, [TEST_PREFIX + '%']);
  await execute(`DELETE FROM orders         WHERE id       LIKE $1`, [TEST_PREFIX + '%']);
  await execute(`DELETE FROM users          WHERE id       LIKE $1`, [TEST_PREFIX + '%']);
}

async function closePool() {
  await pool.end();
}

module.exports = {
  TEST_PREFIX,
  uid,
  pool,
  createDisposableDoctor,
  createDisposableOrder,
  getAddonService,
  getOrderAddon,
  getEarningsFor,
  cleanupAll,
  closePool
};
