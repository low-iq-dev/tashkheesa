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

// ── C2.E additions ──────────────────────────────────────────────────────
// Helpers for seeding messages-attach + additional-files surfaces. Same
// theme13test- prefix scheme so cleanupByPrefix scrubs them all together.

async function seedDoctor(pool, opts) {
  const id = (opts && opts.id) || 'theme13test-dr-' + randomUUID();
  const email = (opts && opts.email) || id + '@example.com';
  await pool.query(
    `INSERT INTO users (id, email, role, name, is_active, created_at)
     VALUES ($1, $2, 'doctor', 'Theme 13 Test Doctor', true, NOW())`,
    [id, email]
  );
  return { id: id, email: email, role: 'doctor' };
}

async function seedConversation(pool, orderId, patientId, doctorId, opts) {
  const id = (opts && opts.id) || 'theme13test-convo-' + randomUUID();
  await pool.query(
    `INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at)
     VALUES ($1, $2, $3, $4, 'open', NOW())`,
    [id, orderId, patientId, doctorId]
  );
  return { id: id, order_id: orderId, patient_id: patientId, doctor_id: doctorId };
}

async function seedMessage(pool, conversationId, senderId, opts) {
  const id = (opts && opts.id) || 'theme13test-msg-' + randomUUID();
  const fileUrl = (opts && opts.fileUrl) || null;
  const fileKey = (opts && opts.fileKey) || null;
  const fileName = (opts && opts.fileName) || null;
  const messageType = (fileUrl || fileKey) ? 'file' : 'text';
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, sender_id, sender_role, content, message_type, file_url, file_key, file_name, created_at)
     VALUES ($1, $2, $3, 'patient', 'test', $4, $5, $6, $7, NOW())`,
    [id, conversationId, senderId, messageType, fileUrl, fileKey, fileName]
  );
  return { id: id, conversation_id: conversationId };
}

async function seedAdditionalFile(pool, orderId, opts) {
  const id = (opts && opts.id) || 'theme13test-adf-' + randomUUID();
  const fileUrl = (opts && opts.fileUrl) || null;
  const fileKey = (opts && opts.fileKey) || null;
  await pool.query(
    `INSERT INTO order_additional_files
       (id, order_id, file_url, file_key, label, uploaded_at)
     VALUES ($1, $2, $3, $4, 'theme13 test', NOW())`,
    [id, orderId, fileUrl, fileKey]
  );
  return { id: id, order_id: orderId };
}

// Cleanup is FK-aware: messages → conversations → order_additional_files →
// order_files → orders → users (reverse insert order across all tables).
async function cleanupByPrefix(pool, prefix) {
  await pool.query('DELETE FROM messages WHERE id LIKE $1', [prefix + '%']);
  await pool.query('DELETE FROM conversations WHERE id LIKE $1', [prefix + '%']);
  await pool.query('DELETE FROM order_additional_files WHERE id LIKE $1', [prefix + '%']);
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
  seedDoctor,
  seedOrder,
  seedOrderFile,
  seedConversation,
  seedMessage,
  seedAdditionalFile,
  cleanupByPrefix
};
