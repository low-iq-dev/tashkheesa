'use strict';

// services/file_url_allowlist.js
//
// Part B item 2 (2026-09-13) — the stored open redirect.
//
// Three patient-facing writers accepted ANY `https?://` string as a file URL
// (routes/patient.js order upload + message attach, plus the wizard's
// initial_file_url / file_urls), stored it in order_files.url /
// messages.file_url / order_additional_files.file_url, and the unified
// /files/:id reader in server.js then answered a 302 to whatever was stored.
// A patient could attach "https://evil.example/login" to their own case and
// hand the doctor (or an operator) a link on OUR domain that bounces them to a
// phishing page — a stored open redirect, reachable by anyone with an account.
//
// The only HTTP file host the platform has ever legitimately written is the
// Uploadcare CDN (ucarecdn.com); everything newer is an R2 KEY, signed at read
// time by storage.getSignedDownloadUrl. Production was checked read-only on
// 2026-09-13: order_files.url, messages.file_url and
// order_additional_files.file_url contain NO http(s) rows at all, so a strict
// allowlist breaks nothing that exists.
//
// One predicate, used on the way IN (every writer) and on the way OUT (the
// redirect), so a row that pre-dates the writer-side check is still refused
// at the sink.

const UPLOADCARE_HOSTS = ['ucarecdn.com'];

function hostOf(url) {
  try { return String(new URL(url).hostname || '').toLowerCase(); } catch (_) { return ''; }
}

/**
 * Hosts a stored file URL may point at. Uploadcare's CDN, plus the R2 account
 * endpoint (R2_ENDPOINT) and Cloudflare's public R2 hostnames — the only
 * places this platform's files live.
 */
function allowedFileHosts() {
  const hosts = new Set(UPLOADCARE_HOSTS);
  const r2 = hostOf(process.env.R2_ENDPOINT || '');
  if (r2) hosts.add(r2);
  return hosts;
}

function hostAllowed(host) {
  if (!host) return false;
  if (allowedFileHosts().has(host)) return true;
  // Cloudflare's R2 public/S3 hostnames are per-account subdomains.
  return /\.r2\.dev$/.test(host) || /\.r2\.cloudflarestorage\.com$/.test(host);
}

/**
 * True only for an https URL whose host is one of ours. http:// is refused
 * outright (a file link must never downgrade the doctor onto plain HTTP), as
 * is anything with credentials in the authority.
 */
function isAllowedFileUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return false;
  let u;
  try { u = new URL(v); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return hostAllowed(String(u.hostname || '').toLowerCase());
}

module.exports = { isAllowedFileUrl, allowedFileHosts, hostAllowed };
