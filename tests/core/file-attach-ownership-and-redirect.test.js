// tests/core/file-attach-ownership-and-redirect.test.js
//
// Part B item 2 (2026-09-13) — file-attach ownership + the stored open redirect.
//
// Three writers checked only the SHAPE of an R2 key (orders/draft/<id>/<file>
// or messages-attach/<id>/<file>) and never that <id> was the caller:
//   * routes/api/cases.js  POST /cases   (fileId; uploadcareUuid was any string)
//   * routes/patient.js    POST /portal/patient/orders/:id/upload   (file_key)
//   * routes/patient.js    POST /portal/patient/orders/:id/messages (file_key)
// so a patient could attach any other patient's upload to their own case by
// naming its key. cases_draft.js already carried the one-line owner check;
// it is now on all three.
//
// Separately, patient.js accepted any `https?://` string as file_url and
// server.js /files/:id 302'd to whatever was stored — a stored open redirect
// on our own domain. services/file_url_allowlist.js is now enforced at every
// writer AND at the sink.
//
// Unit (the allowlist predicate) + source-grep (the call sites). Verified
// NEGATIVELY: removing the owner check from api/cases.js fails its assertion;
// restoring `/^https?:\/\//` at the upload site fails that one.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');
const { isAllowedFileUrl } = require('../../src/services/file_url_allowlist');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n📎 Part B-2 — file-attach ownership + stored open redirect\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
function handler(src, anchor) {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const after = src.slice(start + anchor.length);
  const next = after.search(/\nrouter\.(post|get|put|delete)\(/);
  return next > 0 ? after.slice(0, next) : after;
}

const CASES = code('src/routes/api/cases.js');
const PATIENT = code('src/routes/patient.js');
const SERVER = code('src/server.js');

// ── the predicate ──────────────────────────────────────────────────────────
check('allowlist: accepts the Uploadcare CDN and Cloudflare R2 hosts over https', () => {
  const ok = ['https://ucarecdn.com/0f1e2d3c/', 'https://pub-abc.r2.dev/k', 'https://acct.r2.cloudflarestorage.com/b/k'];
  const bad = ok.filter((u) => !isAllowedFileUrl(u));
  if (bad.length) return 'refused: ' + bad.join(', ');
});
check('allowlist: refuses foreign hosts, http, credentials-in-authority and lookalike domains', () => {
  const bad = [
    'https://evil.example/login', 'http://ucarecdn.com/x', 'https://u:p@ucarecdn.com/x',
    'https://ucarecdn.com@evil.example/', 'https://ucarecdn.com.evil.example/x',
    'javascript:alert(1)', '', 'orders/draft/p1/file.png'
  ];
  const passed = bad.filter((u) => isAllowedFileUrl(u));
  if (passed.length) return 'accepted: ' + passed.join(', ');
});
check('allowlist: honours the configured R2_ENDPOINT host', () => {
  const prev = process.env.R2_ENDPOINT;
  process.env.R2_ENDPOINT = 'https://deadbeef.r2.cloudflarestorage.com';
  try {
    if (!isAllowedFileUrl('https://deadbeef.r2.cloudflarestorage.com/bucket/k')) return 'R2_ENDPOINT host refused';
  } finally {
    if (prev === undefined) delete process.env.R2_ENDPOINT; else process.env.R2_ENDPOINT = prev;
  }
});

// ── api/cases.js ───────────────────────────────────────────────────────────
check('api/cases.js POST /cases pins fileId to the caller\'s own draft folder', () => {
  if (!/String\(f\.fileId\)\.trim\(\)\.split\('\/'\)\[2\]\s*!==\s*String\(req\.user\.id\)/.test(CASES)) return 'no owner check on fileId';
});
check('api/cases.js POST /cases validates uploadcareUuid as a UUID', () => {
  if (!/hasUuid\s*&&\s*!\/\^\[0-9a-fA-F\]\{8\}-/.test(CASES)) return 'uploadcareUuid is still any string';
});

// ── patient.js upload ──────────────────────────────────────────────────────
check('patient upload: R2 keys must be in the caller\'s own folder', () => {
  const h = handler(PATIENT, "router.post('/portal/patient/orders/:id/upload'");
  if (!h) return 'handler not found';
  if (!/\.filter\(\(k\) => k\.split\('\/'\)\[2\] === String\(patientId\)\)/.test(h)) return 'no owner check on file_key';
});
check('patient upload: URLs go through the host allowlist, not /^https?:\\/\\//', () => {
  const h = handler(PATIENT, "router.post('/portal/patient/orders/:id/upload'");
  if (/\.filter\(\(u\) => \/\^https\?:\\\/\\\/\/i\.test\(u\)\)/.test(h)) return 'still accepts any http(s) URL';
  if (!/\.filter\(\(u\) => isAllowedFileUrl\(u\)\)/.test(h)) return 'allowlist not applied';
});

// ── patient.js message attach ──────────────────────────────────────────────
check('patient message attach: file_key must be in the caller\'s own messages-attach folder', () => {
  const h = handler(PATIENT, "router.post('/portal/patient/orders/:id/messages'");
  if (!h) return 'handler not found';
  if (!/fileKey\.split\('\/'\)\[1\]\s*!==\s*String\(patientId\)/.test(h)) return 'no owner check on file_key';
});
check('patient message attach: file_url must be on an allowlisted host', () => {
  const h = handler(PATIENT, "router.post('/portal/patient/orders/:id/messages'");
  if (!/if \(fileUrl && !isAllowedFileUrl\(fileUrl\)\)/.test(h)) return 'allowlist not applied to file_url';
  if (/fileUrl && \/\^https\?:\\\/\\\/\/i\.test\(fileUrl\)/.test(h)) return 'still branches on any http(s) URL';
});

// ── patient.js legacy wizard submits ───────────────────────────────────────
check('legacy wizard submits: file_urls and initial_file_url are filtered by the allowlist / own folder', () => {
  const n = (PATIENT.match(/isAllowedFileUrl\(/g) || []).length;
  if (n < 4) return 'expected the allowlist at ≥4 patient.js sites, found ' + n;
  if (!/hasInitialUpload = Boolean\(primaryUrl\) && \(/.test(PATIENT)) return 'initial_file_url not gated';
});

// ── the sink ───────────────────────────────────────────────────────────────
check('server.js /files/:id refuses to 302 to a non-allowlisted host', () => {
  const i = SERVER.indexOf('if (fileUrl && isHttpUrl(fileUrl)) {');
  if (i < 0) return 'redirect branch not found';
  const branch = SERVER.slice(i, i + 900);
  const refuse = branch.indexOf('if (!isAllowedFileUrl(fileUrl))');
  const redirect = branch.indexOf('res.redirect(302, fileUrl)');
  if (refuse < 0) return 'no allowlist check before the redirect';
  if (redirect < refuse) return 'the redirect comes before the allowlist check';
  if (!/status\(404\)/.test(branch.slice(refuse, redirect))) return 'refusal is not a 404';
});
