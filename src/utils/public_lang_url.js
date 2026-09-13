'use strict';

// src/utils/public_lang_url.js
//
// SEO 2026-09-13 (Part A) — one URL per language for the public marketing site.
//
// Until this module, Arabic had no address of its own. The language came from
// a `lang` cookie, the session, or `?lang=ar`, and defaulted to English. A
// crawler carries no cookie, so Google saw English at every URL, `/ar/` was a
// 404, and every Arabic page declared the English URL as its canonical. The
// Arabic site was, as far as search was concerned, not there.
//
// Now every public page has two URLs — `/services` and `/ar/services` — and
// the URL alone decides the language. The middleware below runs before the
// language resolution in src/middleware.js, strips the `/ar` prefix so every
// existing route handler runs unchanged, and leaves the portal (and anything
// else not in the allowlist) on the old cookie/session mechanism untouched.
//
// Only the paths listed here get an `/ar/` twin. Anything else under `/ar/`
// (`/ar/login`, `/ar/portal/...`) is not rewritten and falls through to the
// normal 404: auth pages deliberately stay cookie-driven, and a portal URL must
// never be reachable under a second address.

const PUBLIC_EXACT = new Set([
  '/', '/services', '/specialties', '/about', '/contact', '/faq', '/blog',
  '/privacy', '/terms', '/refund-policy', '/delivery-policy', '/apply',
  '/help-me-choose', '/app', '/coming-soon',
  // Legacy .html addresses. They only redirect, but an Arabic one must
  // redirect to the Arabic page, so they need to know the prefix too.
  '/services.html', '/privacy.html', '/terms.html', '/about.html', '/contact.html', '/doctors.html',
  '/site/services.html', '/site/about.html', '/site/contact.html', '/site/doctors.html',
  '/site/privacy.html', '/site/terms.html'
]);

// Slugs are restricted to what the handlers accept anyway ([a-z0-9-]); anything
// else is not a public page and is not rewritten.
const PUBLIC_PATTERNS = [
  /^\/specialties\/[a-z0-9-]+$/,
  /^\/blog\/[a-z0-9-]+$/
];

const AR_HREFLANG = 'ar-EG';

// Express routing is not strict, so `/services/` reaches the `/services`
// handler; treat it as the same page here too.
function normalisePath(p) {
  const s = String(p || '/');
  if (s === '/') return s;
  return s.replace(/\/+$/, '') || '/';
}

function isPublicPath(p) {
  const n = normalisePath(p);
  if (PUBLIC_EXACT.has(n)) return true;
  return PUBLIC_PATTERNS.some(function (re) { return re.test(n); });
}

// '/ar' -> { isAr: true, path: '/' }; '/ar/services' -> { isAr: true, path: '/services' }
function splitLangPrefix(p) {
  const s = String(p || '/');
  const m = /^\/ar(\/.*)?$/.exec(s);
  if (!m) return { isAr: false, path: s };
  return { isAr: true, path: m[1] || '/' };
}

// The path of a page in a language. The Arabic home is '/ar/', never '/ar'.
function pathFor(lang, p) {
  const n = normalisePath(p);
  if (lang !== 'ar') return n;
  return n === '/' ? '/ar/' : '/ar' + n;
}

// Absolute URLs for <link rel="canonical"> and <link rel="alternate" hreflang>.
// x-default is English: it is the page for a visitor whose language we do not
// serve, and English is the broader fallback.
function alternateUrls(siteUrl, p) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  return {
    en: base + pathFor('en', p),
    ar: base + pathFor('ar', p),
    xDefault: base + pathFor('en', p)
  };
}

// Raw query string minus every `lang` parameter, with its leading '?' ('' when
// nothing is left). Built from the raw URL rather than req.query so a repeated
// or array-shaped `lang` cannot survive.
function queryWithoutLang(rawUrl) {
  const s = String(rawUrl || '');
  const q = s.indexOf('?');
  if (q === -1) return '';
  const params = new URLSearchParams(s.slice(q + 1));
  params.delete('lang');
  const out = params.toString();
  return out ? '?' + out : '';
}

function publicLangPrefix() {
  return function publicLangPrefixMiddleware(req, res, next) {
    const split = splitLangPrefix(req.path);
    if (!isPublicPath(split.path)) {
      // Not a public page: the portal, auth pages, APIs, and any /ar/<other>.
      // Their HTML depends on the session/cookie, so say so to any cache.
      res.vary('Cookie');
      return next();
    }

    const method = String(req.method || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const rawQuery = req.url.indexOf('?') === -1 ? '' : req.url.slice(req.url.indexOf('?'));

    if (isRead) {
      // `?lang=` on a public page: one permanent redirect to the page's URL in
      // the requested language, parameter stripped. A crawler that found an old
      // `?lang=ar` link lands on — and consolidates signals into — `/ar/...`.
      // The Location path comes from the allowlist above, never from input, so
      // this cannot be turned into an open redirect.
      const params = new URLSearchParams(rawQuery.slice(1));
      if (params.has('lang')) {
        const asked = String(params.get('lang') || '').toLowerCase();
        const target = asked === 'ar' ? 'ar' : (asked === 'en' ? 'en' : (split.isAr ? 'ar' : 'en'));
        return res.redirect(301, pathFor(target, split.path) + queryWithoutLang(req.url));
      }
      // '/ar' -> '/ar/': the Arabic home has exactly one address.
      if (split.isAr && req.path === '/ar') {
        return res.redirect(301, '/ar/' + rawQuery);
      }
    }

    const lang = split.isAr ? 'ar' : 'en';
    if (split.isAr) {
      // Existing handlers run on the unprefixed path. req.originalUrl keeps
      // '/ar/...', which is what templates read as the current URL.
      req.url = split.path + rawQuery;
    }

    res.locals.lang = lang;
    res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
    res.locals.isAr = lang === 'ar';
    res.locals.langPrefix = split.isAr ? '/ar' : '';
    res.locals.publicPath = normalisePath(split.path);
    res.locals.altLangUrl = pathFor(split.isAr ? 'en' : 'ar', split.path);
    res.locals.altLang = split.isAr ? 'en' : 'ar';
    res.setHeader('Content-Language', lang);
    return next();
  };
}

// Specialty slug from its id — the one rule the index links, the detail route
// and the sitemap all share.
function specialtySlug(id) {
  return String(id || '').replace(/^spec-/, '');
}

module.exports = {
  AR_HREFLANG,
  PUBLIC_EXACT,
  isPublicPath,
  splitLangPrefix,
  pathFor,
  alternateUrls,
  queryWithoutLang,
  publicLangPrefix,
  specialtySlug
};
