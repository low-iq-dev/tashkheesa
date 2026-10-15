// tests/lint/static-mounts-set-cache-headers.test.js
//
// SEO 2026-09-18 (mop-up item 5) — every express.static() mount in server.js
// served `Cache-Control: public, max-age=0`: each visit re-downloaded every
// stylesheet, script and image. Every mount must now pass cache options —
// STATIC_CACHE (1h — the asset URLs are not versioned, so a longer cache
// would pin stale files across deploys) or its own explicit maxAge (fonts:
// 1y immutable, icons: 7d).
//
// Perf 2026-10-15 — asset URLs CAN now be versioned: templates link through
// app.locals.asset() (src/utils/asset_version.js), which appends
// ?v=<content hash>. STATIC_CACHE keeps maxAge 1h for bare URLs and adds a
// setHeaders hook that serves any ?v= request as 1y immutable. Both halves
// are pinned below, the second behaviourally.
//
// This is a lint on the source because the mounts live in server.js, which
// cannot boot in the no-DB suite. A behavioural check of the header itself
// rides in the same file, on a throwaway app using the same options object
// shape.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🗄️  SEO — static asset mounts set real cache headers\n');

const ROOT = path.join(__dirname, '..', '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

try {
  // Every express.static(...) call: the closing of its argument list must
  // contain either STATIC_CACHE or an inline maxAge.
  const re = /express\.static\(([^;]*?)\)\)/g;
  const bare = [];
  let m, count = 0;
  while ((m = re.exec(serverSrc))) {
    count++;
    const args = m[1];
    if (!/STATIC_CACHE|maxAge/.test(args)) {
      const line = serverSrc.slice(0, m.index).split('\n').length;
      bare.push('src/server.js:' + line + ' — express.static with no cache options');
    }
  }
  if (count < 10) throw new Error('only ' + count + ' express.static calls found — the scan is not seeing server.js');
  if (bare.length) throw new Error(bare.length + ' uncached static mount(s):\n    ' + bare.join('\n    '));
  t.pass('all ' + count + ' express.static mounts in server.js pass cache options');
} catch (e) { t.fail('static mounts carry cache options', e); }

try {
  if (!/var STATIC_CACHE = \{ maxAge: '1h', setHeaders: assetVersion\.versionedCacheHeaders \}/.test(serverSrc)) {
    throw new Error("STATIC_CACHE is not { maxAge: '1h', setHeaders: assetVersion.versionedCacheHeaders } — bare URLs must stay 1h, ?v= URLs get the long cache");
  }
  t.pass("STATIC_CACHE is 1h for bare URLs + the ?v= long-cache hook");
} catch (e) { t.fail('STATIC_CACHE value', e); }

(async () => {
  // Behavioural proof that express.static + maxAge produces the header the
  // lint above is standing in for.
  const app = express();
  const { versionedCacheHeaders } = require('../../src/utils/asset_version');
  app.use('/js', express.static(path.join(ROOT, 'public', 'js'), { maxAge: '1h', setHeaders: versionedCacheHeaders }));
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const r = await fetch(base + '/js/meta_pixel.js');
    const cc = r.headers.get('cache-control');
    if (r.status !== 200) throw new Error('/js/meta_pixel.js → ' + r.status);
    if (cc !== 'public, max-age=3600') throw new Error('Cache-Control: ' + cc);
    if (!r.headers.get('etag')) throw new Error('no ETag — revalidation after the hour would be a full re-download');
    t.pass('a mount with maxAge 1h serves public, max-age=3600 + ETag');
  } catch (e) { t.fail('behavioural cache header', e); }
  try {
    const r = await fetch(base + '/js/meta_pixel.js?v=deadbeef');
    const cc = r.headers.get('cache-control');
    if (r.status !== 200) throw new Error('/js/meta_pixel.js?v= → ' + r.status);
    if (cc !== 'public, max-age=31536000, immutable') throw new Error('Cache-Control: ' + cc);
    t.pass('the same mount serves a ?v= URL as public, max-age=31536000, immutable');
  } catch (e) { t.fail('behavioural versioned cache header', e); }
  await new Promise((res) => server.close(res));
})();
