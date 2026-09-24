'use strict';
// tests/core/launch-eve-portal-lang-single-resolution.test.js
//
// 2026-09-24 (launch eve, T4). Logged-in portal, EN chosen: the page stayed
// dir="rtl" with an Arabic sidebar and Arabic article cards around English
// text. Cause: two language resolutions per request. src/middleware.js built
// t/tt/dir/formatters from (?lang > session > cookie > 'en'); auth.attachUser
// then overwrote ONLY res.locals.lang with the JWT's language, and the patient
// views take isAr (→ <html dir>, sidebar, cards) from res.locals.lang while
// the body copy goes through tt(). Now resolved once, token language last.
//
// Drives the REAL baseMiddlewares + attachUser chain on an ephemeral port and
// renders the real patient head partial (html dir + sidebar). No DB.

const path = require('path');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🌐 portal language: one resolution, the toggle is authoritative\n');

module.exports = (async function run() {
  const hadSecret = process.env.JWT_SECRET;
  if (!hadSecret) process.env.JWT_SECRET = 'launch-eve-test-secret-'.padEnd(48, 'x');
  const jwt = require('jsonwebtoken');
  // Fresh copies: an earlier test file in the runner may have left a stub of
  // src/middleware in require.cache. Restored in the finally below.
  const MW = require.resolve('../../src/middleware');
  const AUTH = require.resolve('../../src/auth');
  const savedMw = require.cache[MW];
  const savedAuth = require.cache[AUTH];
  delete require.cache[MW];
  delete require.cache[AUTH];
  const { baseMiddlewares } = require(MW);
  const { attachUser } = require(AUTH);
  const restoreCache = () => {
    if (savedMw) require.cache[MW] = savedMw; else delete require.cache[MW];
    if (savedAuth) require.cache[AUTH] = savedAuth; else delete require.cache[AUTH];
  };
  const COOKIE = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

  const app = express();
  app.set('views', path.join(__dirname, '../../src/views'));
  app.set('view engine', 'ejs');
  baseMiddlewares(app);
  app.use(attachUser);
  app.get('/probe', (req, res) => {
    // Exactly how routes/patient.js GET /dashboard derives its language.
    const langCode = res.locals.lang === 'ar' ? 'ar' : 'en';
    res.render('partials/patient/head', {
      title: 'Dashboard', active: 'dashboard', user: { name: 'Test' },
      lang: langCode, isAr: langCode === 'ar', cspNonce: ''
    }, (err, html) => {
      res.json({ lang: res.locals.lang, dir: res.locals.dir, tt: res.locals.tt('', 'EN-BODY', 'AR-BODY'), html: err ? ('ERR ' + err.message) : html });
    });
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const arToken = jwt.sign({ id: 'pat-1', role: 'patient', lang: 'ar' }, process.env.JWT_SECRET);

  async function probe(cookie) {
    const r = await fetch(base + '/probe', { headers: { cookie } });
    const text = await r.text();
    try { return JSON.parse(text); } catch (_) {
      throw new Error('HTTP ' + r.status + ' non-JSON: ' + text.replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  async function check(name, fn) {
    try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
  }
  const htmlDir = (h) => ((/<html lang="([a-z]+)" dir="([a-z]+)"/.exec(h) || []).slice(1).join('/'));

  try {
    await check('toggle cookie lang=en (JWT still says ar) → dir="ltr" and an English sidebar', async () => {
      const r = await probe('lang=en; ' + COOKIE + '=' + arToken);
      if (htmlDir(r.html) !== 'en/ltr') throw new Error('html is ' + htmlDir(r.html) + ' ' + String(r.html).slice(0, 200));
      if (!r.html.includes('Your care') || r.html.includes('رعايتك')) throw new Error('sidebar not English');
      if (r.tt !== 'EN-BODY' || r.dir !== 'ltr') throw new Error('locals ' + JSON.stringify({ tt: r.tt, dir: r.dir }));
    });

    await check('toggle cookie lang=ar → dir="rtl", Arabic sidebar, Arabic body copy', async () => {
      const r = await probe('lang=ar; ' + COOKIE + '=' + jwt.sign({ id: 'p', role: 'patient', lang: 'en' }, process.env.JWT_SECRET));
      if (htmlDir(r.html) !== 'ar/rtl') throw new Error('html is ' + htmlDir(r.html));
      if (!r.html.includes('رعايتك')) throw new Error('sidebar not Arabic');
      if (r.tt !== 'AR-BODY') throw new Error('tt ' + r.tt);
    });

    await check('no lang cookie, JWT ar → EVERYTHING Arabic (was: Arabic frame, English tt)', async () => {
      const r = await probe(COOKIE + '=' + arToken);
      if (r.lang !== 'ar' || r.dir !== 'rtl' || r.tt !== 'AR-BODY' || htmlDir(r.html) !== 'ar/rtl') {
        throw new Error('split: ' + JSON.stringify({ lang: r.lang, dir: r.dir, tt: r.tt, html: htmlDir(r.html) }));
      }
    });

    await check('Bearer token (no cookies) with lang ar → Arabic, as attachUser used to set it', async () => {
      const r = await fetch(base + '/probe', { headers: { authorization: 'Bearer ' + arToken } }).then((x) => x.json());
      if (r.lang !== 'ar' || r.tt !== 'AR-BODY' || r.dir !== 'rtl') throw new Error(JSON.stringify({ lang: r.lang, tt: r.tt, dir: r.dir }));
    });

    await check('logged out, no cookie → English, consistently', async () => {
      const r = await probe('');
      if (r.lang !== 'en' || r.dir !== 'ltr' || r.tt !== 'EN-BODY') throw new Error(JSON.stringify({ lang: r.lang, dir: r.dir, tt: r.tt }));
    });
  } finally {
    restoreCache();
    server.close();
    if (!hadSecret) delete process.env.JWT_SECRET;
  }
})();
