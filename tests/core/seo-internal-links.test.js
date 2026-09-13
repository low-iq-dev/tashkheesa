// tests/core/seo-internal-links.test.js
//
// SEO 2026-09-13 (A3) — read the Arabic site as Googlebot: no cookie, no JS,
// follow the <a href>s. Every internal link to a public page from an /ar/ page
// must stay on the Arabic site; the only way back to English is the language
// switch (and the hreflang alternates, which are <link>, not <a>). Auth links
// carry ?lang=ar. English pages link to unprefixed URLs.
//
// Complements tests/lint/public-links-carry-lang-prefix.test.js (source scan)
// by checking the RENDERED pages through the real pipeline
// (tests/_helpers/public_site_app.js).

'use strict';

const assert = require('assert');
const path = require('path');
const { startPublicSiteApp } = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));
const { isPublicPath } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'public_lang_url'));

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🕸️  SEO A3 — rendered internal links stay in their language\n');

const PAGES = ['/', '/services', '/specialties', '/specialties/cardiology', '/about', '/contact', '/faq', '/blog',
  '/blog/how-tashkheesa-works', '/blog/when-to-get-medical-second-opinion', '/privacy', '/terms',
  '/refund-policy', '/delivery-policy', '/apply', '/help-me-choose'];

function anchors(body) {
  const out = [];
  const re = /<a\b[^>]*>/g;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[0];
    const href = (tag.match(/\bhref="([^"]*)"/) || [])[1];
    if (href === undefined) continue;
    out.push({ tag, href: href.replace(/&amp;/g, '&') });
  }
  const forms = body.match(/<form\b[^>]*\baction="([^"]*)"/g) || [];
  for (const f of forms) out.push({ tag: f, href: f.match(/action="([^"]*)"/)[1], isForm: true });
  return out;
}

function pathOnly(href) { return href.split('#')[0].split('?')[0] || '/'; }

module.exports = (async function run() {
  let app;
  try { app = await startPublicSiteApp(); } catch (e) { t.fail('seo-internal-links: start app', e); return; }
  try {
    for (const enPath of PAGES) {
      const arPath = enPath === '/' ? '/ar/' : '/ar' + enPath;
      try {
        const r = await app.get(arPath);
        assert.strictEqual(r.status, 200, arPath + ' → ' + r.status + ' ' + r.body.slice(0, 300));
        const bad = [];
        for (const a of anchors(r.body)) {
          if (!a.href.startsWith('/') || a.href.startsWith('//')) continue;
          const p = pathOnly(a.href);
          if (/\bnav-lang\b|\blang-btn\b/.test(a.tag)) continue; // the language switch
          if (/^\/(login|register)$/.test(p)) {
            if (!/[?&]lang=ar\b/.test(a.href)) bad.push('auth link without lang=ar: ' + a.href);
            continue;
          }
          if (p.startsWith('/ar/') || p === '/ar') {
            const inner = p === '/ar' ? '/' : p.slice(3);
            if (!isPublicPath(inner)) bad.push('/ar/ link to a non-public page: ' + a.href);
            continue;
          }
          if (isPublicPath(p)) bad.push((a.isForm ? 'form action' : 'link') + ' leaves the Arabic site: ' + a.href);
        }
        assert.deepStrictEqual(bad, [], arPath);
        t.pass(arPath + ': every internal public link stays under /ar/');
      } catch (e) { t.fail('A3 ' + arPath, e); }

      try {
        const r = await app.get(enPath);
        assert.strictEqual(r.status, 200, enPath + ' → ' + r.status);
        const bad = anchors(r.body)
          .filter((a) => a.href.startsWith('/ar/') || a.href === '/ar')
          .filter((a) => !/\bnav-lang\b|\blang-btn\b/.test(a.tag))
          .map((a) => a.href);
        assert.deepStrictEqual(bad, [], enPath + ' English page links into /ar/');
        t.pass(enPath + ': English page links stay unprefixed');
      } catch (e) { t.fail('A3 ' + enPath, e); }
    }
  } finally {
    await app.close();
  }
})();
