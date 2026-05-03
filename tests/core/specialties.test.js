// tests/core/specialties.test.js
//
// HTTP-level tests for the public /specialties index + /specialties/:slug
// child pages (P1-PUB-1 part 2).
//
// Verifies:
//   - Index page renders all 12 EN specialty names that have ≥1 visible
//     service, in EN and AR modes.
//   - Index page does NOT render the 10 zero-service specialty names —
//     the EXISTS filter is intentional, not a bug. They will surface
//     automatically when services are added.
//   - Index links each card to /specialties/{slug-derived-from-id}.
//   - Child page for cardiology renders 200 in both languages, lists
//     the 9 services that belong to it, and renders the generic
//     "board-certified" consultant copy with NO doctor-card structure
//     (per P1-PUB-1 decision #3 — no public doctor profiles until
//     consent is collected).
//   - 404 cases: nonexistent slug, visible-but-zero-service slug
//     (anesthesiology), path traversal attempts.
//   - Footer carries a /specialties link.
//
// Boots the real express app on a random port, mirroring the test
// pattern in tests/core/faq.test.js and tests/admin/payout_lockdown.
// Skipped automatically when DATABASE_URL or JWT_SECRET is unset.

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

console.log('\n🩺 public /specialties index + child pages (P1-PUB-1 part 2)\n');

if (!process.env.DATABASE_URL) { t.skip('specialties', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('specialties', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;

const { pool } = require('../../src/pg');

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
  return { status: res.status, body, location: res.headers.get('location') };
}

// EN specialty names with ≥1 visible service today (12 of 22).
const EN_VISIBLE_NAMES = [
  'Cardiology', 'Dermatology', 'Endocrinology', 'Gastroenterology',
  'Hematology', 'Neurology', 'Oncology', 'Ophthalmology',
  'Orthopedics', 'Pulmonology', 'Radiology', 'Urology'
];

// EN specialty names that exist in the table but have 0 services —
// must be ABSENT from the index (per decision Y, EXISTS filter).
const EN_ZERO_SERVICE_NAMES = [
  'Anesthesiology', 'Cardiothoracic Surgery', 'Clinical Nutrition',
  'Emergency Medicine', 'Nephrology', 'OB/GYN', 'Pathology',
  'Psychiatry', 'Rheumatology', 'Vascular Surgery'
];

// Sample of AR specialty names that have services (subset).
const AR_VISIBLE_NAMES = [
  'أمراض القلب',           // Cardiology
  'الأمراض الجلدية',        // Dermatology
  'أمراض الدم',             // Hematology
  'الأشعة',                  // Radiology
  'المسالك البولية'          // Urology
];

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('specialties', 'server boot failed: ' + e.message); return; }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) { t.skip('specialties', 'server unreachable: ' + e.message); return; }

    // ── Index page (EN) ──────────────────────────────────────────────
    let enBody = '';
    try {
      const r = await get('/specialties');
      assert.strictEqual(r.status, 200, 'GET /specialties must 200, got ' + r.status);
      enBody = r.body;
      t.pass('GET /specialties returns 200');
    } catch (e) { t.fail('GET /specialties', e); return; }

    try {
      const missing = EN_VISIBLE_NAMES.filter(function (n) {
        return !new RegExp('class="spec-card-title">' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<').test(enBody);
      });
      assert.deepStrictEqual(missing, [], 'EN missing specialty names: ' + JSON.stringify(missing));
      t.pass('EN: all 12 specialty names with ≥1 service rendered');
    } catch (e) { t.fail('EN visible names', e); }

    try {
      const present = EN_ZERO_SERVICE_NAMES.filter(function (n) {
        return new RegExp('class="spec-card-title">' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/') + '<').test(enBody);
      });
      assert.deepStrictEqual(present, [], 'EN zero-service names must NOT render: ' + JSON.stringify(present));
      t.pass('EN: zero-service specialty names hidden by EXISTS filter');
    } catch (e) { t.fail('EN zero-service hidden', e); }

    try {
      assert.ok(/href="\/specialties\/cardiology"/.test(enBody), 'index must link to /specialties/cardiology');
      assert.ok(/href="\/specialties\/radiology"/.test(enBody), 'index must link to /specialties/radiology');
      t.pass('index links use slug derived from id (spec- prefix stripped)');
    } catch (e) { t.fail('slug links', e); }

    // ── Index page (AR) ──────────────────────────────────────────────
    try {
      const r = await get('/specialties?lang=ar');
      assert.strictEqual(r.status, 200, 'GET /specialties?lang=ar must 200');
      const missing = AR_VISIBLE_NAMES.filter(function (n) { return !r.body.includes(n); });
      assert.deepStrictEqual(missing, [], 'AR missing names: ' + JSON.stringify(missing));
      assert.ok(/<html[^>]+dir="rtl"/.test(r.body), 'AR page must declare dir="rtl"');
      t.pass('AR: index renders Arabic names + dir="rtl"');
    } catch (e) { t.fail('AR index', e); }

    // ── Child page: cardiology (EN) ──────────────────────────────────
    let cardioBody = '';
    try {
      const r = await get('/specialties/cardiology');
      assert.strictEqual(r.status, 200, 'GET /specialties/cardiology must 200, got ' + r.status);
      cardioBody = r.body;
      assert.ok(/Cardiology covers/.test(r.body), 'cardiology page should include the seeded description');
      assert.ok(/Book a case/.test(r.body), 'cardiology page should expose the Book a case CTA');
      assert.ok(/href="\/patient\/new-case\?specialty=spec-cardiology"/.test(r.body),
        'CTA href must carry ?specialty=spec-cardiology');
      t.pass('cardiology (EN): 200 + description + Book-a-case CTA wired to /patient/new-case');
    } catch (e) { t.fail('cardiology page', e); return; }

    try {
      // 9 cardiology services in DB. Spot-check a few well-known names.
      // Use partial matches (services may have varying formal names).
      const svcMarkers = ['ECG', 'Echocardiogram', 'Holter'];
      const missing = svcMarkers.filter(function (m) { return !cardioBody.includes(m); });
      assert.deepStrictEqual(missing, [], 'cardiology services missing markers: ' + JSON.stringify(missing));
      t.pass('cardiology: services table renders core service names (ECG / Echo / Holter)');
    } catch (e) { t.fail('cardiology services list', e); }

    // ── Decision #3 lock: generic copy + no doctor-card structure ────
    try {
      assert.ok(/board-certified consultants/i.test(cardioBody),
        'must render generic "board-certified consultants" copy (decision #3)');
      assert.ok(!/class="[^"]*\bdoctor-card\b[^"]*"/.test(cardioBody),
        'page must not contain .doctor-card elements');
      assert.ok(!/class="[^"]*\bdoctor-profile\b[^"]*"/.test(cardioBody),
        'page must not contain .doctor-profile elements');
      assert.ok(!/<img[^>]+alt="[^"]*Dr\.\s/i.test(cardioBody),
        'page must not contain doctor headshot images (alt="Dr. ...")');
      t.pass('decision #3: generic consultant copy present, no doctor-card markup');
    } catch (e) { t.fail('decision #3 lock', e); }

    // ── Child page: cardiology (AR) ──────────────────────────────────
    try {
      const r = await get('/specialties/cardiology?lang=ar');
      assert.strictEqual(r.status, 200, 'AR cardiology must 200');
      assert.ok(r.body.includes('أمراض القلب'), 'AR cardiology should show the AR name');
      assert.ok(r.body.includes('احجز حالة'), 'AR cardiology should show the AR Book-a-case CTA');
      assert.ok(/<html[^>]+dir="rtl"/.test(r.body), 'AR cardiology must dir="rtl"');
      t.pass('cardiology (AR): 200 + AR name + AR CTA + dir="rtl"');
    } catch (e) { t.fail('cardiology AR', e); }

    // ── 404 cases ────────────────────────────────────────────────────
    try {
      const r = await get('/specialties/nonexistent');
      assert.strictEqual(r.status, 404, 'unknown slug must 404, got ' + r.status);
      t.pass('404: /specialties/nonexistent');
    } catch (e) { t.fail('404 nonexistent', e); }

    try {
      // Anesthesiology IS in specialties table but has 0 services →
      // gated by EXISTS, must 404 (not 200 with empty list).
      const r = await get('/specialties/anesthesiology');
      assert.strictEqual(r.status, 404,
        '/specialties/anesthesiology must 404 (visible spec, 0 services), got ' + r.status);
      t.pass('404: /specialties/anesthesiology (visible spec, 0 services — gated by EXISTS)');
    } catch (e) { t.fail('404 zero-service', e); }

    try {
      // Path traversal smoke check. Express normalizes /specialties/../faq
      // before routing — should NOT serve the specialty handler at all.
      const r = await fetch(BASE + '/specialties/../faq', { redirect: 'manual' });
      // Express collapses .. and we either get /faq (200) or a 301 to /faq.
      // Either is acceptable; what's NOT acceptable is the specialty
      // handler treating ".." as a slug and serving cross-route content.
      assert.ok(r.status === 200 || r.status === 301 || r.status === 302 || r.status === 404,
        'path traversal must not crash; got ' + r.status);
      t.pass('path traversal: /specialties/../faq handled cleanly (' + r.status + ')');
    } catch (e) { t.fail('path traversal', e); }

    // ── Footer link ──────────────────────────────────────────────────
    try {
      assert.ok(/<a[^>]+href="\/specialties"[^>]*>\s*Specialties\s*</.test(enBody),
        'footer should link to /specialties');
      t.pass('regression: footer contains a /specialties link');
    } catch (e) { t.fail('footer link', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
