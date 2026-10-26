'use strict';

// 26 Oct 2026 — BEACON-POST. The CTA tap on /start is fired as the browser
// navigates away, and fetch(keepalive) does not survive that in Meta's in-app
// WebView, which is ~99% of paid traffic. On 25 Oct the page recorded 236
// start_view (nothing racing it) but 1 start_cta, against 9 server-side
// register_view — and the CTA links straight to /register, so at least nine
// taps happened and one was counted. navigator.sendBeacon is built for the
// unload path and always POSTs, so /f/e now answers POST as well as GET.
//
// These tests pin the three things that make that work, each of which fails
// silently rather than loudly if it regresses: the POST route exists and
// counts, CSRF lets it through, and the page actually reaches for sendBeacon
// first. A silent regression here looks exactly like a bad landing page —
// which is the mistake this change exists to stop repeating.
//
// Hermetic: src/pg is stubbed in the require cache before anything loads it,
// and the router is mounted on a bare express app on an ephemeral port.
// Run: node --test tests/core/funnel-beacon-post.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');

// NO CACHE SURGERY — tests/run.js require()s every test file into ONE process,
// so require.cache is shared by the whole suite. An earlier version of this
// file stubbed src/pg in the cache and left it there, handing a fake database
// to every file loaded afterwards: 13 pre-existing failures became 329.
// Restoring the cache afterwards does not work either, because the route
// handler calls require('../services/funnel_digest') lazily, per request, and
// would then pick up a fresh real-pg copy.
//
// So intercept at the seam the handler actually uses: it looks the two bump
// functions up as properties on the module object every time. Swapping those
// is local, reversible, and leaves the cache untouched.
const { setupStaticPages } = require('../../src/routes/static-pages');
const { setupCsrf } = require('../../src/middleware/csrf');
const fd = require('../../src/services/funnel_digest');

let writes = [];
const realBumpFunnelCount = fd.bumpFunnelCount;
const realBumpLandingView = fd.bumpLandingView;

// What this file tests is the ROUTE: that both verbs reach the handler, that
// the handler picks the right counter for a step name, and that it forwards
// the campaign parameters. funnel_digest's own behaviour — the allow-list of
// counter names, the bot filter, the per-visitor dedupe — belongs to
// register-view-provenance.test.js and funnel-alerts-short-signup.test.js.
// So these recorders deliberately do not delegate.
function recordBumps() {
  writes = [];
  fd.bumpFunnelCount = function (step) { writes.push(String(step)); };
  fd.bumpLandingView = function (page, req) {
    const q = (req && req.query) || {};
    writes.push('landing:' + page + ':' + (q.utm_source || '-') + ':' + (q.utm_campaign || '-'));
  };
  return writes;
}
function restoreBumps() {
  fd.bumpFunnelCount = realBumpFunnelCount;
  fd.bumpLandingView = realBumpLandingView;
}

function startApp(withCsrf) {
  const app = express();
  app.set('trust proxy', true);
  // CSRF_MODE must be 'enforce' or the middleware waves everything through and
  // the exemption test would pass whether or not the exemption exists. Set it
  // explicitly rather than inferring it from MODE: the whole suite shares one
  // process.env, so an earlier file may have left CSRF_MODE at 'off' — which
  // is exactly how this test passed alone and failed in the full run.
  // The control case below proves enforcement really is on.
  if (withCsrf) {
    process.env.CSRF_MODE = 'enforce';
    setupCsrf(app, { MODE: 'production', COOKIE_SECURE: false, COOKIE_SAMESITE: 'lax' });
  }
  app.use('/', setupStaticPages({ execute: async () => ({}), safeAll: async () => [], siteStats: { getCatalogueStats: async () => null } }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A distinct IP per call, so the beacon's per-day dedupe (step|ip|ua) never
// swallows a case and hides a failure behind a passing test.
let ipSeq = 0;
async function beacon(port, method, step) {
  return fetch(`http://127.0.0.1:${port}/f/e?s=${encodeURIComponent(step)}&src=meta&c=traffic-26sep`, {
    method,
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      'x-forwarded-for': '198.51.100.' + (++ipSeq),
    },
  });
}

test('POST /f/e counts a CTA tap and answers 204, exactly as GET does', async () => {
  const { server, port } = await startApp(false);
  try {
    recordBumps();
    const post = await beacon(port, 'POST', 'start_cta');
    assert.equal(post.status, 204, 'sendBeacon POST must be routed, not 404');
    assert.deepEqual(writes, ['start_cta'], 'the POST must reach the counter');

    recordBumps();
    const get = await beacon(port, 'GET', 'start_cta');
    assert.equal(get.status, 204);
    assert.deepEqual(writes, ['start_cta'], 'GET must keep working for the fetch fallback');
  } finally { restoreBumps(); server.close(); }
});

test('POST /f/e records the landing view with its campaign split intact', async () => {
  // The two verbs share one handler; this proves the query-string parsing that
  // feeds bumpLandingView was not lost in the split.
  const { server, port } = await startApp(false);
  try {
    recordBumps();
    const r = await beacon(port, 'POST', 'start_view');
    assert.equal(r.status, 204);
    // The handler's job is to call bumpLandingView for the right page and to
    // forward src/c as utm_source/utm_campaign. What bumpLandingView then does
    // with them (the _meta and @campaign splits) is its own test's business.
    assert.deepEqual(writes, ['landing:start:meta:traffic-26sep'],
      'the handler must forward the campaign parameters to bumpLandingView');
  } finally { restoreBumps(); server.close(); }
});

test('an unknown step writes nothing but still answers 204', async () => {
  // The endpoint is public and CSRF-exempt, so the allow-list is the only
  // thing standing between a stranger and an arbitrary counter name.
  const { server, port } = await startApp(false);
  try {
    for (const step of ['nonsense', 'paid', '__digest_sent', 'register_view']) {
      recordBumps();
      const r = await beacon(port, 'POST', step);
      assert.equal(r.status, 204, step + ' must not error');
      assert.deepEqual(writes, [], step + ' is not an allow-listed beacon step and must write nothing');
    }
  } finally { restoreBumps(); server.close(); }
});

test('CSRF lets the beacon POST through — sendBeacon cannot carry a token', async () => {
  // Without the exemption every sendBeacon call 403s and start_cta silently
  // stays at zero, which is indistinguishable from "nobody clicked".
  // The suite shares one process.env — put CSRF_MODE back exactly as found so
  // this file cannot change how a later one behaves.
  const prevMode = process.env.CSRF_MODE;
  const { server, port } = await startApp(true);
  try {
    // Control: a tokenless POST to a path that is NOT exempt must be refused.
    // If this ever returns something other than 403, CSRF is not enforcing and
    // the assertion below proves nothing.
    const control = await fetch(`http://127.0.0.1:${port}/not-exempt-control`, { method: 'POST' });
    assert.equal(control.status, 403, 'CSRF is not enforcing — the next assertion would be vacuous');

    recordBumps();
    const r = await beacon(port, 'POST', 'start_cta');
    assert.equal(r.status, 204, 'CSRF must not block /f/e — got ' + r.status);
    assert.deepEqual(writes, ['start_cta']);
  } finally {
    restoreBumps();
    server.close();
    if (prevMode === undefined) delete process.env.CSRF_MODE; else process.env.CSRF_MODE = prevMode;
  }
});

test('the CSRF exemption is exactly /f/e and nothing around it', async () => {
  // A prefix or startsWith() exemption here would quietly unprotect other
  // routes — the mistake AUDIT-P0-7 had to undo for /api/cases/.
  const csrf = fs.readFileSync(path.join(ROOT, 'src/middleware/csrf.js'), 'utf8');
  assert.match(csrf, /p === '\/f\/e'/, 'the exemption must be an exact-match on /f/e');
  assert.ok(
    !/startsWith\(\s*'\/f\b/.test(csrf),
    'never exempt /f by prefix — it would cover anything added under it later'
  );
});

test('start.ejs reaches for sendBeacon before falling back to fetch', () => {
  const page = fs.readFileSync(path.join(ROOT, 'src/views/start.ejs'), 'utf8');
  assert.match(page, /navigator\.sendBeacon/, 'the CTA beacon must use sendBeacon');
  assert.match(page, /keepalive:\s*true/, 'fetch must remain as the fallback');
  const beaconAt = page.indexOf('navigator.sendBeacon');
  const fetchAt = page.indexOf("fetch(url,");
  assert.ok(beaconAt > -1 && fetchAt > -1 && beaconAt < fetchAt, 'sendBeacon must be tried first');
});

test('every CTA and WhatsApp link still carries a data-funnel step', () => {
  // The listener is bound by querySelectorAll('[data-funnel]'). Losing the
  // attribute in a copy edit silently stops counting that button.
  const page = fs.readFileSync(path.join(ROOT, 'src/views/start.ejs'), 'utf8');
  const steps = (page.match(/data-funnel="([a-z_]+)"/g) || []).map((s) => s.split('"')[1]);
  assert.ok(steps.filter((s) => s === 'start_cta').length >= 2, 'both the hero and footer Start buttons must be tracked');
  assert.ok(steps.includes('start_wa'), 'the WhatsApp button must be tracked');
  for (const s of steps) {
    assert.match(s, /^start_(cta|wa)$/, 'unexpected funnel step on the page: ' + s);
  }
});
