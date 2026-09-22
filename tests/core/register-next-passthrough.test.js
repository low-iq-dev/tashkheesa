'use strict';
// tests/core/register-next-passthrough.test.js
//
// 2026-09-22. A patient who clicks a service card on /ar/services is sent to
// /login?next=/patient/new-case?service_id=... — but /login's "Create account"
// link was a bare /register, so the service they picked was silently dropped
// for every first-time patient, which is everyone arriving from an ad.
// These pin the whole chain: login carries next to register, register carries
// it through its own form and back to login, and safeNextPath still refuses
// anything off-site.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🔗 signup keeps the service the patient chose\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');

// Stub every partial these two views pull in — we are testing the hrefs, not chrome.
['partials/header', 'partials/footer', 'partials/country_options'].forEach((p) => {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), () => '');
});

const SERVICE_NEXT = '/patient/new-case?service_id=card_ctca&lang=ar';

let rc = 0;
function render(view, extra) {
  const src = fs.readFileSync(path.join(VIEWS, view + '.ejs'), 'utf8');
  const locals = Object.assign({
    error: null,
    lang: 'ar',
    _lang: 'ar',
    isAr: true,
    copy: {},
    form: {},
    title: 'x',
    brand: 'Tashkheesa',
    tt: (key, en, ar) => (ar || en),
    csrfField: () => '',
    jsonForScript: (v) => JSON.stringify(v)
  }, extra || {});
  return ejs.render(src, locals, { filename: path.join(VIEWS, '__nextprobe_' + (++rc) + '.ejs'), cache: true });
}

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── login.ejs ──────────────────────────────────────────────────────────────
check('login: Create account carries next when there is one', () => {
  const html = render('login', { next: SERVICE_NEXT });
  const want = '/register?next=' + encodeURIComponent(SERVICE_NEXT);
  if (html.indexOf(want) === -1) return 'expected the Create account href to be ' + want;
  return null;
});

check('login: Create account stays bare when there is no next', () => {
  const html = render('login', { next: null });
  if (html.indexOf('href="/register"') === -1) return 'expected a plain href="/register"';
  if (html.indexOf('/register?next=') !== -1) return 'did not expect a next on a bare login';
  return null;
});

// ── register.ejs ───────────────────────────────────────────────────────────
check('register: the form carries next as a hidden field', () => {
  const html = render('register', { regNext: SERVICE_NEXT });
  if (!/<input type="hidden" name="next" value="[^"]+"/.test(html)) return 'expected a hidden next input';
  // EJS escapes the value, so the ? and & arrive as entities — that is correct.
  if (html.indexOf('service_id=card_ctca') === -1) return 'expected the chosen service in the hidden value';
  return null;
});

check('register: no hidden next when the patient came in cold', () => {
  const html = render('register', {});
  if (/name="next"/.test(html)) return 'did not expect a next field';
  return null;
});

check('register: the sign-in link hands next back to /login', () => {
  const html = render('register', { regNext: SERVICE_NEXT });
  const want = '/login?next=' + encodeURIComponent(SERVICE_NEXT);
  if (html.indexOf(want) === -1) return 'expected the sign-in href to be ' + want;
  return null;
});

// ── the guard still guards ─────────────────────────────────────────────────
const { safeNextPath } = require('../../src/routes/auth');

check('safeNextPath keeps a real service path', () => (
  safeNextPath(SERVICE_NEXT) === SERVICE_NEXT ? null : 'expected the path back unchanged'
));

[['https://evil.com', 'absolute url'],
 ['//evil.com/x', 'protocol-relative'],
 ['\\\\evil.com', 'backslash'],
 ['', 'empty']
].forEach(([candidate, label]) => {
  check('safeNextPath refuses ' + label, () => (
    safeNextPath(candidate) ? 'expected null for ' + JSON.stringify(candidate) : null
  ));
});
