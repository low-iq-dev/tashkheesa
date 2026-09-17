// tests/core/seo-canonical-host.test.js
//
// SEO 2026-09-18 (mop-up item 1) — the whole site answered 200 on
// tashkheesa.onrender.com, a full duplicate domain, while Google was starting
// to crawl. Guards for src/middleware/canonical_host.js:
//
//   * a non-canonical Host 301s to https://tashkheesa.com with path AND query
//     intact
//   * the canonical host does not redirect
//   * /healthz and /__version (and /health, /status) answer on any host
//   * Host: evil.com redirects to tashkheesa.com, NOT to evil.com — the
//     incoming header must never be echoed into the Location target
//   * localhost is never redirected, even with the middleware force-enabled
//   * server.js actually mounts it (a perfect middleware mounted nowhere
//     protects nothing)

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🌐 SEO — canonical host redirect (one domain, not two)\n');

const ROOT = path.join(__dirname, '..', '..');
const { canonicalHostRedirect } = require(path.join(ROOT, 'src', 'middleware', 'canonical_host'));

function buildApp(mwOpts) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(canonicalHostRedirect(mwOpts));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/__version', (req, res) => res.json({ ok: true }));
  app.get('*', (req, res) => res.status(200).type('text/plain').send('page: ' + req.originalUrl));
  return app;
}

async function withServer(mwOpts, fn) {
  const server = http.createServer(buildApp(mwOpts));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p, host) => {
    const r = await fetch(base + p, {
      redirect: 'manual',
      // fetch() refuses a literal Host header; the middleware reads
      // X-Forwarded-Host first under trust proxy, exactly as on Render.
      headers: host ? { 'X-Forwarded-Host': host } : {}
    });
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  };
  try { await fn(get); } finally { await new Promise((res) => server.close(res)); }
}

(async () => {
  await withServer({ canonicalHost: 'tashkheesa.com', enabled: true }, async (get) => {
    try {
      const r = await get('/services?utm_source=x&b=2', 'tashkheesa.onrender.com');
      if (r.status !== 301) throw new Error('expected 301, got ' + r.status);
      if (r.location !== 'https://tashkheesa.com/services?utm_source=x&b=2') {
        throw new Error('Location lost path or query: ' + r.location);
      }
      t.pass('non-canonical host 301s with path and query intact');
    } catch (e) { t.fail('non-canonical host 301', e); }

    try {
      const r = await get('/ar/services', 'www.tashkheesa.com');
      if (r.status !== 301 || r.location !== 'https://tashkheesa.com/ar/services') {
        throw new Error('www did not 301 to apex: ' + r.status + ' ' + r.location);
      }
      t.pass('www.tashkheesa.com 301s to the apex');
    } catch (e) { t.fail('www 301s to apex', e); }

    try {
      const r = await get('/services', 'tashkheesa.com');
      if (r.status !== 200) throw new Error('canonical host got ' + r.status + ' ' + (r.location || ''));
      t.pass('the canonical host does not redirect');
    } catch (e) { t.fail('canonical host no redirect', e); }

    try {
      for (const p of ['/healthz', '/__version']) {
        const r = await get(p, 'tashkheesa.onrender.com');
        if (r.status !== 200) throw new Error(p + ' on a non-canonical host got ' + r.status);
      }
      t.pass('/healthz and /__version answer on a non-canonical host');
    } catch (e) { t.fail('health endpoints exempt', e); }

    try {
      const r = await get('/services', 'evil.com');
      if (r.status !== 301) throw new Error('expected 301, got ' + r.status);
      const host = new URL(r.location).hostname;
      if (host !== 'tashkheesa.com') throw new Error('Location echoed the attacker host: ' + r.location);
      if (r.location.indexOf('evil.com') !== -1) throw new Error('evil.com appears in Location: ' + r.location);
      t.pass('Host: evil.com redirects to tashkheesa.com, never to evil.com');
    } catch (e) { t.fail('no open redirect from Host header', e); }

    try {
      // No X-Forwarded-Host: req.hostname is the real 127.0.0.1 the test dials.
      const r = await get('/services', null);
      if (r.status !== 200) throw new Error('localhost got ' + r.status + ' ' + (r.location || ''));
      t.pass('localhost is never redirected, even force-enabled');
    } catch (e) { t.fail('localhost exempt', e); }
  });

  await withServer({ canonicalHost: 'tashkheesa.com', enabled: false }, async (get) => {
    try {
      const r = await get('/services', 'tashkheesa.onrender.com');
      if (r.status !== 200) throw new Error('disabled middleware still redirected: ' + r.status);
      t.pass('disabled (non-production) mode leaves every host alone');
    } catch (e) { t.fail('disabled mode inert', e); }
  });

  try {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    if (!/canonicalHostRedirect\(\)/.test(serverSrc)) {
      throw new Error('server.js does not mount canonicalHostRedirect()');
    }
    const mountAt = serverSrc.indexOf('canonicalHostRedirect()');
    const firstStatic = serverSrc.indexOf('express.static(');
    const langMount = serverSrc.indexOf('publicLangPrefix()');
    if (firstStatic !== -1 && mountAt > firstStatic) {
      throw new Error('canonicalHostRedirect is mounted AFTER the static mounts');
    }
    if (langMount !== -1 && mountAt > langMount) {
      throw new Error('canonicalHostRedirect is mounted AFTER the /ar language middleware');
    }
    t.pass('server.js mounts it before the static mounts and the /ar middleware');
  } catch (e) { t.fail('server.js mount order', e); }
})();
