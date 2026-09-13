// tests/core/seo-canonical-hreflang.test.js
//
// SEO 2026-09-13 (A2) — per-language canonical + hreflang.
//
// Before: every public page, in both languages, declared the ENGLISH URL as its
// canonical and carried no hreflang at all, so the Arabic version read as a
// duplicate of the English one. The homepage has its own <head> (index.ejs),
// so it had the same bug in a second place.
//
// Renders pages through the real request pipeline (tests/_helpers/
// public_site_app.js) and asserts, for each page in both languages:
//   - canonical is the page's own language URL, absolute, no query string
//   - the same three alternates (ar-EG, en, x-default=en) on both versions
//   - og:url equals the canonical
//   - <html lang/dir> and Content-Language match the URL

'use strict';

const assert = require('assert');
const path = require('path');
const { startPublicSiteApp, readHead } = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🔗 SEO A2 — canonical + hreflang per language\n');

const SITE = 'https://tashkheesa.com';
// [English path, Arabic path, canonical path the route declares]
const PAGES = [
  ['/', '/ar/'],
  ['/about', '/ar/about'],
  ['/faq', '/ar/faq'],
  ['/contact?sent=1', '/ar/contact?sent=1', '/contact']
];

function expectedFor(enPath, canonicalPath) {
  const p = canonicalPath || enPath;
  return { en: SITE + p, ar: SITE + (p === '/' ? '/ar/' : '/ar' + p) };
}

module.exports = (async function run() {
  let app;
  try { app = await startPublicSiteApp(); } catch (e) { t.fail('seo-canonical-hreflang: start app', e); return; }
  try {
    for (const [enPath, arPath, canonicalPath] of PAGES) {
      const want = expectedFor(enPath, canonicalPath);
      const heads = {};
      for (const [lang, p] of [['en', enPath], ['ar', arPath]]) {
        try {
          const r = await app.get(p);
          assert.strictEqual(r.status, 200, 'GET ' + p + ' → ' + r.status + ' ' + r.body.slice(0, 300));
          const h = readHead(r.body);
          heads[lang] = h;
          assert.strictEqual(h.canonical, want[lang], p + ' canonical');
          assert.ok(!/\?/.test(h.canonical), p + ' canonical must carry no query string');
          assert.strictEqual(h.ogUrl, h.canonical, p + ' og:url must equal canonical');
          assert.deepStrictEqual(h.alternates, { 'ar-EG': want.ar, en: want.en, 'x-default': want.en }, p + ' alternates');
          assert.strictEqual(h.htmlLang, lang, p + ' <html lang>');
          assert.strictEqual(h.htmlDir, lang === 'ar' ? 'rtl' : 'ltr', p + ' <html dir>');
          assert.strictEqual(r.headers.get('content-language'), lang, p + ' Content-Language');
          t.pass(p + ' → canonical ' + h.canonical + ' + ar-EG/en/x-default');
        } catch (e) { t.fail('A2 ' + p, e); }
      }
      try {
        assert.ok(heads.en && heads.ar, 'both versions rendered');
        assert.deepStrictEqual(heads.en.alternates, heads.ar.alternates, 'both language versions carry identical alternates');
        t.pass(enPath + ' and ' + arPath + ' carry the same alternate set');
      } catch (e) { t.fail('A2 alternates symmetric ' + enPath, e); }
    }
  } finally {
    await app.close();
  }
})();
