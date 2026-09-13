// tests/lint/public-links-carry-lang-prefix.test.js
//
// SEO 2026-09-13 (A3) — internal links on the public site carry the language
// prefix.
//
// Each public page now has an English URL and an /ar/ URL. A hard-coded
// href="/services" on an Arabic page sends a crawler (and a visitor) from the
// Arabic site back to the English one, so Google follows its own internal links
// out of the Arabic site and never finds most of it.
//
// Rule, for every public view: a root-relative href/action must either
//   - start with the prefix expression (href="<%= locals.langPrefix || '' %>/..."),
//     which renders '' on English pages and '/ar' on Arabic ones, or
//   - point at a path that has no /ar/ twin: auth, portal, API, the /lang/
//     switch, static assets, or
//   - be the language switch itself (<a rel="alternate" hreflang=...>).
// And the auth links in the public header/homepage carry ?lang=ar on Arabic
// pages, so an Arabic visitor is not dropped into an English login.
//
// `locals.langPrefix`, not bare `langPrefix`: these views are also rendered
// directly (tests, other frames) without the public middleware, where a bare
// name would throw.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🔗 SEO A3 — public links carry the language prefix\n');

const VIEWS = path.join(__dirname, '..', '..', 'src', 'views');
const PUBLIC_VIEWS = [
  'layouts/public.ejs', 'partials/footer.ejs', 'index.ejs', 'about.ejs', 'contact.ejs', 'faq.ejs',
  'services.ejs', 'specialties_index.ejs', 'specialty_detail.ejs', 'blog_index.ejs',
  'blog_when_to_get_second_opinion.ejs', 'blog_how_tashkheesa_works.ejs', 'privacy.ejs', 'terms.ejs',
  'refund_policy.ejs', 'delivery_policy.ejs', 'apply.ejs', 'help_me_choose.ejs', 'app_landing.ejs',
  'coming_soon.ejs', '404.ejs'
];

// Paths with no /ar/ twin. Everything else root-relative must be prefixed.
const NO_TWIN = /^\/(login|register|forgot-password|reset-password|dashboard|patient|portal|doctor\/|admin|superadmin|api\/|lang\/|files\/|payments\/|help\/|site\/|assets\/|css\/|js\/|fonts\/|icons\/|vendor\/|uploads\/|favicon|styles\.css|apple-touch-icon|site\.webmanifest|manifest\.webmanifest)/;
const PREFIX_EXPR = "<%= locals.langPrefix || '' %>";
const AUTH_LANG_EXPR = "<%= locals.langPrefix ? '?lang=ar' : '' %>";

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

let prefixedTotal = 0;
const violations = [];

for (const rel of PUBLIC_VIEWS) {
  const file = path.join(VIEWS, rel);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { violations.push(rel + ': missing file'); continue; }
  prefixedTotal += src.split(PREFIX_EXPR + '/').length - 1;
  // href="/x", href='/x', action="/x" — including inside JS strings.
  const re = /\b(href|action)\s*=\s*(\\?["'])(\/(?!\/)[^"'\s>\\]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const target = m[3];
    if (NO_TWIN.test(target)) continue;
    // The language switch is the one link that is MEANT to cross languages:
    // an <a> carrying rel="alternate" + hreflang (the homepage EN/AR buttons).
    // Read the whole source line: the buttons are one line each, and an EJS
    // tag inside the <a> (its '%>') would end a naive '>' search early.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    const tagAt = line.lastIndexOf('<a', m.index - lineStart);
    if (tagAt !== -1 && /rel="alternate"/.test(line.slice(tagAt)) && /\bhreflang=/.test(line.slice(tagAt))) continue;
    violations.push('src/views/' + rel + ':' + lineOf(src, m.index) + ' — ' + m[1] + '="' + target + '" (prefix it with ' + PREFIX_EXPR + ')');
  }
}

try {
  if (violations.length) throw new Error(violations.length + ' unprefixed public link(s):\n    ' + violations.join('\n    '));
  t.pass('no unprefixed root-relative public links in ' + PUBLIC_VIEWS.length + ' public views');
} catch (e) { t.fail('public-links-carry-lang-prefix', e); }

try {
  if (prefixedTotal < 40) throw new Error('only ' + prefixedTotal + ' prefixed links found — the scan is not seeing the views it should');
  t.pass('sanity floor: ' + prefixedTotal + ' prefixed public links');
} catch (e) { t.fail('public-links-carry-lang-prefix sanity floor', e); }

try {
  const bad = [];
  for (const rel of ['layouts/public.ejs', 'index.ejs']) {
    const src = fs.readFileSync(path.join(VIEWS, rel), 'utf8');
    const re = /\bhref="\/(login|register)([^"]*)"/g;
    let m, seen = 0;
    while ((m = re.exec(src))) {
      seen++;
      if (m[2] !== AUTH_LANG_EXPR) bad.push(rel + ':' + lineOf(src, m.index) + ' — /' + m[1] + m[2]);
    }
    if (!seen) bad.push(rel + ': no /login or /register link found (the check is not seeing it)');
  }
  if (bad.length) throw new Error('auth links without the Arabic lang param:\n    ' + bad.join('\n    '));
  t.pass('header/homepage auth links carry ?lang=ar on Arabic pages');
} catch (e) { t.fail('auth links carry lang', e); }
