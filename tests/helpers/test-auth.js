// tests/helpers/test-auth.js
//
// JWT signing + minimal DB seed/cleanup utilities for Theme 13 H-phase tests
// (auth-bound regression tests T3, T4, T5, T8, T9 per §6 of the fix plan).
//
// Why this exists: prior phases used grep-style lint tests + a couple of
// no-auth endpoint smoke tests. The remaining T3..T9 tests need an
// authenticated request, which the codebase had no helper for. Sub-issue H
// adds this helper + the tests that consume it.
//
// JWT contract mirrors src/auth.js#sign exactly. verify() in src/auth.js is
// pure jwt.verify with no DB lookup, so the JWT's user.id can reference a
// row that doesn't exist (useful for T3/T4/T5 which don't need DB rows).
// T8/T9 do need real rows; the seed/cleanup helpers handle that with a
// theme13test- ID prefix so concurrent runs don't collide.

'use strict';

const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

function getCookieName() {
  return process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';
}

// JWT payload shape matches src/auth.js#sign output (id, role, email, name,
// lang, country_code, phone, specialty_id). Defaults are sane for a patient
// session; override any field via the claims arg.
function signSessionToken(claims) {
  const payload = Object.assign({
    id: 'theme13test-user-' + randomUUID().slice(0, 8),
    email: 'theme13test@example.com',
    role: 'patient',
    name: 'Theme 13 Test',
    lang: 'en',
    country_code: null,
    phone: '+11234567890', // requirePhone middleware would 302-redirect without this
    specialty_id: null
  }, claims || {});
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
}

function sessionCookie(claims) {
  return getCookieName() + '=' + signSessionToken(claims);
}

function bearerToken(claims) {
  return 'Bearer ' + signSessionToken(claims);
}

// ── Minimal DB seeds for T8/T9 (file-route tests) ─────────────────────────
// All seeded rows use the theme13test- ID prefix so cleanupByPrefix can
// blast them in one DELETE.

async function seedPatient(pool, opts) {
  const id = (opts && opts.id) || 'theme13test-pt-' + randomUUID();
  const email = (opts && opts.email) || id + '@example.com';
  await pool.query(
    `INSERT INTO users (id, email, role, name, is_active, created_at)
     VALUES ($1, $2, 'patient', 'Theme 13 Test Patient', true, NOW())`,
    [id, email]
  );
  return { id: id, email: email, role: 'patient' };
}

async function seedOrder(pool, patientId, opts) {
  const id = (opts && opts.id) || 'theme13test-order-' + randomUUID();
  await pool.query(
    `INSERT INTO orders (id, patient_id, status, created_at, urgency_uplift_amount)
     VALUES ($1, $2, 'paid', NOW(), 0)`,
    [id, patientId]
  );
  return { id: id, patient_id: patientId };
}

async function seedOrderFile(pool, orderId, url) {
  const id = 'theme13test-file-' + randomUUID();
  await pool.query(
    `INSERT INTO order_files (id, order_id, url, label, created_at)
     VALUES ($1, $2, $3, 'theme13 test', NOW())`,
    [id, orderId, url]
  );
  return { id: id, order_id: orderId, url: url };
}

// Cleanup is FK-aware: order_files → orders → users (reverse insert order).
async function cleanupByPrefix(pool, prefix) {
  await pool.query('DELETE FROM order_files WHERE id LIKE $1', [prefix + '%']);
  await pool.query('DELETE FROM orders WHERE id LIKE $1', [prefix + '%']);
  await pool.query('DELETE FROM users WHERE id LIKE $1', [prefix + '%']);
}

module.exports = {
  getCookieName,
  signSessionToken,
  sessionCookie,
  bearerToken,
  seedPatient,
  seedOrder,
  seedOrderFile,
  cleanupByPrefix
};
