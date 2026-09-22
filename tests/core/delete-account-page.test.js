'use strict';
// tests/core/delete-account-page.test.js
//
// Play's account-deletion requirement (2026-09-22)
//
// An app that creates accounts needs BOTH an in-app deletion path and a web
// page where someone who has uninstalled the app can request the same thing.
// The URL is declared in the Data safety form and Play checks it loads, names
// the app, and carries a working request route.
//
// The dangerous way to satisfy that is a form that deletes. It has no proof of
// identity, so it would hand anyone who knows a patient's e-mail address a
// button that erases their medical history. These pin the safe shape: the page
// opens a request, never deletes, never reveals whether an account exists, and
// records the request before it tries to mail anyone.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🗑️  /delete-account — the web deletion route Play requires\n');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const routes = read('src/routes/static-pages.js');
const langUrl = read('src/utils/public_lang_url.js');
const middleware = read('src/middleware.js');
const footer = read('src/views/partials/footer.ejs');
const viewSrc = read('src/views/delete_account_request.ejs');

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

// ── the route exists and is reachable in both languages ───────────────────

check('GET /delete-account is registered', () => (
  /router\.get\('\/delete-account'/.test(routes) ? null : 'no GET route'
));

check('POST /delete-account is registered', () => (
  /router\.post\('\/delete-account'/.test(routes) ? null : 'no POST route'
));

check('the page has an Arabic twin at /ar/delete-account', () => (
  /'\/delete-account'/.test(langUrl)
    ? null
    : 'not in PUBLIC_EXACT — /ar/delete-account would 404 for every Arabic patient'
));

check('the page is in the sitemap, so it is findable without the app', () => {
  const m = routes.match(/SITEMAP_STATIC_PATHS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return 'SITEMAP_STATIC_PATHS not found';
  return /'\/delete-account'/.test(m[1]) ? null : 'not listed in the sitemap';
});

check('the shared footer links to it', () => (
  /\/delete-account/.test(footer) ? null : 'no footer link — Play asks for it to be prominent'
));

// The homepage does NOT use partials/footer.ejs. It carries its own footer
// markup, so the shared-partial check above passes while / has no link at
// all — which is exactly what happened on the first deploy, on the one page
// a reviewer is most likely to land on.
check('the homepage, which has its own footer, links to it too', () => (
  /\/delete-account/.test(read('src/views/index.ejs'))
    ? null
    : 'index.ejs has its own footer and no deletion link in it'
));

check('the unauthenticated form is rate limited', () => (
  /app\.use\('\/delete-account',\s*authLimiter\)/.test(middleware)
    ? null
    : 'not behind authLimiter — an open form that writes a row and sends mail'
));

// ── the shape that keeps it safe ──────────────────────────────────────────

check('the POST handler never deletes anything itself', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  const handler = body.slice(0, body.indexOf('router.get(\'/faq\''));
  if (/deleteAccount\s*\(/.test(handler)) return 'it calls deleteAccount() with no proof of identity';
  if (/DELETE\s+FROM/i.test(handler)) return 'it runs a DELETE';
  return null;
});

check('it records the request before it tries to send mail', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  const handler = body.slice(0, body.indexOf('router.get(\'/faq\''));
  const logAt = handler.indexOf('logErrorToDb');
  const mailAt = handler.indexOf('sendMail');
  if (logAt === -1) return 'the request is not persisted at all';
  if (mailAt === -1) return 'nobody is notified';
  return logAt < mailAt ? null : 'mail is attempted before the durable record';
});

check('a missing identifier is rejected, not silently accepted', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  return /if \(!email && !phone\)/.test(body) ? null : 'no identifier check';
});

check('the honeypot answers like a success, so a bot learns nothing', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  const hp = body.slice(body.indexOf('body.company'), body.indexOf('body.company') + 240);
  return /formState:\s*'sent'/.test(hp) ? null : 'the honeypot path does not mimic success';
});

check('the operator is told to verify before erasing', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  return /[Dd]o not delete on the strength of this form alone/.test(body)
    ? null
    : 'the notification email does not warn against acting on it unverified';
});

check('it redirects after POST, so a refresh cannot resubmit', () => {
  const body = routes.slice(routes.indexOf("router.post('/delete-account'"));
  return /res\.redirect\(303/.test(body) ? null : 'no 303 redirect — refresh would file a second request';
});

// ── the page itself renders, in both languages and all three states ───────

const stripped = viewSrc.replace(/<%- include\([^)]*\) %>/g, '');
const base = { title: 't', BUSINESS_INFO: {}, csrfField: () => '<input type="hidden" name="_csrf" value="tok">' };
const render = (o) => ejs.render(stripped, Object.assign({}, base, o), { filename: 'delete_account_request.ejs' });

function renders(name, opts, needles, absent) {
  check(name, () => {
    const html = render(opts);
    for (const n of needles) if (html.indexOf(n) === -1) return 'missing: ' + n;
    for (const n of (absent || [])) if (html.indexOf(n) !== -1) return 'should not contain: ' + n;
    return null;
  });
}

renders('EN renders the form, the CSRF field and the package name',
  { isAr: false, publicLinkPrefix: '' },
  ['Delete your account and data', 'com.tashkheesa.patient', 'Send deletion request',
   'name="_csrf"', 'action="/delete-account"', 'Delete account']);

renders('AR renders in Arabic and keeps the /ar prefix on the form action',
  { isAr: true, publicLinkPrefix: '/ar' },
  ['حذف حسابك وبياناتك', 'أرسل طلب الحذف', 'action="/ar/delete-account"', 'href="/ar/privacy"']);

renders('the sent state drops the form and promises verification, not deletion',
  { isAr: false, publicLinkPrefix: '', formState: 'sent' },
  ['We have your request', 'confirm the request came from you'],
  ['<form', 'Send deletion request']);

renders('the sent state does not say whether an account was found',
  { isAr: false, publicLinkPrefix: '', formState: 'sent' },
  ['If an account matches']);

renders('the error state keeps what the person already typed',
  { isAr: false, publicLinkPrefix: '', formState: 'error', formValues: { email: 'a@b.com', note: 'please' } },
  ['value="a@b.com"', 'please', 'Please give us either']);

renders('a hostile value is escaped rather than executed',
  { isAr: false, publicLinkPrefix: '', formState: 'error', formValues: { email: '"><script>alert(1)</script>' } },
  ['&lt;script&gt;'], ['<script>alert(1)</script>']);

renders('the honeypot is hidden inline, so a missing stylesheet cannot expose it',
  { isAr: false, publicLinkPrefix: '' },
  ['left:-10000px', 'name="company"']);

renders('the in-app route is given first, and the timeframe is stated',
  { isAr: false, publicLinkPrefix: '' },
  ['Fastest route: from inside the app', 'If you no longer have the app', 'up to 30 working days']);
