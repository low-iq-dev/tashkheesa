// tests/core/seo-noindex-auth-pages.test.js
//
// SEO 2026-09-18 (mop-up item 2) — auth and orphan pages must not be
// indexable. Guards:
//
//   * /login, /register, /forgot-password, /doctor/signup, /coming-soon and
//     /unsubscribe (incl. /unsubscribe/:token and the /ar/coming-soon twin)
//     all carry `X-Robots-Tag: noindex, follow`
//   * the real public pages — /, /ar/, /services, /specialties, /faq — do NOT
//   * /coming-soon's <meta name="robots"> is noindex, follow (it used to say
//     index, follow), while the public layout's default stays index, follow
//   * server.js mounts the middleware

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🤖 SEO — auth and orphan pages are noindex, real pages stay indexable\n');

const ROOT = path.join(__dirname, '..', '..');
const helper = require(path.join(ROOT, 'tests', '_helpers', 'public_site_app'));
const { robotsNoindex, isNoindexPath } = helper.loadReal(path.join(ROOT, 'src', 'middleware', 'robots_noindex'));

const NOINDEX_PATHS = ['/login', '/register', '/forgot-password', '/doctor/signup', '/coming-soon', '/unsubscribe', '/unsubscribe/some-token'];
const INDEXABLE_PATHS = ['/', '/services', '/specialties', '/faq', '/about', '/apply'];

(async () => {
  // The real pipeline order: publicLangPrefix, then robotsNoindex — the same
  // order server.js mounts them, so /ar/coming-soon is judged post-rewrite.
  const app = express();
  app.use(helper.loadReal(path.join(ROOT, 'src', 'utils', 'public_lang_url')).publicLangPrefix());
  app.use(robotsNoindex());
  app.get('*', (req, res) => res.status(200).type('text/plain').send('ok'));
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headerOf = async (p) => {
    const r = await fetch(base + p, { redirect: 'manual' });
    return r.headers.get('x-robots-tag');
  };

  try {
    // /coming-soon/ is NOT here: as a public page its trailing-slash form
    // 301s to /coming-soon first (seo-trailing-slash guard), which then
    // carries the header. /login/ is not public, so its slash form reaches
    // this middleware directly and is folded by normalise().
    for (const p of NOINDEX_PATHS.concat(['/ar/coming-soon', '/login/', '/Login'])) {
      const h = await headerOf(p);
      if (h !== 'noindex, follow') throw new Error(p + ' → X-Robots-Tag: ' + JSON.stringify(h));
    }
    t.pass('every auth/orphan path carries X-Robots-Tag: noindex, follow');
  } catch (e) { t.fail('noindex header present', e); }

  try {
    for (const p of INDEXABLE_PATHS.concat(['/ar/', '/ar/services', '/ar/faq'])) {
      const h = await headerOf(p);
      if (h !== null) throw new Error(p + ' unexpectedly carries X-Robots-Tag: ' + JSON.stringify(h));
    }
    t.pass('the real public pages carry no X-Robots-Tag');
  } catch (e) { t.fail('indexable pages untouched', e); }

  try {
    // `follow`, never `none`: these pages link onward to real content.
    if (isNoindexPath('/logi')) throw new Error('/logi (prefix of /login) matched');
    if (isNoindexPath('/unsubscribed')) throw new Error('/unsubscribed matched the /unsubscribe/ prefix');
    t.pass('path matching is segment-exact, not substring');
  } catch (e) { t.fail('path matching exact', e); }

  await new Promise((res) => server.close(res));

  // The rendered /coming-soon page: meta robots flipped to noindex, follow.
  const site = await helper.startPublicSiteApp({});
  try {
    const r = await site.get('/coming-soon');
    if (r.status !== 200) throw new Error('/coming-soon returned ' + r.status);
    const m = r.body.match(/<meta name="robots" content="([^"]*)"/);
    if (!m) throw new Error('no meta robots tag on /coming-soon');
    if (m[1] !== 'noindex, follow') throw new Error('meta robots is "' + m[1] + '"');
    t.pass('/coming-soon meta robots is noindex, follow');
  } catch (e) { t.fail('coming-soon meta robots', e); }

  try {
    const r = await site.get('/services');
    const m = r.body.match(/<meta name="robots" content="([^"]*)"/);
    if (!m || m[1] !== 'index, follow') throw new Error('/services meta robots is ' + JSON.stringify(m && m[1]));
    t.pass('a real public page keeps meta robots index, follow');
  } catch (e) { t.fail('public page meta robots default', e); }
  await site.close();

  try {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    if (!/robotsNoindex\(\)/.test(serverSrc)) throw new Error('server.js does not mount robotsNoindex()');
    t.pass('server.js mounts robotsNoindex()');
  } catch (e) { t.fail('server.js mounts robotsNoindex', e); }
})();
