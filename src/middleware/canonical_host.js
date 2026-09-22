'use strict';

// src/middleware/canonical_host.js
//
// SEO 2026-09-18 — tashkheesa.onrender.com serves the whole site: Render's
// default subdomain answers 200 with the full page on every route, a complete
// duplicate of tashkheesa.com on a second domain, discovered while the sitemap
// sat freshly submitted in Search Console. Any request whose Host is not the
// canonical host gets one 301 to the same path and query on the canonical
// origin, so the duplicate consolidates instead of competing.
//
// The redirect target is built from the CONFIGURED host only. The incoming
// Host / X-Forwarded-Host header is compared against it but never echoed into
// the Location header — echoing it back would be an open redirect the moment a
// request arrives with Host: evil.com.

// Probe endpoints answer on ANY host: Render's own health checks (and any
// uptime monitor pointed at the .onrender.com address) must keep getting a
// 200, not a redirect it may treat as failure.
var EXEMPT_PATHS = new Set(['/healthz', '/__version', '/health', '/status']);

// 2026-09-22 — the JSON APIs must answer on ANY host, never redirect.
//
// The mobile apps ship API_BASE_URL pointing at the .onrender.com origin
// (patient app, constants/api.ts). A 301 to the canonical host is cross-origin,
// and every mainstream HTTP client — curl, NSURLSession, okhttp, and therefore
// React Native's fetch — DROPS the Authorization header across an origin
// change. The app's bearer token vanished mid-flight and the server, seeing no
// header at all, answered 401 AUTH_REQUIRED "Authentication required". Verified
// by reproduction: same request direct returns INVALID_TOKEN (header present),
// followed through the redirect returns AUTH_REQUIRED (header gone).
//
// Exempting these is also correct on the merits: the redirect exists to stop
// two hostnames competing in Search Console, and a JSON API is not a crawler
// surface. Installed builds in the field cannot be fixed by an app release, so
// the fix belongs here.
var EXEMPT_PREFIXES = ['/api/', '/payments/', '/webhooks/'];

function isExemptPath(path) {
  if (EXEMPT_PATHS.has(path)) return true;
  for (var i = 0; i < EXEMPT_PREFIXES.length; i++) {
    if (path.indexOf(EXEMPT_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// Local dev and CI reach the app as localhost/127.0.0.1 whatever the mode.
function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host === '[::1]' || host.endsWith('.localhost');
}

function canonicalHostRedirect(opts) {
  opts = opts || {};
  var canonicalHost = String(opts.canonicalHost || process.env.CANONICAL_HOST || 'tashkheesa.com')
    .toLowerCase().replace(/:\d+$/, '');
  // Production only (MODE, the same normalised mode server.js runs on), unless
  // a test forces it: local dev and the suite would otherwise 301 to prod.
  var enabled = (typeof opts.enabled === 'boolean')
    ? opts.enabled
    : String(process.env.MODE || process.env.NODE_ENV || '') === 'production';

  return function canonicalHostRedirectMiddleware(req, res, next) {
    if (!enabled) return next();
    // GET/HEAD only. The duplicate-content problem is a crawler problem, and
    // crawlers fetch. A 301 on a POST helps no one and would break any
    // webhook (Paymob, Resend, Twilio) that was ever registered against the
    // .onrender.com address — a client that even follows a 307-less 301
    // typically re-issues it as a GET, dropping the body.
    var method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();
    if (isExemptPath(req.path)) return next();

    // req.hostname: Host (or X-Forwarded-Host under trust proxy), no port.
    var host = String(req.hostname || '').toLowerCase().replace(/:\d+$/, '');
    if (!host || host === canonicalHost || isLocalHost(host)) return next();

    // Path + query come from originalUrl, never from the Host header. A
    // request line carrying an absolute URI would make originalUrl start with
    // a scheme instead of '/': refuse to build a Location from it.
    var target = String(req.originalUrl || '/');
    if (target.charCodeAt(0) !== 47) target = '/';
    return res.redirect(301, 'https://' + canonicalHost + target);
  };
}

module.exports = {
  canonicalHostRedirect: canonicalHostRedirect,
  EXEMPT_PATHS: EXEMPT_PATHS,
  EXEMPT_PREFIXES: EXEMPT_PREFIXES,
  isExemptPath: isExemptPath,
};
