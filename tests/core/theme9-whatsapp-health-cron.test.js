// tests/core/theme9-whatsapp-health-cron.test.js
//
// Theme 9 Sub-issue A — regression guard for the WhatsApp 401-detector
// alerting plumbing.
//
// Invariants:
//   A1: src/jobs/whatsapp_health_check.js exists, exports
//       checkWhatsAppHealth, queries error_logs for category='whatsapp_send'
//       + statusCode=401 in the last 15min, and calls sendCriticalAlert
//       when the count is > 0.
//   A2: src/server.js registers the cron via node-cron at every-15min,
//       inside the primary-mode block (mirrors the appointment-reminder
//       pattern).
//   A3: src/routes/ops.js builds whatsappHealth { token401Last15min,
//       sendErrorsLast24h } and threads it through the render context.
//   A4: src/views/ops-dashboard.ejs renders the WhatsApp card with both
//       counters and an `_wa` defensive fallback if the local is missing.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📡 Theme 9 Sub-issue A — WhatsApp 401 detector cron + ops health card\n');

const ROOT = path.join(__dirname, '..', '..');
const CRON_JOB = path.join(ROOT, 'src', 'jobs', 'whatsapp_health_check.js');
const SERVER   = path.join(ROOT, 'src', 'server.js');
const OPS      = path.join(ROOT, 'src', 'routes', 'ops.js');
const DASH     = path.join(ROOT, 'src', 'views', 'ops-dashboard.ejs');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// ── A1: cron job module exists with the right shape ──────────────────────────
try {
  if (!fs.existsSync(CRON_JOB)) throw new Error('src/jobs/whatsapp_health_check.js does not exist.');
  const src = read(CRON_JOB);
  if (!/exports\.checkWhatsAppHealth|module\.exports\s*=\s*\{[^}]*checkWhatsAppHealth/.test(src)) {
    throw new Error('whatsapp_health_check.js does not export checkWhatsAppHealth.');
  }
  if (!/category\s*=\s*'whatsapp_send'/.test(src)) {
    throw new Error("whatsapp_health_check.js does not filter on category='whatsapp_send'.");
  }
  if (!/INTERVAL\s*'15 minutes'/.test(src)) {
    throw new Error("whatsapp_health_check.js does not use the 15-minute window — must match the cron cadence.");
  }
  // STALE-TEST FIX (2026-08-16) — READ THIS BEFORE "FIXING" IT BACK.
  //
  // This used to demand a filter on context->>'statusCode'. That key is one
  // the WhatsApp senders never write: notify/whatsapp.js and
  // lib/openclaw_client.js both record the HTTP status under 'status'. The
  // ONLY module that writes 'statusCode' is critical-alert.js — so a detector
  // filtering on 'statusCode' could see nothing but its own alerting failures.
  // When WHATSAPP_ACCESS_TOKEN expired, every send 401'd, this cron counted 0,
  // no alert fired, and WhatsApp was silently dead. That was the actual
  // outage-invisibility bug (AUDIT-P1-4), and this assertion was pinning it.
  //
  // Restoring 'statusCode' here would reintroduce it. Assert the correct key,
  // and fail loudly if the wrong one ever comes back.
  if (!/'status'\s*=\s*'401'/.test(src)) {
    throw new Error("whatsapp_health_check.js does not filter on context->>'status' = '401' — the key the WhatsApp senders actually write.");
  }
  if (/'statusCode'/.test(src.replace(/\/\/[^\n]*/g, ''))) {
    throw new Error("whatsapp_health_check.js filters on 'statusCode' again — no WhatsApp sender writes that key, so the detector would only ever see critical-alert.js's own failures (AUDIT-P1-4).");
  }
  if (!/sendCriticalAlert\s*\(/.test(src)) {
    throw new Error('whatsapp_health_check.js does not call sendCriticalAlert — alert path is broken.');
  }
  t.pass(fileTag + ': whatsapp_health_check.js exports checkWhatsAppHealth + queries 15-min/401/whatsapp_send + fires sendCriticalAlert');
} catch (e) {
  t.fail(fileTag + ': A1 cron-job shape', e);
}

// ── A2: server.js registers the cron in the primary-mode block ───────────────
try {
  const src = read(SERVER);
  if (!/whatsapp_health_check/.test(src)) {
    throw new Error('src/server.js does not require ./jobs/whatsapp_health_check — cron will never run.');
  }
  if (!/checkWhatsAppHealth\s*\(\s*\)/.test(src) && !/checkWhatsAppHealth\s*\)/.test(src)) {
    throw new Error('src/server.js does not invoke checkWhatsAppHealth in a cron handler.');
  }
  // Must be every-15-min cadence — same as appointment-reminders pattern.
  // We assert by locating the require near a '*/15 * * * *' schedule.
  const idx = src.indexOf('whatsapp_health_check');
  const window = src.slice(Math.max(0, idx - 400), Math.min(src.length, idx + 400));
  if (!/'\*\/15 \* \* \* \*'/.test(window)) {
    throw new Error('src/server.js does not schedule whatsapp_health_check at every-15-min cadence.');
  }
  if (!/WhatsApp 401-detector cron registered/.test(src)) {
    throw new Error("src/server.js does not log 'WhatsApp 401-detector cron registered' on boot — ops loses the boot signal.");
  }
  t.pass(fileTag + ': server.js registers checkWhatsAppHealth at */15 * * * * with boot log');
} catch (e) {
  t.fail(fileTag + ': A2 cron registration', e);
}

// ── A3: ops.js builds whatsappHealth ─────────────────────────────────────────
try {
  const src = read(OPS);
  if (!/var\s+whatsappHealth\s*=/.test(src)) {
    throw new Error('src/routes/ops.js does not build a whatsappHealth object.');
  }
  if (!/token401Last15min/.test(src)) {
    throw new Error('ops.js whatsappHealth missing token401Last15min field — dashboard card has nothing to render.');
  }
  if (!/sendErrorsLast24h/.test(src)) {
    throw new Error('ops.js whatsappHealth missing sendErrorsLast24h field.');
  }
  if (!/whatsappHealth:\s*whatsappHealth/.test(src)) {
    throw new Error('ops.js does not thread whatsappHealth into the render context.');
  }
  t.pass(fileTag + ': ops.js builds whatsappHealth { token401Last15min, sendErrorsLast24h } + threads into render context');
} catch (e) {
  t.fail(fileTag + ': A3 ops route data', e);
}

// ── A4: dashboard renders the WhatsApp card with both counters ───────────────
try {
  const src = read(DASH);
  if (!/whatsappHealth/.test(src)) {
    throw new Error("ops-dashboard.ejs does not reference whatsappHealth — card not wired.");
  }
  if (!/typeof whatsappHealth !== 'undefined'/.test(src)) {
    throw new Error('ops-dashboard.ejs does not defensively typeof-guard whatsappHealth — render path can ReferenceError.');
  }
  // STALE-TEST FIX (2026-08-16): this asserted the literal label copy
  // 'Token 401s' / 'Send errors'. The card was later restyled and the labels
  // shortened to 'WA 401s (15m)' / 'WA errors (24h)' to fit the pill row. The
  // card, the counters and the typeof-guard are all intact — only the display
  // string changed. Assert the DATA BINDINGS, which are the real contract
  // between the ops route and the view, instead of the copy, which is not.
  if (!/whatsappHealth\.token401Last15min/.test(src)) {
    throw new Error("ops-dashboard.ejs does not render whatsappHealth.token401Last15min — the 401 counter is not on the dashboard.");
  }
  if (!/whatsappHealth\.sendErrorsLast24h/.test(src)) {
    throw new Error("ops-dashboard.ejs does not render whatsappHealth.sendErrorsLast24h — the send-error counter is not on the dashboard.");
  }
  if (!/401/.test(src)) {
    throw new Error('ops-dashboard.ejs has no 401 label at all next to the counter — the number would be unreadable.');
  }
  t.pass(fileTag + ': ops-dashboard.ejs renders WhatsApp card with both counters + typeof-guard fallback');
} catch (e) {
  t.fail(fileTag + ': A4 dashboard card', e);
}
