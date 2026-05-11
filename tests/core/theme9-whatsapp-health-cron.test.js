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
  if (!/'statusCode'\s*=\s*'401'|statusCode.*=\s*'401'/.test(src)) {
    throw new Error("whatsapp_health_check.js does not filter on statusCode=401 — would alert on any error.");
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
  if (!/Token 401s/.test(src)) {
    throw new Error("ops-dashboard.ejs missing 'Token 401s' card label.");
  }
  if (!/Send errors/.test(src)) {
    throw new Error("ops-dashboard.ejs missing 'Send errors' card label.");
  }
  t.pass(fileTag + ': ops-dashboard.ejs renders WhatsApp card with both counters + typeof-guard fallback');
} catch (e) {
  t.fail(fileTag + ': A4 dashboard card', e);
}
