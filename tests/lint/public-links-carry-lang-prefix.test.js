// tests/lint/public-links-carry-lang-prefix.test.js
//
// SEO 2026-09-13 (A3, widened after review) — every link to a public
// marketing page carries the language prefix, in EVERY view.
//
// Each public page has an English URL and an /ar/ URL, and the URL alone
// decides its language. A hard-coded href="/services" therefore always opens
// English: on an /ar/ page it walks a crawler out of the Arabic site, and on a
// portal or auth page it drops an Arabic user into English (those pages used to
// follow the cookie; they no longer do).
//
// Rule: a literal root-relative href/action whose path IS a public page
// (src/utils/public_lang_url.js isPublicPath — the same allowlist the router
// uses) must be written with the prefix expression
//     href="<%= locals.publicLinkPrefix || '' %>/services"
// which is '' for English and '/ar' for Arabic (set on every request by
// src/middleware.js), or be a literal /ar/… link, or be the language switch
// itself (<a rel="alternate" hreflang=…>). Links to portal/auth/API paths are
// not public pages and are not affected.
//
// Also: the public header/homepage auth links carry the page's language
// (?lang=ar / ?lang=en), because a public page no longer sets the cookie.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🔗 SEO A3 — links to public pages carry the language prefix (all views)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const { isPublicPath } = require(path.join(ROOT, 'src', 'utils', 'public_lang_url'));

const PREFIX_EXPR = "<%= locals.publicLinkPrefix || '' %>";
const AUTH_LANG_EXPR = "<%= locals.langParam ? '?' + locals.langParam : '' %>";
// Operator consoles are English-only by ground rule, and the help guides draw
// fake browser mock-ups; neither is a navigation surface into the public site.
const EXEMPT = /^(ops-|help_(admin|doctor|patient)_guide)/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.ejs') ? [p] : []);
  });
}
function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

// The page path an href points at. An EJS tag after a slash stands for a slug
// (/blog/<%= p.slug %> → /blog/slug); a path that is dynamic from the root is
// unknown and not judged.
function targetPath(raw) {
  const hasEjs = raw.indexOf('<%') !== -1;
  let p = raw.split('<%')[0].split(/[?#]/)[0] || '/';
  if (hasEjs) {
    if (p === '/') return null;
    if (p.endsWith('/')) p += 'slug';
  }
  return p;
}

let files = 0;
let prefixedTotal = 0;
const violations = [];

for (const file of walk(VIEWS)) {
  const rel = path.relative(VIEWS, file);
  if (EXEMPT.test(path.basename(rel))) continue;
  files++;
  const src = fs.readFileSync(file, 'utf8');
  prefixedTotal += src.split(PREFIX_EXPR + '/').length - 1;
  // href="/x", href='/x', action="/x" — including inside JS strings.
  const re = /\b(href|action)\s*=\s*\\?(["'])(\/(?!\/)[^"'\s>\\]*(?:<%[^%]*%>[^"'\s>\\]*)*)/g;
  let m;
  while ((m = re.exec(src))) {
    const p = targetPath(m[3]);
    if (p === null || !isPublicPath(p)) continue;
    // The language switch is the one link MEANT to cross languages.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    const tagAt = line.lastIndexOf('<a', m.index - lineStart);
    if (tagAt !== -1 && /rel="alternate"/.test(line.slice(tagAt)) && /\bhreflang=/.test(line.slice(tagAt))) continue;
    violations.push('src/views/' + rel + ':' + lineOf(src, m.index) + ' — ' + m[1] + '="' + m[3] + '" (write it as ' + m[1] + '="' + PREFIX_EXPR + m[3] + '")');
  }
}

try {
  if (violations.length) throw new Error(violations.length + ' unprefixed link(s) to public pages:\n    ' + violations.join('\n    '));
  t.pass('no unprefixed links to public pages in ' + files + ' views');
} catch (e) { t.fail('public-links-carry-lang-prefix', e); }

try {
  if (files < 150) throw new Error('only ' + files + ' views scanned');
  if (prefixedTotal < 55) throw new Error('only ' + prefixedTotal + ' prefixed links found — the scan is not seeing the views it should');
  t.pass('sanity floor: ' + files + ' views, ' + prefixedTotal + ' prefixed links');
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
  if (bad.length) throw new Error('auth links without the page language:\n    ' + bad.join('\n    '));
  t.pass('header/homepage auth links carry the page language');
} catch (e) { t.fail('auth links carry lang', e); }
