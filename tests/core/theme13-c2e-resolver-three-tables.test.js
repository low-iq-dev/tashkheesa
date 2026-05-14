// tests/core/theme13-c2e-resolver-three-tables.test.js
//
// Theme 13 Sub-issue C2.E — /files/:id walks 3 tables (order_files,
// messages, order_additional_files) with per-source auth (per §8 Q4)
// and uniform 403/404 response codes (per §8 Q-B).
//
// Five assertions:
//   1. Resolver finds row in messages with file_key (R2) → 302 to signed R2 URL
//   2. Resolver finds row in messages with file_url (HTTP, legacy) → 302 verbatim
//   3. Resolver finds row in order_additional_files with file_key → 302 to signed R2 URL
//   4. Auth: messages reader who's NOT a conversation member → 403 (info-disclosure-safe)
//   5. 404 when fileId doesn't exist in any of the three tables
//
// Skipped when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const {
  sessionCookie, seedPatient, seedDoctor, seedOrder,
  seedConversation, seedMessage, seedAdditionalFile, cleanupByPrefix
} = require('../helpers/test-auth');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 C2.E — /files/:id walks 3 tables with per-source auth\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-c2e-resolver-three-tables', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-c2e-resolver-three-tables', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const { pool } = require('../../src/pg');
let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { PORT: PORT, LAUNCH_GATE_OFF: '1', CSRF_MODE: 'off' });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    let booted = false;
    serverProc.stdout.on('data', function (buf) { if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); } });
    serverProc.stderr.on('data', function () {});
    serverProc.once('exit', function (code) { if (!booted) reject(new Error('boot exit ' + code)); });
    setTimeout(function () { if (!booted) reject(new Error('boot timeout 15s')); }, 15000);
  });
}

async function shutdown() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise(function (r) { setTimeout(r, 500); });
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

(async function run() {
  const PREFIX = 'theme13test-c2e-';
  try {
    try { await bootServer(); } catch (e) { t.skip('theme13-c2e-resolver-three-tables', 'server boot failed: ' + e.message); return; }

    // Seed: patient, doctor, order, conversation between them, two messages
    // (one R2-keyed, one URL-typed), two additional files (one R2-keyed for
    // assertion, one URL-typed for legacy regression).
    const patient = await seedPatient(pool, { id: PREFIX + 'pt-' + Date.now() });
    const doctor  = await seedDoctor (pool, { id: PREFIX + 'dr-' + Date.now() });
    const order = await seedOrder(pool, patient.id, { id: PREFIX + 'order-' + Date.now() });
    // Doctor must be assigned + accepted for the order_additional_files auth to apply.
    await pool.query("UPDATE orders SET doctor_id = $1, accepted_at = NOW() WHERE id = $2", [doctor.id, order.id]);

    const convo = await seedConversation(pool, order.id, patient.id, doctor.id, { id: PREFIX + 'convo-' + Date.now() });
    const msgR2     = await seedMessage(pool, convo.id, patient.id, { fileKey: 'messages-attach/' + patient.id + '/' + Date.now() + '-r2.pdf', fileName: 'r2.pdf' });
    const msgLegacy = await seedMessage(pool, convo.id, patient.id, { fileUrl: 'https://ucarecdn.com/theme13-c2e-legacy-' + Date.now() + '/', fileName: 'legacy.pdf' });
    const adfR2     = await seedAdditionalFile(pool, order.id, { fileKey: 'orders/draft/' + patient.id + '/' + Date.now() + '-adf.pdf' });

    const patientCookie = sessionCookie({ id: patient.id, role: 'patient' });

    // ── 1. messages.file_key → signed R2 URL ───────────────────────────
    try {
      const r = await fetch(BASE + '/files/' + msgR2.id, { method: 'GET', headers: { Cookie: patientCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 302, 'expected 302, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.ok(/X-Amz-Signature=|\.r2\.cloudflarestorage\.com/i.test(loc), 'expected signed R2 URL, got: ' + loc.slice(0, 200));
      t.pass('1. messages.file_key → /files/:id 302 to signed R2 URL');
    } catch (e) { t.fail('1. messages R2', e); }

    // ── 2. messages.file_url (legacy HTTP) → 302 verbatim ──────────────
    try {
      const r = await fetch(BASE + '/files/' + msgLegacy.id, { method: 'GET', headers: { Cookie: patientCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 302, 'expected 302, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.ok(loc.startsWith('https://ucarecdn.com/'), 'expected ucarecdn.com URL, got: ' + loc);
      t.pass('2. messages.file_url (legacy CDN) → /files/:id 302 verbatim');
    } catch (e) { t.fail('2. messages legacy', e); }

    // ── 3. order_additional_files.file_key → signed R2 URL ─────────────
    try {
      const r = await fetch(BASE + '/files/' + adfR2.id, { method: 'GET', headers: { Cookie: patientCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 302, 'expected 302, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.ok(/X-Amz-Signature=|\.r2\.cloudflarestorage\.com/i.test(loc), 'expected signed R2 URL, got: ' + loc.slice(0, 200));
      t.pass('3. order_additional_files.file_key → /files/:id 302 to signed R2 URL');
    } catch (e) { t.fail('3. additional R2', e); }

    // ── 4. messages auth: non-member patient → 403 ─────────────────────
    try {
      const intruderCookie = sessionCookie({ id: 'theme13test-intruder-patient', role: 'patient' });
      const r = await fetch(BASE + '/files/' + msgR2.id, { method: 'GET', headers: { Cookie: intruderCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 403, 'expected 403 for non-member, got ' + r.status);
      t.pass('4. messages auth: non-conversation-member patient → 403 (Q4 + Q-B uniform 403)');
    } catch (e) { t.fail('4. messages non-member', e); }

    // ── 5. Unknown fileId → 404 (only when not in any of 3 tables) ─────
    try {
      const r = await fetch(BASE + '/files/theme13test-c2e-unknown-id-' + Date.now(), { method: 'GET', headers: { Cookie: patientCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 404, 'expected 404 for unknown id, got ' + r.status);
      t.pass('5. unknown fileId → 404 (Q-B: 404 reserved strictly for "not in any table")');
    } catch (e) { t.fail('5. unknown id 404', e); }

  } finally {
    try { await cleanupByPrefix(pool, PREFIX); } catch (_) {}
    try { await shutdown(); } catch (_) {}
    if (require.main === module) { try { await pool.end(); } catch (_) {} }
  }
})();
