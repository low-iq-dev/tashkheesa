'use strict';
// Perf 2026-10-15 — content-hashed asset URLs.
//
// The static mounts in server.js could only cache for 1h because asset URLs
// carried no version: a year-long cache would pin a stale stylesheet across
// deploys. asset('/site/css/styles.css') returns
// '/site/css/styles.css?v=<8 hex of the file's md5>', so the URL changes
// exactly when the bytes change. Requests that carry ?v= are then served with
// a 1-year immutable Cache-Control (see versionedCacheHeaders); unversioned
// URLs keep the old 1h policy, so nothing that still links the bare path
// (emails, old cached HTML, the apps) changes behaviour.
//
// Hashes are computed once per file per process (a deploy is a new process).
// An unknown or unreadable path returns the URL unchanged — never throws, so a
// typo in a template can't take a page down.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// URL prefix → directory on disk. Mirrors the express.static mounts in
// server.js. Order matters: first match wins.
const MOUNTS = [
  ['/site/', PUBLIC_DIR],
  ['/assets/', path.join(PUBLIC_DIR, 'assets')],
  ['/js/', path.join(PUBLIC_DIR, 'js')],
  ['/css/', path.join(PUBLIC_DIR, 'css')],
  ['/vendor/', path.join(PUBLIC_DIR, 'vendor')],
];
const SINGLE_FILES = {
  '/styles.css': path.join(PUBLIC_DIR, 'styles.css'),
};

const cache = new Map();

function resolveFile(url) {
  if (Object.prototype.hasOwnProperty.call(SINGLE_FILES, url)) return SINGLE_FILES[url];
  for (const [prefix, dir] of MOUNTS) {
    if (url.startsWith(prefix)) {
      const rel = url.slice(prefix.length);
      const full = path.normalize(path.join(dir, rel));
      // No escaping the mount via ../
      if (!full.startsWith(dir + path.sep)) return null;
      return full;
    }
  }
  return null;
}

function asset(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.includes('?')) return url;
  if (cache.has(url)) return cache.get(url);
  let out = url;
  const file = resolveFile(url);
  if (file) {
    try {
      const hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
      out = `${url}?v=${hash}`;
    } catch (_) {
      out = url;
    }
  }
  cache.set(url, out);
  return out;
}

const ONE_YEAR = 'public, max-age=31536000, immutable';

// express.static setHeaders hook. `send` emits 'headers' (which calls this)
// BEFORE it applies maxAge, and only sets Cache-Control if none is set yet —
// so a header set here wins.
function versionedCacheHeaders(res) {
  const req = res.req;
  if (req && req.query && typeof req.query.v === 'string' && req.query.v) {
    res.setHeader('Cache-Control', ONE_YEAR);
  }
}

function _resetForTests() { cache.clear(); }

module.exports = { asset, versionedCacheHeaders, ONE_YEAR, _resetForTests };
