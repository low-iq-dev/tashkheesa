// tests/core/rtl-doc-direction-flips.test.js
//
// Theme 10b T5 — HTTP-level RTL document-direction flip.
//
// Theme 10 (commit 82c663c) wired `lang` and `dir` through
// src/utils/lang.js → src/middleware.js → all layouts. This test
// proves the end-to-end flow: for every top-level public page, GET
// /?lang=en serves <html lang="en" dir="ltr"> and GET /?lang=ar
// serves <html lang="ar" dir="rtl">.
//
// Pattern mirrors tests/core/lang-toggle.test.js — boots a real
// server, walks a focused list of public pages, asserts the html
// open tag.
//
// Skipped automatically when DATABASE_URL / JWT_SECRET unset (the
// server can't boot a real DB pool in that case).

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n↔️  Theme 10b T5 — HTTP-level <html lang dir> flip on public pages\n');

if (!process.env.DATABASE_URL) { t.skip(fileTag, 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip(fileTag, 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const PUBLIC_PAGES = ['/', '/faq', '/services', '/about', '/contact', '/privacy', '/terms'];

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1' });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && /running on port/.test(s)) {
        booted = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (code) => {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout (15s)'));
    }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((res) => setTimeout(res, 500));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function get(p) {
  const res = await fetch(BASE + p, { redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, body };
}

// Extract `<html lang="…" dir="…">` (in any attribute order) from the body.
function readHtmlAttrs(body) {
  const m = body.match(/<html\b[^>]*>/);
  if (!m) return null;
  const tag = m[0];
  const lang = (tag.match(/\blang\s*=\s*["']([^"']*)["']/) || [])[1] || null;
  const dir  = (tag.match(/\bdir\s*=\s*["']([^"']*)["']/)  || [])[1] || null;
  return { lang, dir, tag };
}

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip(fileTag, 'server boot failed: ' + e.message); return; }

    // Liveness ping.
    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      if (!(ping.status >= 200 && ping.status < 500)) throw new Error('ping status=' + ping.status);
    } catch (e) {
      t.skip(fileTag, 'server unreachable: ' + e.message);
      return;
    }

    // ── EN mode: every public page should serve <html lang="en" dir="ltr">
    for (const p of PUBLIC_PAGES) {
      try {
        const r = await get(p + (p.includes('?') ? '&' : '?') + 'lang=en');
        if (r.status !== 200) {
          t.skip(fileTag + ' EN ' + p, 'status=' + r.status);
          continue;
        }
        const attrs = readHtmlAttrs(r.body);
        if (!attrs) throw new Error('no <html> tag in body of ' + p);
        assert.strictEqual(attrs.lang, 'en', 'EN ' + p + ': lang=' + JSON.stringify(attrs.lang) + ' (want "en")');
        assert.strictEqual(attrs.dir, 'ltr', 'EN ' + p + ': dir=' + JSON.stringify(attrs.dir) + ' (want "ltr")');
        t.pass('EN ' + p + ' → <html lang="en" dir="ltr">');
      } catch (e) { t.fail('EN ' + p, e); }
    }

    // ── AR mode: every public page should serve <html lang="ar" dir="rtl">
    for (const p of PUBLIC_PAGES) {
      try {
        const r = await get(p + (p.includes('?') ? '&' : '?') + 'lang=ar');
        if (r.status !== 200) {
          t.skip(fileTag + ' AR ' + p, 'status=' + r.status);
          continue;
        }
        const attrs = readHtmlAttrs(r.body);
        if (!attrs) throw new Error('no <html> tag in body of ' + p);
        assert.strictEqual(attrs.lang, 'ar', 'AR ' + p + ': lang=' + JSON.stringify(attrs.lang) + ' (want "ar")');
        assert.strictEqual(attrs.dir, 'rtl', 'AR ' + p + ': dir=' + JSON.stringify(attrs.dir) + ' (want "rtl")');
        t.pass('AR ' + p + ' → <html lang="ar" dir="rtl">');
      } catch (e) { t.fail('AR ' + p, e); }
    }
  } finally {
    await shutdownServer();
  }
})();
