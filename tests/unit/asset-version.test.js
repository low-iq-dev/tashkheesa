// tests/unit/asset-version.test.js
//
// Perf 2026-10-15 — content-hashed asset URLs (src/utils/asset_version.js).
// The long cache is only safe if the URL changes exactly when the bytes do,
// and unversioned requests keep the old 1h policy. Also pins the templates:
// the marketing/auth heads must link CSS through the helper, and the Google
// Fonts stylesheet must not be render-blocking.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { asset, versionedCacheHeaders, ONE_YEAR, _resetForTests } = require('../../src/utils/asset_version');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

console.log('\n📦 Versioned asset URLs + long cache\n');

const ROOT = path.join(__dirname, '..', '..');
function md5_8(rel) {
  return crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 8);
}
function fakeRes(query) {
  const headers = {};
  return { req: { query }, setHeader(k, v) { headers[k] = v; }, headers };
}

_resetForTests();

check('a /site/ CSS URL gets ?v=<md5 of the file in public/>', function () {
  assert.strictEqual(asset('/site/css/styles.css'), '/site/css/styles.css?v=' + md5_8('public/css/styles.css'));
});

check('/styles.css, /css/, /js/ and /vendor/ resolve to their mounts', function () {
  assert.strictEqual(asset('/styles.css'), '/styles.css?v=' + md5_8('public/styles.css'));
  assert.strictEqual(asset('/css/portal-global.css'), '/css/portal-global.css?v=' + md5_8('public/css/portal-global.css'));
  assert.strictEqual(asset('/js/meta_pixel.js'), '/js/meta_pixel.js?v=' + md5_8('public/js/meta_pixel.js'));
  assert.strictEqual(asset('/vendor/lucide.min.js'), '/vendor/lucide.min.js?v=' + md5_8('public/vendor/lucide.min.js'));
});

check('a missing file, an unknown mount, or a URL with a query is returned unchanged', function () {
  assert.strictEqual(asset('/css/does-not-exist.css'), '/css/does-not-exist.css');
  assert.strictEqual(asset('/somewhere/else.css'), '/somewhere/else.css');
  assert.strictEqual(asset('/css/portal-global.css?x=1'), '/css/portal-global.css?x=1');
  assert.strictEqual(asset('https://example.com/a.css'), 'https://example.com/a.css');
  assert.strictEqual(asset(undefined), undefined);
});

check('path traversal out of a mount is not hashed', function () {
  assert.strictEqual(asset('/css/../../package.json'), '/css/../../package.json');
});

check('?v= request → 1y immutable; bare request → header untouched (static maxAge applies)', function () {
  const v = fakeRes({ v: 'abcd1234' });
  versionedCacheHeaders(v);
  assert.strictEqual(v.headers['Cache-Control'], ONE_YEAR);
  assert.ok(/immutable/.test(ONE_YEAR) && /max-age=31536000/.test(ONE_YEAR));
  const bare = fakeRes({});
  versionedCacheHeaders(bare);
  assert.strictEqual(bare.headers['Cache-Control'], undefined);
  const empty = fakeRes({ v: '' });
  versionedCacheHeaders(empty);
  assert.strictEqual(empty.headers['Cache-Control'], undefined);
});

check('server.js mounts static assets with the versioned-cache hook', function () {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  assert.ok(/STATIC_CACHE = \{ maxAge: '1h', setHeaders: assetVersion\.versionedCacheHeaders \}/.test(src));
  assert.ok(/app\.locals\.asset = assetVersion\.asset/.test(src));
});

check('marketing + auth heads link local CSS only through the helper', function () {
  ['src/views/index.ejs', 'src/views/layouts/public.ejs', 'src/views/layouts/auth.ejs'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const bare = src.match(/<link rel="stylesheet" href="\/[^"<]+"/g) || [];
    assert.deepStrictEqual(bare, [], rel + ' has unversioned stylesheet links');
  });
});

check('Google Fonts is never a render-blocking <link> in the marketing/auth heads', function () {
  ['src/views/index.ejs', 'src/views/layouts/auth.ejs'].forEach(function (rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/<link href="https:\/\/fonts\.googleapis\.com\/css2[^>]*rel="stylesheet"/.test(src), rel);
    assert.ok(/google_fonts_async/.test(src), rel + ' should use partials/google_fonts_async');
  });
});
