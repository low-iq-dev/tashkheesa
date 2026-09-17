'use strict';

// src/middleware/robots_noindex.js
//
// SEO 2026-09-18 — the auth pages (/login, /register, /forgot-password,
// /doctor/signup) served 200 with no robots directive at all, and the
// orphaned pre-launch /coming-soon page was actively `index, follow` — a page
// with no place in the sitemap that could outrank the real ones. All of them
// now carry `X-Robots-Tag: noindex, follow` as a RESPONSE HEADER, which a
// template edit cannot silently drop the way a <meta> tag can.
//
// `follow`, not `none`: these pages link onward to real content (the footer,
// the nav, the homepage) and those links should keep passing.

var NOINDEX_EXACT = new Set([
  '/login', '/register', '/forgot-password', '/doctor/signup',
  '/coming-soon', '/unsubscribe'
]);

// The live unsubscribe route is /unsubscribe/:token.
var NOINDEX_PREFIXES = ['/unsubscribe/'];

// Trailing slashes and case folded the same way Express matches routes, so
// /Login and /coming-soon/ cannot slip past the header.
function normalise(p) {
  var s = String(p || '/').toLowerCase();
  var end = s.length;
  while (end > 1 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : (s.slice(0, end) || '/');
}

function isNoindexPath(p) {
  var n = normalise(p);
  if (NOINDEX_EXACT.has(n)) return true;
  return NOINDEX_PREFIXES.some(function (pre) { return n.indexOf(pre) === 0; });
}

// Mounted AFTER publicLangPrefix, which rewrites /ar/coming-soon to
// /coming-soon — so one check covers both languages of the public pages, and
// the auth pages (never rewritten) match as-is.
function robotsNoindex() {
  return function robotsNoindexMiddleware(req, res, next) {
    if (isNoindexPath(req.path)) {
      res.setHeader('X-Robots-Tag', 'noindex, follow');
    }
    return next();
  };
}

module.exports = { robotsNoindex: robotsNoindex, isNoindexPath: isNoindexPath, NOINDEX_EXACT: NOINDEX_EXACT };
