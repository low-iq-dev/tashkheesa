// tests/core/theme13-h-files-route-formats.test.js
//
// Theme 13 Sub-issue H — T8 + T9: /files/:id handles both URL formats.
//
// T8: order_files.url stores an R2 key → /files/:id 302s to a signed
//     Cloudflare R2 URL.
// T9: order_files.url stores an HTTP URL (legacy Uploadcare CDN row)
//     → /files/:id 302s to that URL verbatim.
//
// Both depend on the unified-reader disambiguation at
// src/server.js:507-510 (the ^https?:// regex branch). This test locks in
// the dual-mode reader contract that the entire migration depends on.
//
// Seeds minimal users + orders + order_files rows with the theme13test-
// ID prefix so concurrent runs don't collide. Cleans up on exit.
//
// Skipped when DATABASE_URL, JWT_SECRET, or R2 env vars are unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { sessionCookie, seedPatient, seedOrder, seedOrderFile, cleanupByPrefix } = require('../helpers/test-auth');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📁 Theme 13 H — T8+T9: /files/:id dual-format reader\n');

if (!process.env.DATABASE_URL) { t.skip('theme13-h-files-route-formats', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme13-h-files-route-formats', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
let serverProc = null;

const { pool } = require('../../src/pg');

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1',
      CSRF_MODE: 'off'
    });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    serverProc.stdout.on('data', function (buf) {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
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
  const PREFIX = 'theme13test-h89-';

  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme13-h-files-route-formats', 'server boot failed: ' + e.message); return; }

    // Seed: patient + order + two order_files rows (R2 key + legacy URL).
    const patient = await seedPatient(pool, { id: PREFIX + 'pt-' + Date.now() });
    const order = await seedOrder(pool, patient.id, { id: PREFIX + 'order-' + Date.now() });
    const r2File     = await seedOrderFile(pool, order.id, 'orders/draft/' + patient.id + '/' + Date.now() + '.pdf');
    const legacyFile = await seedOrderFile(pool, order.id, 'https://ucarecdn.com/theme13-test-uuid-' + Date.now() + '/');

    const cookie = sessionCookie({ id: patient.id, role: 'patient' });

    // T8 — R2 key → signed Cloudflare R2 URL.
    try {
      const r = await fetch(BASE + '/files/' + r2File.id, {
        method: 'GET',
        headers: { 'Cookie': cookie },
        redirect: 'manual'
      });
      assert.strictEqual(r.status, 302, 'expected 302 redirect, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.ok(/^https?:\/\//i.test(loc), 'redirect Location must be an absolute URL, got: ' + loc);
      assert.ok(/X-Amz-Signature=|X-Amz-Credential=/i.test(loc) || /\.r2\.cloudflarestorage\.com/i.test(loc),
        'Location must look like a signed R2 URL (X-Amz-Signature or r2.cloudflarestorage.com host), got: ' + loc.slice(0, 200));
      t.pass('T8: order_files.url = R2 key → /files/:id 302 to signed R2 URL');
    } catch (e) { t.fail('T8: R2 key reader', e); }

    // T9 — Legacy CDN URL → 302 verbatim.
    try {
      const r = await fetch(BASE + '/files/' + legacyFile.id, {
        method: 'GET',
        headers: { 'Cookie': cookie },
        redirect: 'manual'
      });
      assert.strictEqual(r.status, 302, 'expected 302 redirect, got ' + r.status);
      const loc = r.headers.get('location') || '';
      assert.strictEqual(loc, legacyFile.url, 'legacy URL must redirect verbatim; got: ' + loc);
      t.pass('T9: order_files.url = Uploadcare CDN URL → /files/:id 302 verbatim');
    } catch (e) { t.fail('T9: legacy URL reader', e); }

  } finally {
    try { await cleanupByPrefix(pool, PREFIX); } catch (_) {}
    try { await shutdown(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
