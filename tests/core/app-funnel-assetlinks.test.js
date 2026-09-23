'use strict';
// tests/core/app-funnel-assetlinks.test.js
//
// App funnel 2026-09-23 — GET /.well-known/assetlinks.json (Android App Links).
//
// Google's verifier fetches https://tashkheesa.com/.well-known/assetlinks.json
// with no cookies, follows NO redirects, and needs a 200 application/json.
// So: unset → 404 (nothing claimed), set → the exact statement shape, and the
// route sits ahead of every middleware that could redirect, challenge or
// throttle it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const tag = 'app-funnel-assetlinks';
console.log('\n🔗 App funnel — /.well-known/assetlinks.json\n');

const ROOT = path.join(__dirname, '..', '..');
function assert(cond, label, detail) {
  if (cond) t.pass(tag + ': ' + label);
  else t.fail(tag + ': ' + label, new Error(detail || 'assertion failed'));
}

const FP1 = Array.from({ length: 32 }, (_, i) => ('0' + i.toString(16)).slice(-2).toUpperCase()).join(':');
const FP2 = Array.from({ length: 32 }, () => 'ab').join(':'); // lower-case on purpose

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.status = function (c) { r.statusCode = c; return r; };
  r.type = function (ty) { r.headers['content-type'] = ty; return r; };
  r.setHeader = function (k, v) { r.headers[k.toLowerCase()] = v; };
  r.send = function (b) { r.body = b; return r; };
  return r;
}

function withFingerprints(value, fn) {
  const saved = process.env.ANDROID_APP_SHA256_FINGERPRINTS;
  if (value === undefined) delete process.env.ANDROID_APP_SHA256_FINGERPRINTS;
  else process.env.ANDROID_APP_SHA256_FINGERPRINTS = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.ANDROID_APP_SHA256_FINGERPRINTS;
    else process.env.ANDROID_APP_SHA256_FINGERPRINTS = saved;
  }
}

const af = require(path.join(ROOT, 'src', 'utils', 'app_funnel.js'));

// ── 1. Unset / garbage → 404 ───────────────────────────────────────────
withFingerprints(undefined, function () {
  const res = fakeRes();
  af.assetLinksHandler({}, res);
  assert(res.statusCode === 404, 'unset ANDROID_APP_SHA256_FINGERPRINTS → 404');
});
withFingerprints('not-a-fingerprint, AA:BB', function () {
  const res = fakeRes();
  af.assetLinksHandler({}, res);
  assert(res.statusCode === 404, 'only malformed fingerprints → 404 (never an empty claim)');
});

// ── 2. Set → 200 JSON with the exact statement shape ───────────────────
withFingerprints(' ' + FP1 + ' , garbage,' + FP2 + ',' + FP1, function () {
  const res = fakeRes();
  af.assetLinksHandler({}, res);
  assert(res.statusCode === 200, 'configured → 200');
  assert(res.headers['content-type'] === 'application/json', 'Content-Type application/json');
  let body = null;
  try { body = JSON.parse(res.body); } catch (_) { /* asserted below */ }
  assert(Array.isArray(body) && body.length === 1, 'body is a one-statement JSON array');
  const st = body && body[0];
  assert(st && JSON.stringify(st.relation) === JSON.stringify(['delegate_permission/common.handle_all_urls']),
    'relation is delegate_permission/common.handle_all_urls');
  assert(st && st.target && st.target.namespace === 'android_app', 'namespace android_app');
  assert(st && st.target && st.target.package_name === 'com.tashkheesa.patient', 'package com.tashkheesa.patient');
  const fps = st && st.target && st.target.sha256_cert_fingerprints;
  assert(JSON.stringify(fps) === JSON.stringify([FP1, FP2.toUpperCase()]),
    'fingerprints trimmed, upper-cased, de-duplicated, malformed entries dropped',
    'got ' + JSON.stringify(fps));
});

// ── 3. Mounted ahead of redirect / auth / CSRF / limiters ──────────────
{
  const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const route = server.indexOf("app.get('/.well-known/assetlinks.json'");
  assert(route !== -1, 'server.js mounts GET /.well-known/assetlinks.json');
  for (const [label, needle] of [
    ['canonical-host redirect', 'app.use(canonicalHostRedirect())'],
    ['staging basic auth', 'setupStagingAuth(app, CONFIG)'],
    ['base middlewares (sessions, CSRF, rate limiters)', 'baseMiddlewares(app);'],
    ['requirePhone gate', 'app.use(requirePhone())'],
  ]) {
    const at = server.indexOf(needle);
    assert(at !== -1 && route < at, 'assetlinks route is mounted before the ' + label);
  }
}

// ── 4. Live: a non-canonical Host still gets 200, not a 301 ────────────
module.exports = (async function () {
  const { canonicalHostRedirect } = require(path.join(ROOT, 'src', 'middleware', 'canonical_host.js'));
  const app = express();
  app.get('/.well-known/assetlinks.json', af.assetLinksHandler);
  app.use(canonicalHostRedirect({ enabled: true, canonicalHost: 'tashkheesa.com' }));
  app.use(function (req, res) { res.status(418).end(); });

  const saved = process.env.ANDROID_APP_SHA256_FINGERPRINTS;
  process.env.ANDROID_APP_SHA256_FINGERPRINTS = FP1;
  const server = http.createServer(app);
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    for (const host of ['tashkheesa.com', 'www.tashkheesa.com', 'tashkheesa.onrender.com']) {
      const out = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/.well-known/assetlinks.json',
          method: 'GET', headers: { Host: host } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', data }));
        });
        req.on('error', reject);
        req.end();
      });
      assert(out.status === 200 && /application\/json/.test(out.type),
        'Host ' + host + ' → 200 application/json (no redirect)', 'got ' + out.status + ' ' + out.type);
    }
  } catch (e) {
    t.fail(tag + ': live request', e);
  } finally {
    if (saved === undefined) delete process.env.ANDROID_APP_SHA256_FINGERPRINTS;
    else process.env.ANDROID_APP_SHA256_FINGERPRINTS = saved;
    await new Promise((r) => server.close(r));
  }
})();
