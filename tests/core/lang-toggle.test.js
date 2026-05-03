// tests/core/lang-toggle.test.js
//
// HTTP-level tests for the global language toggle in the public site
// header (added alongside the /faq page in the P1-PUB-1 partial fix).
//
// Verifies the toggle is present on every patient-facing public page
// served by setupStaticPages, points at the existing /lang/:code?next=
// route (sanitizer in src/routes/lang.js), shows the correct *target*
// language label, and strips any incoming ?lang= query from the next URL
// (otherwise the query param would beat the cookie set by /lang/:code,
// per middleware.js:196).
//
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

console.log('\n🌐 public site language toggle\n');

if (!process.env.DATABASE_URL) { t.skip('lang-toggle', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('lang-toggle', 'JWT_SECRET not set');   return; }

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
  return { status: res.status, body, headers: res.headers, location: res.headers.get('location') };
}

// Public pages that share the public layout — toggle must appear on all.
const PUBLIC_PAGES = ['/faq', '/services', '/about', '/contact', '/privacy', '/terms', '/refund-policy', '/delivery-policy'];

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('lang-toggle', 'server boot failed: ' + e.message); return; }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) { t.skip('lang-toggle', 'server unreachable: ' + e.message); return; }

    // ── Toggle present on every public page (EN default) ─────────────
    for (const p of PUBLIC_PAGES) {
      try {
        const r = await get(p);
        assert.strictEqual(r.status, 200, 'GET ' + p + ' must 200, got ' + r.status);
        assert.ok(/data-lang-toggle="ar"/.test(r.body), 'EN nav on ' + p + ' must show toggle pointing at AR');
        assert.ok(/>العربية</.test(r.body), 'EN nav on ' + p + ' must label toggle "العربية"');
        const m = r.body.match(/href="(\/lang\/ar\?next=[^"]*)"/);
        assert.ok(m, 'EN nav on ' + p + ' must contain a /lang/ar?next=... href');
        assert.ok(m[1].includes('next=' + encodeURIComponent(p)), 'next= must encode ' + p + ', got ' + m[1]);
        t.pass('toggle: ' + p + ' (EN) → /lang/ar?next=' + encodeURIComponent(p));
      } catch (e) { t.fail('toggle EN ' + p, e); }
    }

    // ── Toggle present on AR variant of /faq ─────────────────────────
    try {
      const r = await get('/faq?lang=ar');
      assert.strictEqual(r.status, 200, 'GET /faq?lang=ar must 200');
      assert.ok(/data-lang-toggle="en"/.test(r.body), 'AR nav must show toggle pointing at EN');
      assert.ok(/>English</.test(r.body), 'AR nav must label toggle "English"');
      const m = r.body.match(/href="(\/lang\/en\?next=[^"]*)"/);
      assert.ok(m, 'AR nav must contain a /lang/en?next=... href');
      // CRITICAL: ?lang=ar must be stripped from next, otherwise the cookie
      // change is silently overridden by the query param when the user
      // lands on the next page.
      assert.ok(!m[1].includes('lang%3D'), 'next= must strip ?lang= from current URL, got ' + m[1]);
      assert.ok(m[1].includes('next=' + encodeURIComponent('/faq')), 'next= should be just /faq, got ' + m[1]);
      t.pass('toggle: /faq?lang=ar (AR) → /lang/en?next=/faq (lang param stripped)');
    } catch (e) { t.fail('toggle AR /faq', e); }

    // ── Round-trip: GET the toggle URL → 302 → cookie → next page ────
    try {
      const r = await fetch(BASE + '/lang/ar?next=/faq', { redirect: 'manual' });
      assert.strictEqual(r.status, 302, 'GET /lang/ar?next=/faq must 302, got ' + r.status);
      assert.strictEqual(r.headers.get('location'), '/faq', 'must redirect to /faq');
      const setCookie = String(r.headers.get('set-cookie') || '');
      assert.ok(/lang=ar/.test(setCookie), 'must set lang=ar cookie, got: ' + setCookie);
      t.pass('round-trip: /lang/ar?next=/faq → 302 /faq + lang=ar cookie');
    } catch (e) { t.fail('round-trip lang switch', e); }

    // ── Other querystrings preserved across toggle ───────────────────
    try {
      const r = await get('/services?spec=cardiology');
      const m = r.body.match(/href="(\/lang\/ar\?next=[^"]*)"/);
      assert.ok(m, 'toggle href found on /services?spec=cardiology');
      assert.ok(decodeURIComponent(m[1]).includes('spec=cardiology'),
        'next= must preserve non-lang query params, got ' + m[1]);
      t.pass('toggle preserves non-lang query params (spec=cardiology)');
    } catch (e) { t.fail('preserve query params', e); }

    // ── Mobile hamburger trigger present on shared layout ────────────
    try {
      const r = await get('/faq');
      assert.ok(/data-public-nav-toggle/.test(r.body), 'shared layout must include hamburger trigger');
      assert.ok(/<button[^>]*class="menu-toggle"/.test(r.body), 'shared layout must include .menu-toggle button');
      t.pass('mobile: shared layout includes hamburger trigger button');
    } catch (e) { t.fail('hamburger present', e); }

    // ── EN nav labels (canonical English) ────────────────────────────
    try {
      const r = await get('/faq');
      const enLabels = ['Services', 'About', 'Contact', 'Sign In'];
      const missing = enLabels.filter(label => !new RegExp('class="nav-link[^"]*">' + label + '<').test(r.body));
      assert.deepStrictEqual(missing, [], 'EN nav missing: ' + JSON.stringify(missing));
      t.pass('EN nav labels: Services / About / Contact / Sign In');
    } catch (e) { t.fail('EN nav labels', e); }

    // ── AR nav labels (translated) ───────────────────────────────────
    try {
      const r = await get('/faq?lang=ar');
      const arLabels = [
        { ar: 'الخدمات',        en: 'Services' },
        { ar: 'من نحن',         en: 'About' },
        { ar: 'اتصل بنا',       en: 'Contact' },
        { ar: 'تسجيل الدخول',   en: 'Sign In' }
      ];
      for (const lab of arLabels) {
        assert.ok(r.body.includes('>' + lab.ar + '<'), 'AR nav missing label "' + lab.ar + '" (was: ' + lab.en + ')');
        // The English version must NOT appear inside a nav-link in AR mode.
        assert.ok(!new RegExp('class="nav-link[^"]*">' + lab.en + '<').test(r.body),
          'AR nav must not contain English label "' + lab.en + '"');
      }
      t.pass('AR nav labels: الخدمات / من نحن / اتصل بنا / تسجيل الدخول');
    } catch (e) { t.fail('AR nav labels', e); }

    // ── EN footer labels ─────────────────────────────────────────────
    try {
      const r = await get('/faq');
      const enFooter = ['Services &amp; Pricing', 'About Us', 'FAQ', 'Contact Us', 'Privacy Policy', 'Terms of Service', 'Refund &amp; Cancellation', 'Delivery Policy', 'Cairo, Egypt'];
      const missing = enFooter.filter(s => !r.body.includes(s));
      assert.deepStrictEqual(missing, [], 'EN footer missing: ' + JSON.stringify(missing));
      t.pass('EN footer labels intact');
    } catch (e) { t.fail('EN footer labels', e); }

    // ── AR footer labels ─────────────────────────────────────────────
    try {
      const r = await get('/faq?lang=ar');
      const arFooter = [
        'الخدمات والأسعار', 'من نحن', 'الأسئلة الشائعة', 'اتصل بنا',
        'سياسة الخصوصية', 'شروط الخدمة', 'الاسترداد والإلغاء', 'سياسة التسليم',
        'القاهرة، مصر', 'تواصل معنا', 'السياسات'
      ];
      const missing = arFooter.filter(s => !r.body.includes(s));
      assert.deepStrictEqual(missing, [], 'AR footer missing: ' + JSON.stringify(missing));
      // AR footer must not regress to English column titles.
      assert.ok(!/footer-col-title">Legal</.test(r.body), 'AR footer must not contain "Legal"');
      assert.ok(!/footer-col-title">Services</.test(r.body), 'AR footer must not contain English "Services" column');
      t.pass('AR footer labels translated, no English regression');
    } catch (e) { t.fail('AR footer labels', e); }
  } finally {
    try { await shutdownServer(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
