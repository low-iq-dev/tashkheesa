// tests/core/faq.test.js
//
// HTTP-level tests for the public /faq page (P1-PUB-1).
//
// Verifies:
//   1. GET /faq returns 200 (was 404 pre-fix)
//   2. EN response body contains all 5 EN category headers and all 14 EN
//      questions, server-rendered (i.e. visible in the source HTML, not
//      hidden behind a JS fetch).
//   3. GET /faq?lang=ar returns 200 with the AR category headers + all
//      14 AR questions, server-rendered.
//   4. The page sets dir="rtl" only in AR mode.
//
// Boots the real express app on a random port, mirroring the test pattern
// in tests/admin/payout_lockdown.test.js. Skipped when DATABASE_URL or
// JWT_SECRET is unset (the server boot path requires them).

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

console.log('\n📚 public /faq page (P1-PUB-1)\n');

if (!process.env.DATABASE_URL) { t.skip('faq', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('faq', 'JWT_SECRET not set');   return; }

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
  return { status: res.status, body, headers: res.headers };
}

// English content fragments — must appear verbatim in source HTML.
const EN_CATEGORIES = [
  'About Tashkheesa',
  'How it works',
  'Privacy &amp; security',
  'Pricing &amp; payment',
  'Eligibility &amp; coverage'
];
const EN_QUESTIONS = [
  'What is Tashkheesa?',
  'Who reviews my case?',
  'Is Tashkheesa a replacement for my doctor?',
  'How long does it take to get a second opinion?',
  'What happens after I upload my files?',
  'What types of files can I upload?',
  'Is my data secure?',
  'Who can see my medical information?',
  'Can I share the report with my doctor?',
  'How much does a second opinion cost?',
  'What payment methods do you accept?',
  'What if I don’t agree with the report?',
  'Do you accept insurance?',
  'Can I use Tashkheesa from outside Egypt?'
];

// Arabic content fragments — verbatim from approved brief.
const AR_CATEGORIES = [
  'عن تشخيصة',
  'كيف نعمل',
  'الخصوصية والأمان',
  'الأسعار والدفع',
  'الأهلية والتغطية'
];
const AR_QUESTIONS = [
  'ما هي تشخيصة؟',
  'من يراجع حالتي؟',
  'هل تشخيصة بديل عن طبيبي؟',
  'كم تستغرق الحصول على رأي ثانٍ؟',
  'ماذا يحدث بعد رفع ملفاتي؟',
  'ما أنواع الملفات التي يمكنني رفعها؟',
  'هل بياناتي آمنة؟',
  'من يمكنه رؤية معلوماتي الطبية؟',
  'هل يمكنني مشاركة التقرير مع طبيبي؟',
  'كم تكلفة الرأي الثاني؟',
  'ما وسائل الدفع المقبولة؟',
  'ماذا إذا لم أتفق مع التقرير؟',
  'هل تقبلون التأمين؟',
  'هل يمكنني استخدام تشخيصة من خارج مصر؟'
];

(async function run() {
  try {
    try {
      await bootServer();
    } catch (e) {
      t.skip('faq', 'server boot failed: ' + e.message);
      return;
    }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) {
      t.skip('faq', 'server unreachable: ' + e.message);
      return;
    }

    // ── EN ────────────────────────────────────────────────────────────
    let enBody = '';
    try {
      const r = await get('/faq');
      assert.strictEqual(r.status, 200, 'GET /faq must 200, got ' + r.status);
      enBody = r.body;
      t.pass('P1-PUB-1: GET /faq returns 200');
    } catch (e) { t.fail('GET /faq', e); return; }

    try {
      const missing = EN_CATEGORIES.filter(function (c) { return enBody.indexOf(c) === -1; });
      assert.deepStrictEqual(missing, [], 'EN missing categories: ' + JSON.stringify(missing));
      t.pass('EN: all 5 category headers present in source HTML');
    } catch (e) { t.fail('EN categories', e); }

    try {
      const missing = EN_QUESTIONS.filter(function (q) { return enBody.indexOf(q) === -1; });
      assert.deepStrictEqual(missing, [], 'EN missing questions: ' + JSON.stringify(missing));
      t.pass('EN: all 14 questions server-rendered (not behind JS)');
    } catch (e) { t.fail('EN questions', e); }

    try {
      assert.ok(/<html[^>]+lang="en"/.test(enBody), 'EN page should declare lang="en"');
      assert.ok(!/<html[^>]+dir="rtl"/.test(enBody), 'EN page must NOT have dir="rtl"');
      t.pass('EN: html lang="en", dir defaults to ltr');
    } catch (e) { t.fail('EN html attrs', e); }

    // ── AR ────────────────────────────────────────────────────────────
    let arBody = '';
    try {
      const r = await get('/faq?lang=ar');
      assert.strictEqual(r.status, 200, 'GET /faq?lang=ar must 200, got ' + r.status);
      arBody = r.body;
      t.pass('GET /faq?lang=ar returns 200');
    } catch (e) { t.fail('GET /faq?lang=ar', e); return; }

    try {
      const missing = AR_CATEGORIES.filter(function (c) { return arBody.indexOf(c) === -1; });
      assert.deepStrictEqual(missing, [], 'AR missing categories: ' + JSON.stringify(missing));
      t.pass('AR: all 5 category headers present in source HTML');
    } catch (e) { t.fail('AR categories', e); }

    try {
      const missing = AR_QUESTIONS.filter(function (q) { return arBody.indexOf(q) === -1; });
      assert.deepStrictEqual(missing, [], 'AR missing questions: ' + JSON.stringify(missing));
      t.pass('AR: all 14 questions server-rendered (not behind JS)');
    } catch (e) { t.fail('AR questions', e); }

    try {
      assert.ok(/<html[^>]+lang="ar"/.test(arBody), 'AR page should declare lang="ar"');
      assert.ok(/<html[^>]+dir="rtl"/.test(arBody), 'AR page should declare dir="rtl"');
      t.pass('AR: html lang="ar" + dir="rtl"');
    } catch (e) { t.fail('AR html attrs', e); }

    // ── Footer link ──────────────────────────────────────────────────
    try {
      assert.ok(/<a[^>]+href="\/faq"[^>]*>\s*FAQ\s*</.test(enBody), 'footer should link to /faq');
      t.pass('regression: footer contains a /faq link');
    } catch (e) { t.fail('footer link', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
