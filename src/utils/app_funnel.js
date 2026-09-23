'use strict';

// src/utils/app_funnel.js — the website → Android app install funnel.
//
// Two env vars, both OFF by default. Unset means the site renders exactly what
// it rendered before this module existed: no badge, no smart banner, and
// /.well-known/assetlinks.json answers 404.
//
//   PLAY_STORE_URL
//     The Play listing, e.g.
//       https://play.google.com/store/apps/details?id=com.tashkheesa.patient
//     Every link we render appends Play's install-referrer parameter
//     (`referrer=`, URL-encoded utm_source/utm_medium/utm_campaign) so an
//     install can be attributed to the page placement that produced it.
//
//   ANDROID_APP_SHA256_FINGERPRINTS
//     Comma-separated SHA-256 signing-cert fingerprints ("AA:BB:…", 32 bytes)
//     for Android App Links verification. Include the Play App Signing key AND
//     the upload key if links should verify on sideloaded/internal builds too.
//
// Everything here is read per call (cheap) so a test can toggle it, and every
// function is total: a malformed value degrades to "off", never to a throw on
// the render path.

var ANDROID_PACKAGE = 'com.tashkheesa.patient';
var UTM_SOURCE = 'website';
var UTM_CAMPAIGN = 'app_launch';

// The placements we render a Play link from. utm_medium is one of these, so
// the install-referrer report has a closed vocabulary instead of free text.
var PLACEMENTS = Object.freeze(['home', 'footer', 'app_landing', 'smart_banner']);

/**
 * The configured Play Store URL, or null when unset / not an https URL.
 * @returns {string|null}
 */
function playStoreUrl() {
  try {
    var raw = String(process.env.PLAY_STORE_URL || '').trim();
    if (!raw) return null;
    var u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    return raw;
  } catch (_) {
    return null;
  }
}

/**
 * The Play URL for one placement, with the install referrer appended.
 * @param {string} placement one of PLACEMENTS (anything else → 'website')
 * @returns {string|null} null when PLAY_STORE_URL is unset
 */
function playStoreLink(placement) {
  var base = playStoreUrl();
  if (!base) return null;
  try {
    var medium = PLACEMENTS.indexOf(placement) !== -1 ? placement : 'website';
    var referrer = 'utm_source=' + UTM_SOURCE +
      '&utm_medium=' + medium +
      '&utm_campaign=' + UTM_CAMPAIGN;
    // A listing URL copied with its own referrer would otherwise end up with
    // two; Play reads the first, which would be the stale one.
    var u = new URL(base);
    u.searchParams.delete('referrer');
    var stripped = u.toString();
    var sep = stripped.indexOf('?') === -1 ? '?' : '&';
    return stripped + sep + 'referrer=' + encodeURIComponent(referrer);
  } catch (_) {
    return null;
  }
}

/**
 * Express middleware: the ONE place PLAY_STORE_URL reaches the views.
 *
 * res.locals.appFunnel is null when the feature is off — every view guards on
 * its truthiness. When on, it is a fresh per-request object: the public layout
 * flips `marketing` to true on it so the shared footer partial (also used by
 * portal pages) can tell it is on a marketing page. EJS includes shallow-copy
 * locals, so a flag on this object is visible to sibling includes while a bare
 * local set inside one include is not.
 */
function appFunnelLocals() {
  return function appFunnelLocalsMiddleware(req, res, next) {
    try {
      var url = playStoreUrl();
      res.locals.appFunnel = url ? {
        playStoreUrl: url,
        link: playStoreLink,
        marketing: false,
      } : null;
    } catch (_) {
      try { res.locals.appFunnel = null; } catch (__) { /* ignore */ }
    }
    return next();
  };
}

// "AA:BB:…" — 32 colon-separated hex bytes. Anything else is dropped: Google's
// verifier rejects the WHOLE file on one malformed entry, so a typo in one
// fingerprint must not take the valid ones down with it.
var FINGERPRINT_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

/**
 * Parsed, validated fingerprints from ANDROID_APP_SHA256_FINGERPRINTS.
 * @returns {string[]}
 */
function androidFingerprints() {
  try {
    var raw = String(process.env.ANDROID_APP_SHA256_FINGERPRINTS || '');
    var seen = {};
    return raw.split(',')
      .map(function (s) { return s.trim().toUpperCase(); })
      .filter(function (s) {
        if (!FINGERPRINT_RE.test(s) || seen[s]) return false;
        seen[s] = true;
        return true;
      });
  } catch (_) {
    return [];
  }
}

/**
 * The Digital Asset Links statement list, or null when unconfigured.
 * @returns {object[]|null}
 */
function assetLinksStatements() {
  var fps = androidFingerprints();
  if (!fps.length) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: fps,
    },
  }];
}

/**
 * GET /.well-known/assetlinks.json. Mounted in server.js ahead of the
 * canonical-host redirect, staging auth, sessions, CSRF and every rate
 * limiter: Android's verifier does not follow redirects and sends no cookies.
 */
function assetLinksHandler(req, res) {
  var statements = null;
  try { statements = assetLinksStatements(); } catch (_) { statements = null; }
  if (!statements) {
    return res.status(404).type('text/plain').send('not configured');
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).type('application/json').send(JSON.stringify(statements));
}

module.exports = {
  ANDROID_PACKAGE: ANDROID_PACKAGE,
  PLACEMENTS: PLACEMENTS,
  playStoreUrl: playStoreUrl,
  playStoreLink: playStoreLink,
  appFunnelLocals: appFunnelLocals,
  androidFingerprints: androidFingerprints,
  assetLinksStatements: assetLinksStatements,
  assetLinksHandler: assetLinksHandler,
};
