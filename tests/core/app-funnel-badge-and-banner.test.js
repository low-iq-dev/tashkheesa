'use strict';
// tests/core/app-funnel-badge-and-banner.test.js
//
// App funnel 2026-09-23 — Google Play badge + Android smart banner.
//
// The property that matters most is the OFF state: with PLAY_STORE_URL unset
// the marketing pages must render exactly as before (no badge, no banner, no
// stylesheet). Then: when set, the badge appears on the marketing surface only
// (home, /app, the public footer) with a correctly encoded install referrer,
// and never on a portal/auth page.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const tag = 'app-funnel-badge';
console.log('\n📲 App funnel — Play badge + Android smart banner\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function assert(cond, label, detail) {
  if (cond) t.pass(tag + ': ' + label);
  else t.fail(tag + ': ' + label, new Error(detail || 'assertion failed'));
}

const funnelPath = path.join(ROOT, 'src', 'utils', 'app_funnel.js');
const PLAY = 'https://play.google.com/store/apps/details?id=com.tashkheesa.patient';

function withEnv(value, fn) {
  const saved = process.env.PLAY_STORE_URL;
  if (value === undefined) delete process.env.PLAY_STORE_URL;
  else process.env.PLAY_STORE_URL = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.PLAY_STORE_URL;
    else process.env.PLAY_STORE_URL = saved;
  }
}

function localsFor(extra) {
  delete require.cache[require.resolve(funnelPath)];
  const af = require(funnelPath);
  const res = { locals: {} };
  af.appFunnelLocals()({}, res, function () {});
  return Object.assign({
    lang: 'en', isAr: false, dir: 'ltr',
    tt: function (k, en) { return en; },
    t: function (k, f) { return f || k; },
    title: 'X', currentUrl: '/', publicLinkPrefix: '', cspNonce: 'n',
    specialtyCount: 7, priceRangeMin: '1', priceRangeMax: '2', currency: 'EGP',
    businessEmail: 'e', businessPhone: 'p', businessAddress: 'a',
    variant: 'desktop', csrfField: function () { return ''; }
  }, res.locals, extra || {});
}

function render(view, extra) {
  const file = path.join(VIEWS, view + '.ejs');
  return ejs.render(fs.readFileSync(file, 'utf8'), localsFor(extra), { filename: file });
}

const count = (html, re) => (html.match(re) || []).length;
const BADGE = /data-app-badge="/g;
const BANNER = /data-app-smart-banner(?=[\s>])/g;

// ── 1. OFF: nothing renders ────────────────────────────────────────────
withEnv(undefined, function () {
  for (const view of ['index', 'app_landing', 'privacy', 'about']) {
    try {
      const html = render(view);
      assert(count(html, BADGE) === 0, view + ': no Play badge when PLAY_STORE_URL is unset');
      assert(count(html, BANNER) === 0, view + ': no smart banner when PLAY_STORE_URL is unset');
      assert(html.indexOf('app-funnel.css') === -1 && html.indexOf('app_smart_banner.js') === -1,
        view + ': no funnel CSS/JS requested when PLAY_STORE_URL is unset');
    } catch (e) { t.fail(tag + ': render ' + view + ' (off)', e); }
  }
});

// A non-https value is treated as unset (a typo must not ship a dead link).
withEnv('http://play.google.com/store/apps/details?id=x', function () {
  try {
    assert(count(render('privacy'), BADGE) === 0, 'a non-https PLAY_STORE_URL is treated as unset');
  } catch (e) { t.fail(tag + ': render non-https', e); }
});

// ── 2. ON: marketing surface gets the badge, with the referrer ─────────
withEnv(PLAY, function () {
  try {
    const home = render('index');
    assert(/data-app-badge="home"/.test(home), 'home renders the badge (placement=home)');
    assert(/data-app-badge="footer"/.test(home), 'home footer renders the badge');
    assert(count(home, BANNER) === 1, 'home renders the smart banner markup');
    assert(/<div class="tk-app-banner" data-app-smart-banner hidden/.test(home),
      'smart banner ships hidden (JS reveals it on Android only — no desktop layout shift)');
    const enc = encodeURIComponent('utm_source=website&utm_medium=home&utm_campaign=app_launch');
    assert(home.indexOf(PLAY + '&amp;referrer=' + enc) !== -1,
      'badge href carries the URL-encoded install referrer', 'expected referrer=' + enc);

    const ar = render('index', { lang: 'ar', isAr: true, dir: 'rtl',
      tt: function (k, en, a) { return a || en; } });
    assert(ar.indexOf('احصل عليه من') !== -1, 'Arabic home renders the Arabic badge label');

    const landing = render('app_landing');
    assert(/data-app-badge="app_landing"/.test(landing), '/app renders the badge (placement=app_landing)');
    assert(count(landing, BANNER) === 0, '/app hides the smart banner (it already leads with the badge)');

    const privacy = render('privacy');
    assert(/data-app-badge="footer"/.test(privacy), 'public layout footer renders the badge');
    assert(/utm_medium%3Dsmart_banner/.test(privacy), 'smart banner link uses utm_medium=smart_banner');
  } catch (e) { t.fail(tag + ': render (on)', e); }

  // Auth-layout page: shares partials/footer but must not get the badge.
  try {
    const html = render('forgot_password');
    assert(count(html, BADGE) === 0, 'auth-layout page (forgot_password) renders no badge');
    assert(count(html, BANNER) === 0, 'auth-layout page renders no smart banner');
  } catch (e) { t.fail(tag + ': render forgot_password', e); }

  // Portal frame: even if something marked the request as marketing, the
  // portal-framed footer never renders the badge.
  try {
    const file = path.join(VIEWS, 'partials', 'footer.ejs');
    const l = localsFor({ portalFrame: true, user: { role: 'patient' } });
    if (l.appFunnel) l.appFunnel.marketing = true;
    const html = ejs.render(fs.readFileSync(file, 'utf8'), l, { filename: file });
    assert(count(html, BADGE) === 0, 'portal-framed footer renders no badge');
  } catch (e) { t.fail(tag + ': render portal footer', e); }
});

// ── 3. Source pins ─────────────────────────────────────────────────────
{
  for (const layout of ['portal', 'auth', 'superadmin']) {
    const src = read('src/views/layouts/' + layout + '.ejs');
    assert(!/app_badge|app_smart_banner|appFunnel/.test(src),
      'layouts/' + layout + '.ejs does not include the badge or banner (patient-data surface)');
  }
  const partial = read('src/views/partials/app_smart_banner.ejs');
  assert(!/<script(?![^>]*\bsrc=)/.test(partial),
    'smart banner has no inline script (CSP: served from /js, no nonce needed)');
  const js = read('public/js/app_smart_banner.js');
  assert(/try\s*\{[^}]*localStorage\.getItem/.test(js) && /try\s*\{[^}]*localStorage\.setItem/.test(js),
    'every localStorage access in the banner script is try/catch wrapped');
  assert(/30 \* 24 \* 60 \* 60 \* 1000/.test(js), 'dismissal is remembered for 30 days');
  assert(/Android/.test(js), 'banner is revealed only for Android user agents');
  const server = read('src/server.js');
  assert((server.match(/appFunnelLocals\(\)/g) || []).length === 1,
    'PLAY_STORE_URL reaches the views through exactly one middleware');
}
