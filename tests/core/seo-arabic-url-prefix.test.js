// tests/core/seo-arabic-url-prefix.test.js
//
// SEO 2026-09-13 (A1) — one URL per language.
//
// Before: Arabic was chosen by a `lang` cookie or `?lang=ar`, defaulted to
// English, and had no URL of its own (`/ar/` was a 404). A crawler carries no
// cookie, so Google saw English at every address.
//
// This pins the contract, in-process, with the REAL publicLangPrefix and the
// REAL baseMiddlewares (src/middleware.js), in the order server.js mounts them:
//   - /ar/<public path> runs the unprefixed handler in Arabic
//   - on a public path the URL beats the cookie, and nothing sets a cookie
//   - ?lang= on a public path is a 301 to the language URL
//   - only allowlisted public paths are rewritten: /ar/login stays a 404
//   - portal/auth paths keep ?lang= > session > cookie, cookie write included
//   - the redirect cannot be steered off-site
// Plus a source check that server.js mounts the prefix before baseMiddlewares.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🌍 SEO A1 — /ar/ URLs for the public site\n');

const ROOT = path.join(__dirname, '..', '..');
const { publicLangPrefix, isPublicPath, pathFor, alternateUrls } = require(path.join(ROOT, 'src', 'utils', 'public_lang_url'));

// Load the REAL module file, whatever another test left in require.cache.
// Several tests/auth/* files replace src/middleware with a stub via
// require.cache and never restore it; run in the same process, this guard would
// otherwise be testing that stub. The previous cache entry is put back so this
// file does not change what later tests see.
function loadReal(p) {
  const id = require.resolve(p);
  const saved = require.cache[id];
  delete require.cache[id];
  try { return require(id); } finally {
    if (saved) require.cache[id] = saved; else delete require.cache[id];
  }
}

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => t.pass(name), (e) => t.fail(name, e));
}

function buildApp() {
  const app = express();
  app.use(publicLangPrefix());
  loadReal(path.join(ROOT, 'src', 'middleware')).baseMiddlewares(app);
  const seen = (req, res) => res.json({
    path: req.path,
    originalUrl: req.originalUrl,
    lang: res.locals.lang,
    dir: res.locals.dir,
    isAr: res.locals.isAr,
    langPrefix: res.locals.langPrefix === undefined ? null : res.locals.langPrefix,
    altLangUrl: res.locals.altLangUrl || null,
    publicPath: res.locals.publicPath || null,
    publicLinkPrefix: res.locals.publicLinkPrefix === undefined ? null : res.locals.publicLinkPrefix,
    langParam: res.locals.langParam || null
  });
  app.get('/', seen);
  app.get('/services', seen);
  app.get('/specialties/:slug', seen);
  app.post('/contact', seen);
  app.get('/login', seen);
  app.get('/portal/doctor', seen);
  app.use((req, res) => res.status(404).json({ notFound: req.path }));
  return app;
}

function request(base, p, opts) {
  opts = opts || {};
  return fetch(base + p, { method: opts.method || 'GET', redirect: 'manual', headers: opts.headers || {} })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: r.status, json, location: r.headers.get('location'), headers: r.headers };
    });
}

module.exports = (async function run() {
  // Pure helpers first — no server needed.
  await check('isPublicPath: public pages yes, portal/auth/api no', () => {
    for (const p of ['/', '/services', '/services/', '/specialties/cardiology', '/blog/how-tashkheesa-works', '/apply', '/about.html']) {
      assert.ok(isPublicPath(p), p + ' should be public');
    }
    for (const p of ['/login', '/register', '/portal/doctor', '/patient/new-case', '/api/pre-launch-interest', '/lang/ar',
      '/specialties/../login', '/blog/a/b', '//evil.com', '/doctor/signup', '/sitemap.xml']) {
      assert.ok(!isPublicPath(p), p + ' must not be public');
    }
  });
  await check('pathFor / alternateUrls: Arabic home is /ar/, x-default is English', () => {
    assert.strictEqual(pathFor('ar', '/'), '/ar/');
    assert.strictEqual(pathFor('ar', '/services'), '/ar/services');
    assert.strictEqual(pathFor('en', '/services/'), '/services');
    assert.deepStrictEqual(alternateUrls('https://x.test/', '/'), { en: 'https://x.test/', ar: 'https://x.test/ar/', xDefault: 'https://x.test/' });
  });

  let server;
  try {
    server = http.createServer(buildApp());
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
  } catch (e) {
    t.fail('seo-arabic-url-prefix: app with real baseMiddlewares', e);
    return;
  }
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    await check('/ar/services runs the /services handler in Arabic', async () => {
      const r = await request(base, '/ar/services?spec=cardiology');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.path, '/services');
      assert.strictEqual(r.json.originalUrl, '/ar/services?spec=cardiology');
      assert.strictEqual(r.json.lang, 'ar');
      assert.strictEqual(r.json.dir, 'rtl');
      assert.strictEqual(r.json.isAr, true);
      assert.strictEqual(r.json.langPrefix, '/ar');
      assert.strictEqual(r.json.altLangUrl, '/services');
      assert.strictEqual(r.headers.get('content-language'), 'ar');
    });

    await check('/ar/ is the Arabic home; /ar 301s to /ar/', async () => {
      const home = await request(base, '/ar/');
      assert.strictEqual(home.status, 200);
      assert.strictEqual(home.json.path, '/');
      assert.strictEqual(home.json.lang, 'ar');
      assert.strictEqual(home.json.altLangUrl, '/');
      const bare = await request(base, '/ar');
      assert.strictEqual(bare.status, 301);
      assert.strictEqual(bare.location, '/ar/');
    });

    await check('unprefixed public page is English with an /ar alternate', async () => {
      const r = await request(base, '/specialties/cardiology');
      assert.strictEqual(r.json.lang, 'en');
      assert.strictEqual(r.json.langPrefix, '');
      assert.strictEqual(r.json.altLangUrl, '/ar/specialties/cardiology');
      assert.strictEqual(r.headers.get('content-language'), 'en');
    });

    await check('public page: the URL beats a lang cookie, and no cookie is set (Googlebot or not)', async () => {
      const en = await request(base, '/services', { headers: { cookie: 'lang=ar', 'user-agent': 'Googlebot/2.1' } });
      assert.strictEqual(en.json.lang, 'en', 'cookie lang=ar must not turn /services Arabic');
      assert.ok(!/lang=/.test(String(en.headers.get('set-cookie') || '')), 'no lang cookie on /services');
      const ar = await request(base, '/ar/services', { headers: { cookie: 'lang=en', 'user-agent': 'Googlebot/2.1' } });
      assert.strictEqual(ar.json.lang, 'ar', 'cookie lang=en must not turn /ar/services English');
      assert.ok(!/lang=/.test(String(ar.headers.get('set-cookie') || '')), 'no lang cookie on /ar/services');
    });

    await check('?lang= on a public page is a 301 to the language URL, other params kept', async () => {
      let r = await request(base, '/services?lang=ar&spec=cardiology');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/ar/services?spec=cardiology');
      r = await request(base, '/ar/services?lang=en');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/services');
      r = await request(base, '/?lang=ar');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/ar/');
      r = await request(base, '/?lang=ar&lang=en');
      assert.strictEqual(r.status, 301, 'repeated lang still redirects');
      assert.ok(!/lang=/.test(r.location), 'no lang param survives: ' + r.location);
      assert.ok(!/lang=/.test(String(r.headers.get('set-cookie') || '')), 'the 301 sets no cookie');
    });

    await check('the 301 cannot be steered off-site', async () => {
      const r = await request(base, '/services?lang=ar&next=//evil.example/x');
      assert.strictEqual(r.status, 301);
      assert.ok(r.location.startsWith('/ar/services?'), 'Location must stay on /ar/services: ' + r.location);
      const odd = await request(base, '/ar//evil.example?lang=en');
      assert.strictEqual(odd.status, 404, '/ar//evil.example is not a public page and must not redirect');
      const dots = await request(base, '/ar/specialties/..%2f..%2flogin?lang=en');
      assert.notStrictEqual(dots.status, 301, 'encoded traversal must not match the allowlist');
    });

    await check('/ar/login is not a URL: auth pages are not rewritten', async () => {
      const r = await request(base, '/ar/login');
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.json.notFound, '/ar/login');
      assert.ok(/Cookie/i.test(String(r.headers.get('vary') || '')), 'non-public responses Vary: Cookie');
    });

    await check('portal/auth language resolution is unchanged (?lang= and cookie)', async () => {
      const q = await request(base, '/login?lang=ar');
      assert.strictEqual(q.status, 200, '/login?lang=ar must not redirect');
      assert.strictEqual(q.json.lang, 'ar');
      assert.strictEqual(q.json.langPrefix, null, 'no langPrefix off the public site');
      assert.ok(/lang=ar/.test(String(q.headers.get('set-cookie') || '')), '?lang=ar still persists as a cookie on /login');
      const c = await request(base, '/portal/doctor', { headers: { cookie: 'lang=ar' } });
      assert.strictEqual(c.json.lang, 'ar', 'portal still reads the lang cookie');
      assert.ok(/Cookie/i.test(String(c.headers.get('vary') || '')), 'portal responses Vary: Cookie');
    });

    await check('POST /ar/contact reaches the /contact handler in Arabic (form round trip)', async () => {
      const r = await request(base, '/ar/contact', { method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.path, '/contact');
      assert.strictEqual(r.json.lang, 'ar');
    });
    // ── Found in review ─────────────────────────────────────────────────
    await check('capitalised public paths: one 301 to the lowercase language URL', async () => {
      let r = await request(base, '/SERVICES?lang=ar&spec=x');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/ar/services?spec=x');
      assert.ok(!/lang=/.test(String(r.headers.get('set-cookie') || '')), 'no lang cookie');
      r = await request(base, '/Ar/About');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/ar/about');
      r = await request(base, '/Services');
      assert.strictEqual(r.status, 301);
      assert.strictEqual(r.location, '/services');
      r = await request(base, '/CONTACT', { method: 'POST' });
      assert.notStrictEqual(r.status, 301, 'a POST is never redirected');
      r = await request(base, '/LOGIN');
      assert.notStrictEqual(r.status, 301, 'a non-public path is not redirected');
    });

    await check('a path of thousands of slashes costs nothing to classify (no quadratic regex)', async () => {
      // In-process, where the difference is measurable: /\/+$/ on 20k slashes
      // followed by a non-slash took hundreds of ms per call (it runs on every
      // request); the loop + length cap answers in well under a millisecond.
      const u = loadReal(path.join(ROOT, 'src', 'utils', 'public_lang_url'));
      const evil = '/'.repeat(20000) + 'a';
      const t0 = Date.now();
      for (let i = 0; i < 3; i++) u.isPublicPath(evil);
      const ms = Date.now() - t0;
      assert.ok(ms < 100, 'isPublicPath took ' + ms + 'ms for 3 calls on a 20k-slash path');
      const r = await request(base, '/' + '/'.repeat(8000) + 'a');
      assert.strictEqual(r.status, 404, 'not a public page, not rewritten');
    });

    await check('publicLinkPrefix follows the page language everywhere; langParam only on public pages', async () => {
      let r = await request(base, '/ar/services');
      assert.strictEqual(r.json.publicLinkPrefix, '/ar');
      assert.strictEqual(r.json.langParam, 'lang=ar');
      r = await request(base, '/services', { headers: { cookie: 'lang=ar' } });
      assert.strictEqual(r.json.publicLinkPrefix, '', 'English public page links English, cookie or not');
      assert.strictEqual(r.json.langParam, 'lang=en');
      r = await request(base, '/portal/doctor', { headers: { cookie: 'lang=ar' } });
      assert.strictEqual(r.json.publicLinkPrefix, '/ar', 'an Arabic portal page links the Arabic public site');
      assert.strictEqual(r.json.langParam, null, 'no langParam off the public site');
      r = await request(base, '/login?lang=en', { headers: { cookie: 'lang=ar' } });
      assert.strictEqual(r.json.publicLinkPrefix, '');
    });
  } finally {
    await new Promise((res) => server.close(res));
  }

  await check('server.js mounts publicLangPrefix before baseMiddlewares', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    const prefix = src.indexOf('publicLangPrefix()');
    const base = src.indexOf('\nbaseMiddlewares(app);');
    assert.ok(prefix !== -1, 'publicLangPrefix() is not mounted in server.js');
    assert.ok(base !== -1, 'baseMiddlewares(app) call not found');
    assert.ok(prefix < base, 'publicLangPrefix must be mounted before baseMiddlewares');
    for (const mount of ["app.get('/', ", 'setupStaticPages({', 'appLandingRoutes)', 'applyRoutes({']) {
      const at = src.indexOf(mount);
      assert.ok(at > prefix, mount + ' must come after publicLangPrefix');
    }
  });
})();
