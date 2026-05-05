// tests/core/blog.test.js
//
// HTTP-level tests for the public /blog index + post pages (P1-PUB-1 part 3).
//
// Verifies:
//   1. GET /blog returns 200 EN + 200 AR (was 404 pre-fix)
//   2. Index lists both post slugs as links
//   3. GET /blog/<slug> returns 200 for both posts in EN + AR
//   4. AR responses set dir="rtl" + lang="ar"; EN responses do not
//   5. Unknown slug returns 404
//   6. Footer link to /blog appears on a non-blog public page (regression
//      against the partials/footer.ejs change)
//
// Boots the real express app on a random port — same pattern as
// tests/core/faq.test.js. Skipped when DATABASE_URL or JWT_SECRET is unset.

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

console.log('\n📚 public /blog index + posts (P1-PUB-1)\n');

if (!process.env.DATABASE_URL) { t.skip('blog', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('blog', 'JWT_SECRET not set');   return; }

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

const POSTS = [
  {
    slug: 'when-to-get-medical-second-opinion',
    en_title: 'When Should You Get a Medical Second Opinion?',
    ar_title: 'إمتى تاخد رأي طبي تاني؟',
    en_marker: '5 Signs You Should Seek a Second Opinion',
    ar_marker: '٥ علامات إنك محتاج رأي طبي تاني'
  },
  {
    slug: 'how-tashkheesa-works',
    en_title: 'How Tashkheesa Works: Get a Second Opinion in 3 Steps',
    ar_title: 'إزاي تشخيصة بتشتغل: رأي تاني في ٣ خطوات',
    en_marker: 'The 3-Step Process',
    ar_marker: 'الـ ٣ خطوات'
  }
];

(async function run() {
  try {
    try {
      await bootServer();
    } catch (e) {
      t.skip('blog', 'server boot failed: ' + e.message);
      return;
    }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) {
      t.skip('blog', 'server unreachable: ' + e.message);
      return;
    }

    // ── Index EN ───────────────────────────────────────────────────────
    let idxEn = '';
    try {
      const r = await get('/blog');
      assert.strictEqual(r.status, 200, 'GET /blog must 200, got ' + r.status);
      idxEn = r.body;
      t.pass('P1-PUB-1: GET /blog returns 200');
    } catch (e) { t.fail('GET /blog', e); return; }

    try {
      assert.ok(/<html[^>]+lang="en"/.test(idxEn), 'EN index lang="en"');
      assert.ok(!/<html[^>]+dir="rtl"/.test(idxEn), 'EN index must not be RTL');
      t.pass('EN index: lang="en", dir defaults to ltr');
    } catch (e) { t.fail('EN index html attrs', e); }

    try {
      POSTS.forEach(function (p) {
        assert.ok(idxEn.indexOf('/blog/' + p.slug) !== -1, 'index missing link to /blog/' + p.slug);
        assert.ok(idxEn.indexOf(p.en_title) !== -1, 'index missing EN title: ' + p.en_title);
      });
      t.pass('EN index lists both post links + EN titles');
    } catch (e) { t.fail('EN index post links', e); }

    // ── Index AR ───────────────────────────────────────────────────────
    let idxAr = '';
    try {
      const r = await get('/blog?lang=ar');
      assert.strictEqual(r.status, 200, 'GET /blog?lang=ar must 200');
      idxAr = r.body;
      t.pass('GET /blog?lang=ar returns 200');
    } catch (e) { t.fail('GET /blog?lang=ar', e); return; }

    try {
      assert.ok(/<html[^>]+lang="ar"/.test(idxAr), 'AR index lang="ar"');
      assert.ok(/<html[^>]+dir="rtl"/.test(idxAr), 'AR index dir="rtl"');
      t.pass('AR index: lang="ar" + dir="rtl"');
    } catch (e) { t.fail('AR index html attrs', e); }

    try {
      POSTS.forEach(function (p) {
        assert.ok(idxAr.indexOf(p.ar_title) !== -1, 'AR index missing AR title: ' + p.ar_title);
      });
      t.pass('AR index lists both AR post titles');
    } catch (e) { t.fail('AR index titles', e); }

    // ── Individual posts EN ───────────────────────────────────────────
    for (const p of POSTS) {
      try {
        const r = await get('/blog/' + p.slug);
        assert.strictEqual(r.status, 200, 'GET /blog/' + p.slug + ' must 200');
        assert.ok(r.body.indexOf(p.en_title) !== -1, 'EN body missing title: ' + p.en_title);
        assert.ok(r.body.indexOf(p.en_marker) !== -1, 'EN body missing marker: ' + p.en_marker);
        assert.ok(/<html[^>]+lang="en"/.test(r.body), 'EN post lang="en"');
        t.pass('EN /blog/' + p.slug + ': 200 + content rendered');
      } catch (e) { t.fail('EN /blog/' + p.slug, e); }
    }

    // ── Individual posts AR ───────────────────────────────────────────
    for (const p of POSTS) {
      try {
        const r = await get('/blog/' + p.slug + '?lang=ar');
        assert.strictEqual(r.status, 200, 'GET /blog/' + p.slug + '?lang=ar must 200');
        assert.ok(r.body.indexOf(p.ar_title) !== -1, 'AR body missing title: ' + p.ar_title);
        assert.ok(r.body.indexOf(p.ar_marker) !== -1, 'AR body missing marker: ' + p.ar_marker);
        assert.ok(/<html[^>]+lang="ar"/.test(r.body), 'AR post lang="ar"');
        assert.ok(/<html[^>]+dir="rtl"/.test(r.body), 'AR post dir="rtl"');
        t.pass('AR /blog/' + p.slug + ': 200 + RTL + content rendered');
      } catch (e) { t.fail('AR /blog/' + p.slug, e); }
    }

    // ── Unknown slug → 404 ────────────────────────────────────────────
    try {
      const r = await get('/blog/this-post-does-not-exist');
      assert.strictEqual(r.status, 404, 'unknown slug must 404, got ' + r.status);
      t.pass('unknown /blog/<slug> returns 404');
    } catch (e) { t.fail('unknown slug 404', e); }

    // ── Footer link regression ────────────────────────────────────────
    // The shared footer partial (used by /faq, /about, etc.) should now
    // contain a /blog link. Verify against /faq to avoid a tautology with
    // /blog itself.
    try {
      const r = await get('/faq');
      assert.strictEqual(r.status, 200, 'GET /faq must 200');
      assert.ok(/<a[^>]+href="\/blog"[^>]*>\s*Blog\s*</.test(r.body), 'shared footer should link to /blog');
      t.pass('regression: shared footer contains a /blog link');
    } catch (e) { t.fail('shared footer /blog link', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
