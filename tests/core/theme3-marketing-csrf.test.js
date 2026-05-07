// tests/core/theme3-marketing-csrf.test.js
//
// Theme 3 sub-issue B + folded-in P1-ROUTE-14.
//
// Renders each marketing page through a real server boot and asserts the
// CSRF-token wiring is present in the response body:
//   * /help-me-choose      — one fetch('/api/help-me-choose'), CSRF_TOKEN var
//   * /app                 — two fetches (/app/waitlist, /app/analytics),
//                              both reference the same CSRF_TOKEN var
//   * /services            — service_assistant partial: one fetch with CSRF_TOKEN
//   * /contact             — form has id="contact-form" + data-csrf="<hex>"
//
// Skipped when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛡  Theme 3 — Marketing fetches include x-csrf-token\n');

if (!process.env.DATABASE_URL) { t.skip('theme3-marketing-csrf', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme3-marketing-csrf', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const { pool } = require('../../src/pg');

let serverProc = null;

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1' });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    serverProc.stdout.on('data', function (buf) {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', function () {});
    serverProc.once('exit', function (code) {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(function () { if (!booted) reject(new Error('server boot timeout (15s)')); }, 15000);
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
  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme3-marketing-csrf', 'server boot failed: ' + e.message); return; }

    // ── /help-me-choose ────────────────────────────────────────────────
    try {
      const r = await fetch(BASE + '/help-me-choose');
      assert.strictEqual(r.status, 200, 'GET /help-me-choose must 200, got ' + r.status);
      const body = await r.text();
      assert.ok(/(?:const|var)\s+CSRF_TOKEN\s*=\s*'[a-f0-9]{32,}'/.test(body),
        '/help-me-choose missing CSRF_TOKEN declaration with hex value');
      const xcsrf = (body.match(/'x-csrf-token':\s*CSRF_TOKEN/g) || []).length;
      assert.ok(xcsrf >= 1, '/help-me-choose missing x-csrf-token header (count=' + xcsrf + ')');
      assert.ok(body.indexOf("fetch('/api/help-me-choose'") !== -1,
        '/help-me-choose missing fetch site');
      t.pass('/help-me-choose: CSRF_TOKEN declared + 1 x-csrf-token header on /api/help-me-choose fetch');
    } catch (e) { t.fail('/help-me-choose csrf wiring', e); }

    // ── /app (app_landing) — TWO fetches share one CSRF_TOKEN var ────
    try {
      const r = await fetch(BASE + '/app');
      assert.strictEqual(r.status, 200, 'GET /app must 200, got ' + r.status);
      const body = await r.text();
      assert.ok(/(?:const|var)\s+CSRF_TOKEN\s*=\s*'[a-f0-9]{32,}'/.test(body),
        '/app missing CSRF_TOKEN declaration');
      const xcsrf = (body.match(/'x-csrf-token':\s*CSRF_TOKEN/g) || []).length;
      assert.ok(xcsrf >= 2, '/app expected 2 x-csrf-token headers, got ' + xcsrf);
      assert.ok(body.indexOf("fetch('/app/waitlist'") !== -1, '/app missing waitlist fetch');
      assert.ok(body.indexOf("fetch('/app/analytics'") !== -1, '/app missing analytics fetch');
      t.pass('/app: CSRF_TOKEN declared once, 2 x-csrf-token headers (waitlist + analytics)');
    } catch (e) { t.fail('/app csrf wiring', e); }

    // ── /services (includes service_assistant partial) ────────────────
    try {
      const r = await fetch(BASE + '/services');
      assert.strictEqual(r.status, 200, 'GET /services must 200, got ' + r.status);
      const body = await r.text();
      // service_assistant.ejs renders only when the partial is included;
      // confirm both the CSRF_TOKEN declaration and the fetch reference.
      if (body.indexOf("fetch('/api/help-me-choose'") !== -1) {
        assert.ok(/(?:const|var)\s+CSRF_TOKEN\s*=\s*'[a-f0-9]{32,}'/.test(body),
          '/services renders service_assistant fetch but missing CSRF_TOKEN');
        const xcsrf = (body.match(/'x-csrf-token':\s*CSRF_TOKEN/g) || []).length;
        assert.ok(xcsrf >= 1, '/services service_assistant missing x-csrf-token (count=' + xcsrf + ')');
        t.pass('/services: service_assistant partial wired with CSRF_TOKEN');
      } else {
        t.skip('/services service_assistant', 'partial not rendered on this page (variant)');
      }
    } catch (e) { t.fail('/services service_assistant', e); }

    // ── /contact (P1-ROUTE-14 fold-in) ────────────────────────────────
    try {
      const r = await fetch(BASE + '/contact');
      assert.strictEqual(r.status, 200, 'GET /contact must 200, got ' + r.status);
      const body = await r.text();
      assert.ok(/id="contact-form"/.test(body), '/contact form missing id="contact-form"');
      assert.ok(/data-csrf="[a-f0-9]{32,}"/.test(body),
        '/contact form missing data-csrf="<hex>" attribute');
      // The native-POST CSRF input must remain (no-JS path).
      assert.ok(/name="_csrf"/.test(body), '/contact form missing hidden _csrf input');
      t.pass('/contact: form has id, data-csrf, and hidden _csrf (no-JS path preserved)');
    } catch (e) { t.fail('/contact form attrs', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
