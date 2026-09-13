// tests/core/seo-sitemap.test.js
//
// SEO 2026-09-13 (A4) — the sitemap is generated from data, in both languages.
//
// Before: a hand-written list of 15 English URLs in static-pages.js — no
// specialty pages, no Arabic URLs, no hreflang, and /doctor/signup. The Arabic
// site had nothing pointing Google at it.
//
// Renders /sitemap.xml through the real router (tests/_helpers/
// public_site_app.js) with a recording safeAll, and asserts:
//   - every static page, blog post and live specialty appears as BOTH an
//     English and an /ar/ <loc>, and each <url> carries ar-EG/en/x-default
//   - specialty URLs use the slug rule (spec- prefix stripped)
//   - no auth, portal, /lang/ or /doctor/signup URL
//   - the specialty query uses the SAME live clause as /specialties/:slug
//   - Cache-Control max-age=3600 and a cached second response
//   - robots.txt disallows /lang/, /login?, /register? and names the sitemap

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const helper = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🗺️  SEO A4 — sitemap from data, both languages\n');

const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = String(process.env.BASE_URL || 'https://tashkheesa.com').replace(/\/+$/, '');

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

function urlsIn(xml) {
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const loc = (body.match(/<loc>([^<]*)<\/loc>/) || [])[1];
    const lastmod = (body.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1];
    const alternates = {};
    const ar = /<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]*)"\/>/g;
    let a;
    while ((a = ar.exec(body))) alternates[a[1]] = a[2];
    out.push({ loc, lastmod, alternates });
  }
  return out;
}

module.exports = (async function run() {
  const specialtySql = [];
  const liveRows = [{ id: 'cardiology' }, { id: 'spec-radiology' }];
  const safeAll = (sql, params, fallback) => {
    if (/FROM specialties s WHERE/i.test(sql) && !/s\.id = \$1/.test(sql)) {
      specialtySql.push(sql);
      return Promise.resolve(liveRows);
    }
    return helper.fakeSafeAll(sql, params, fallback);
  };

  let app;
  try { app = await helper.startPublicSiteApp({ safeAll }); } catch (e) { t.fail('seo-sitemap: start app', e); return; }
  const staticPages = helper.loadReal(path.join(ROOT, 'src', 'routes', 'static-pages'));

  try {
    const r = await app.get('/sitemap.xml');
    const xml = r.body;
    const urls = urlsIn(xml);
    const locs = urls.map((u) => u.loc);

    await check('sitemap.xml: 200, XML, Cache-Control max-age=3600, xhtml namespace', async () => {
      assert.strictEqual(r.status, 200, 'status ' + r.status + ' ' + xml.slice(0, 300));
      assert.ok(/xml/.test(String(r.headers.get('content-type'))), 'content-type');
      assert.ok(/max-age=3600/.test(String(r.headers.get('cache-control'))), 'cache-control: ' + r.headers.get('cache-control'));
      assert.ok(/xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/.test(xml), 'xhtml namespace');
      assert.strictEqual((xml.match(/<url>/g) || []).length, (xml.match(/<\/url>/g) || []).length, 'balanced <url>');
    });

    // Computed defensively: against a build without the generated sitemap these
    // exports do not exist, and every check below must still FAIL on its own
    // rather than the whole file throwing before it reports.
    const staticList = Array.isArray(staticPages.SITEMAP_STATIC_PATHS) ? staticPages.SITEMAP_STATIC_PATHS : [];
    const expectedPaths = staticList
      .concat(['/blog/how-tashkheesa-works', '/blog/when-to-get-medical-second-opinion'])
      .concat(['/specialties/cardiology', '/specialties/radiology']);

    await check('every static page, blog post and live specialty appears in English AND Arabic', async () => {
      const missing = [];
      for (const p of expectedPaths) {
        const en = ORIGIN + p;
        const ar = ORIGIN + (p === '/' ? '/ar/' : '/ar' + p);
        if (!locs.includes(en)) missing.push(en);
        if (!locs.includes(ar)) missing.push(ar);
      }
      assert.ok(staticList.length >= 10, 'SITEMAP_STATIC_PATHS is not exported from static-pages.js');
      assert.deepStrictEqual(missing, [], 'missing <loc>s');
      assert.strictEqual(locs.length, expectedPaths.length * 2, 'exactly two <url>s per page, got ' + locs.length);
      assert.ok(staticList.includes('/help-me-choose'), '/help-me-choose listed');
    });

    await check('each <url> carries ar-EG / en / x-default alternates and a lastmod', async () => {
      const bad = [];
      for (const u of urls) {
        const enLoc = u.loc.replace(ORIGIN + '/ar/', ORIGIN + '/').replace(/^(.*)\/ar$/, '$1/');
        const p = enLoc.slice(ORIGIN.length) || '/';
        const want = { 'ar-EG': ORIGIN + (p === '/' ? '/ar/' : '/ar' + p), en: ORIGIN + p, 'x-default': ORIGIN + p };
        try { assert.deepStrictEqual(u.alternates, want); } catch (_) { bad.push(u.loc + ' ' + JSON.stringify(u.alternates)); }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(u.lastmod))) bad.push(u.loc + ' lastmod=' + u.lastmod);
      }
      assert.deepStrictEqual(bad, []);
    });

    await check('no auth, portal, /lang/ or /doctor/signup URL', async () => {
      const bad = locs.filter((l) => /\/(login|register|forgot-password|portal|patient|dashboard|admin|superadmin|lang|doctor\/signup|api)\b/.test(l.slice(ORIGIN.length)));
      assert.deepStrictEqual(bad, []);
    });

    await check('specialty query uses the same live clause as /specialties/:slug', async () => {
      assert.strictEqual(specialtySql.length, 1, 'one specialty query, got ' + specialtySql.length);
      assert.ok(typeof staticPages.LIVE_SPECIALTY_WHERE === 'string' && staticPages.LIVE_SPECIALTY_WHERE.length > 20, 'LIVE_SPECIALTY_WHERE is not exported');
      assert.ok(specialtySql[0].includes(staticPages.LIVE_SPECIALTY_WHERE), 'sitemap SQL must embed LIVE_SPECIALTY_WHERE');
      const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'static-pages.js'), 'utf8');
      const detail = src.slice(src.indexOf("router.get('/specialties/:slug'"));
      assert.ok(/WHERE s\.id = \$1 " \+\s*"\s+AND " \+ LIVE_SPECIALTY_WHERE/.test(detail), 'detail route must filter on LIVE_SPECIALTY_WHERE');
    });

    await check('second request is served from the 1h cache', async () => {
      const again = await app.get('/sitemap.xml');
      assert.strictEqual(again.body, xml);
      assert.strictEqual(specialtySql.length, 1, 'exactly one specialty query across two requests, got ' + specialtySql.length);
    });

    await check('robots.txt: Disallow /lang/, /login?, /register?; names the sitemap', async () => {
      const rb = await app.get('/robots.txt');
      assert.strictEqual(rb.status, 200);
      for (const line of ['Disallow: /lang/', 'Disallow: /login?', 'Disallow: /register?', 'Sitemap: ' + ORIGIN + '/sitemap.xml']) {
        assert.ok(rb.body.split('\n').includes(line), 'robots.txt missing: ' + line);
      }
    });
  } finally {
    await app.close();
  }
})();
