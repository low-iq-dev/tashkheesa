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
            if (new URL(a.href, 'http://x').searchParams.get('lang') !== 'ar') bad.push('auth link without a top-level lang=ar: ' + a.href);
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
        // Auth links on an English page carry lang=en (found in review: the
        // English toggle sets no cookie, so an old Arabic cookie would win).
        const authBad = anchors(r.body)
          .filter((a) => /^\/(login|register)$/.test(pathOnly(a.href)) && new URL(a.href, 'http://x').searchParams.get('lang') !== 'en')
          .map((a) => a.href);
        assert.deepStrictEqual(authBad, [], enPath + ' auth links without lang=en');
        t.pass(enPath + ': English page links stay unprefixed');
      } catch (e) { t.fail('A3 ' + enPath, e); }
    }
  } finally {
    await app.close();
  }

  // ── Found in review: booking links, and pages outside the public scheme ──
  let bookApp;
  try { bookApp = await startPublicSiteApp({ bookingCtaEnabled: true }); } catch (e) { t.fail('seo-internal-links: booking app', e); return; }
  try {
    for (const [p, lang] of [['/ar/services', 'ar'], ['/services', 'en'], ['/ar/specialties/cardiology', 'ar'], ['/specialties/cardiology', 'en']]) {
      try {
        const r = await bookApp.get(p);
        assert.strictEqual(r.status, 200, p + ' → ' + r.status);
        const booking = anchors(r.body).filter((a) => /patient\/new-case/.test(a.href));
        assert.ok(booking.length > 0, p + ': no booking links rendered (is the CTA on?)');
        // lang must be a TOP-LEVEL parameter of the link: inside next=… the
        // login page never sees it (found live: /login?next=/patient/new-case?lang=ar).
        const bad = booking.filter((a) => new URL(a.href, 'http://x').searchParams.get('lang') !== lang).map((a) => a.href);
        assert.deepStrictEqual(bad, [], p + ' booking links without lang=' + lang);
        t.pass(p + ': ' + booking.length + ' booking link(s) carry lang=' + lang);
      } catch (e) { t.fail('A3 booking ' + p, e); }
    }
    try {
      const ar = await bookApp.get('/__offscheme/about', { cookie: 'lang=ar' });
      assert.strictEqual(ar.status, 200, 'off-scheme page → ' + ar.status + ' ' + ar.body.slice(0, 300));
      const leaks = anchors(ar.body)
        .filter((a) => a.href.startsWith('/') && !a.href.startsWith('//') && !/\bnav-lang\b/.test(a.tag))
        .filter((a) => isPublicPath(pathOnly(a.href)))
        .map((a) => a.href);
      assert.deepStrictEqual(leaks, [], 'Arabic-cookie page outside the scheme links English public pages');
      assert.ok(anchors(ar.body).some((a) => a.href === '/ar/faq'), 'expected the footer to link /ar/faq');
      const en = await bookApp.get('/__offscheme/about');
      assert.ok(!anchors(en.body).some((a) => /^\/ar\//.test(a.href)), 'no-cookie page must not link into /ar/');
      t.pass('outside the public scheme, public links follow the cookie language (footer → /ar/faq)');
    } catch (e) { t.fail('A3 off-scheme links', e); }
  } finally {
    await bookApp.close();
  }
})();
