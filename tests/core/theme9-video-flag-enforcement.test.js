// tests/core/theme9-video-flag-enforcement.test.js
//
// Theme 9 Sub-issue C — regression guard for the VIDEO_CONSULTATION_ENABLED
// kill switch. Audit T4 calls for surgical per-route gates (OQ-5 confirmed).
//
// Invariants this test protects:
//
//   C1 (per-call read):    isVideoEnabled() reads
//                          process.env.VIDEO_CONSULTATION_ENABLED inside the
//                          function body. An ops kill-switch flip on Render
//                          must take effect on the next request, not the
//                          next deploy.
//
//   C2 (book gate):        POST /portal/video/book returns 503 when the
//                          flag is off, before any DB work.
//
//   C3 (pay gate):         GET /portal/video/pay/:appointmentId redirects
//                          to a dashboard message instead of rendering the
//                          checkout page.
//
//   C4 (webhook gate):     POST /portal/video/payment/callback ACKs Paymob
//                          (200) but fires a critical alert with the
//                          payment_id so ops issues a manual refund.
//                          Returning 503 would cause Paymob to retry
//                          forever and would not address the refund
//                          obligation.
//
//   C5 (addon gate):       The payments.js addon-video-consultation branch
//                          skips the addon work when the flag is off — the
//                          underlying case payment still proceeds.
//
// Source-grep style: each invariant is one or more regex assertions over
// the relevant file. Behavioral supertest coverage would require a full
// Express boot inside the test process, which the rest of tests/core/
// avoids — keeping consistent with the existing lint-style pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📹 Theme 9 Sub-issue C — VIDEO_CONSULTATION_ENABLED kill switch on /portal/video/*\n');

const ROOT = path.join(__dirname, '..', '..');
const VIDEO_HELPERS = path.join(ROOT, 'src', 'video_helpers.js');
const ROUTE_VIDEO   = path.join(ROOT, 'src', 'routes', 'video.js');
const ROUTE_PAY     = path.join(ROOT, 'src', 'routes', 'payments.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(p) { return stripComments(fs.readFileSync(p, 'utf8')); }

// ── C1: isVideoEnabled() reads env per call ──────────────────────────────────
try {
  const src = read(VIDEO_HELPERS);
  // Must not have a top-level `const VIDEO_ENABLED = String(process.env.VIDEO_CONSULTATION_ENABLED ...)`
  // pattern. Allow the env to be read inside the function body.
  const firstFnIdx = src.indexOf('function isVideoEnabled');
  if (firstFnIdx < 0) throw new Error('function isVideoEnabled() not found in src/video_helpers.js');
  const prelude = src.slice(0, firstFnIdx);
  if (/process\.env\.VIDEO_CONSULTATION_ENABLED/.test(prelude)) {
    throw new Error('src/video_helpers.js captures VIDEO_CONSULTATION_ENABLED at module load — flag flip will be ignored until next deploy. Move the read into isVideoEnabled().');
  }
  if (!/isVideoEnabled\s*\(\s*\)\s*\{[\s\S]*?process\.env\.VIDEO_CONSULTATION_ENABLED/.test(src)) {
    throw new Error('isVideoEnabled() does not read process.env.VIDEO_CONSULTATION_ENABLED inside its body.');
  }
  t.pass(fileTag + ': isVideoEnabled() reads VIDEO_CONSULTATION_ENABLED per call (C1)');
} catch (e) {
  t.fail(fileTag + ': C1 per-call env read', e);
}

// ── C2/C3/C4: video.js route gates ───────────────────────────────────────────
try {
  const src = read(ROUTE_VIDEO);

  // Helper: locate the body of a route handler matching `router.<method>('<path>'`.
  // Works for routes with or without middleware between the URL and the handler.
  function routeBody(method, urlPattern) {
    const decl = new RegExp("router\\." + method + "\\(['\"]" + urlPattern + "['\"]", "");
    const declMatch = decl.exec(src);
    if (!declMatch) return null;
    // From the URL, find the next `async ( ... ) => {` arrow function start.
    const arrowRe = /async\s*\([^)]*\)\s*=>\s*\{/g;
    arrowRe.lastIndex = declMatch.index;
    const arrowMatch = arrowRe.exec(src);
    if (!arrowMatch) return null;
    // Walk forward, counting braces, until balanced.
    let depth = 1;
    let i = arrowMatch.index + arrowMatch[0].length;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    return src.slice(declMatch.index, i);
  }

  // C2 — POST /portal/video/book
  const bookBody = routeBody('post', '/portal/video/book');
  if (!bookBody) throw new Error('POST /portal/video/book handler not found');
  if (!/isVideoEnabled\s*\(\s*\)/.test(bookBody)) {
    throw new Error('POST /portal/video/book does not call isVideoEnabled() — booking is unguarded.');
  }
  if (!/status\(503\)/.test(bookBody)) {
    throw new Error('POST /portal/video/book does not return 503 on disabled — gate returns the wrong status.');
  }
  if (!/video_disabled/.test(bookBody)) {
    throw new Error("POST /portal/video/book does not include 'video_disabled' in the disabled response — clients can't disambiguate from other 503s.");
  }
  t.pass(fileTag + ': POST /portal/video/book returns 503 video_disabled when isVideoEnabled() is false (C2)');

  // C3 — GET /portal/video/pay
  const payBody = routeBody('get', '/portal/video/pay/:appointmentId');
  if (!payBody) throw new Error('GET /portal/video/pay/:appointmentId handler not found');
  if (!/isVideoEnabled\s*\(\s*\)/.test(payBody)) {
    throw new Error('GET /portal/video/pay/:appointmentId does not call isVideoEnabled() — pay surface is unguarded.');
  }
  if (!/res\.redirect\(['"][^'"]*video_unavailable/.test(payBody)) {
    throw new Error('GET /portal/video/pay/:appointmentId does not redirect to ?msg=video_unavailable on disabled.');
  }
  t.pass(fileTag + ': GET /portal/video/pay/:appointmentId redirects to dashboard with msg=video_unavailable when disabled (C3)');

  // C4 — POST /portal/video/payment/callback
  const cbBody = routeBody('post', '/portal/video/payment/callback');
  if (!cbBody) throw new Error('POST /portal/video/payment/callback handler not found');
  if (!/isVideoEnabled\s*\(\s*\)/.test(cbBody)) {
    throw new Error('POST /portal/video/payment/callback does not call isVideoEnabled() — webhook is unguarded.');
  }
  if (!/sendCriticalAlert\s*\(/.test(cbBody)) {
    throw new Error('POST /portal/video/payment/callback does not call sendCriticalAlert() on disabled — manual-refund signal will not reach ops.');
  }
  if (!/video_disabled_manual_refund_required/.test(cbBody)) {
    throw new Error('POST /portal/video/payment/callback does not return the video_disabled_manual_refund_required note on disabled.');
  }
  // The ACK must be a 200, not 503 — Paymob retries 5xx.
  if (/status\(503\)[\s\S]*?video_disabled/.test(cbBody) && !/res\.json\(\{[^}]*video_disabled_manual_refund_required/.test(cbBody)) {
    throw new Error('POST /portal/video/payment/callback returns 503 on disabled — Paymob will retry forever. Must ACK 200 + alert.');
  }
  t.pass(fileTag + ': POST /portal/video/payment/callback ACKs 200 + sendCriticalAlert + manual-refund note when disabled (C4)');
} catch (e) {
  t.fail(fileTag + ': C2/C3/C4 video.js gates', e);
}

// ── C5: payments.js addon-video-consultation gate ────────────────────────────
try {
  const src = read(ROUTE_PAY);
  // The addon branch must check isVideoEnabled() and log a skip event when the flag is off.
  if (!/addon_video_consultation/.test(src)) {
    throw new Error('src/routes/payments.js no longer references addon_video_consultation — has the addon branch been removed?');
  }
  if (!/isVideoEnabled\s*\(\s*\)/.test(src)) {
    throw new Error('src/routes/payments.js does not call isVideoEnabled() — addon branch is unguarded.');
  }
  if (!/video_consultation_addon_skipped_feature_disabled/.test(src)) {
    throw new Error("src/routes/payments.js does not log 'video_consultation_addon_skipped_feature_disabled' — ops loses the audit trail for skipped addon charges.");
  }
  t.pass(fileTag + ': payments.js addon-video-consultation branch skips when isVideoEnabled() is false + logs the skip (C5)');
} catch (e) {
  t.fail(fileTag + ': C5 payments.js addon gate', e);
}
