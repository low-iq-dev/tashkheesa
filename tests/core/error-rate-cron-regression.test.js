// tests/core/error-rate-cron-regression.test.js
//
// Side issue #50 — regression guard for the error_rate_5x critical-alert
// cron. Pattern mirrors tests/core/theme9-whatsapp-health-cron.test.js
// (Theme 9 Sub-issue A). File-content greps only — no DB or runtime.
//
// Invariants:
//   A1: src/jobs/error_rate_check.js exists, exports checkErrorRate,
//       runs the baseline-vs-current query against error_logs (7-day
//       hourly baseline + current-hour count), enforces the dual
//       threshold (>=5x baseline AND >=5 absolute), and calls
//       sendCriticalAlert with alertKey='error_rate_5x'.
//   A2: src/server.js registers the cron via node-cron at every-15min,
//       inside the primary-mode block (mirrors the whatsapp_health
//       and appointment_reminders patterns), and logs registration on
//       boot.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📊 Side issue #50 — error_rate_5x critical-alert cron\n');

const ROOT = path.join(__dirname, '..', '..');
const CRON_JOB = path.join(ROOT, 'src', 'jobs', 'error_rate_check.js');
const SERVER   = path.join(ROOT, 'src', 'server.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// ── A1: cron job module exists with the right shape ──────────────────────────
try {
  if (!fs.existsSync(CRON_JOB)) throw new Error('src/jobs/error_rate_check.js does not exist.');
  const src = read(CRON_JOB);

  if (!/exports\.checkErrorRate|module\.exports\s*=\s*\{[^}]*checkErrorRate/.test(src)) {
    throw new Error('error_rate_check.js does not export checkErrorRate.');
  }
  if (!/FROM\s+error_logs/i.test(src)) {
    throw new Error('error_rate_check.js does not query error_logs.');
  }
  if (!/INTERVAL\s*'7 days'/.test(src)) {
    throw new Error('error_rate_check.js does not use the 7-day baseline window.');
  }
  if (!/date_trunc\('hour'/i.test(src)) {
    throw new Error('error_rate_check.js does not group by hour for the baseline — would compare apples-to-oranges.');
  }
  // Dual threshold: ratio (>=5x baseline) AND absolute (>=5). Both required.
  if (!/5\s*\*\s*baseline/.test(src)) {
    throw new Error('error_rate_check.js does not enforce the 5x-baseline ratio threshold.');
  }
  if (!/>=\s*5\b/.test(src)) {
    throw new Error('error_rate_check.js does not enforce the >=5 absolute-floor threshold.');
  }
  if (!/sendCriticalAlert\s*\(/.test(src)) {
    throw new Error('error_rate_check.js does not call sendCriticalAlert — alert path is broken.');
  }
  if (!/'error_rate_5x'/.test(src)) {
    throw new Error("error_rate_check.js does not pass alertKey='error_rate_5x' — Phase 7 throttle key + ops correlation lost.");
  }
  t.pass(fileTag + ': error_rate_check.js exports checkErrorRate + 7-day hourly baseline + dual threshold (5x AND >=5) + sendCriticalAlert("error_rate_5x")');
} catch (e) {
  t.fail(fileTag + ': A1 cron-job shape', e);
}

// ── A2: server.js registers the cron in the primary-mode block ───────────────
try {
  const src = read(SERVER);
  if (!/error_rate_check/.test(src)) {
    throw new Error('src/server.js does not require ./jobs/error_rate_check — cron will never run.');
  }
  if (!/checkErrorRate\s*\(\s*\)/.test(src) && !/checkErrorRate\s*\)/.test(src)) {
    throw new Error('src/server.js does not invoke checkErrorRate in a cron handler.');
  }
  const idx = src.indexOf('error_rate_check');
  const window = src.slice(Math.max(0, idx - 400), Math.min(src.length, idx + 400));
  if (!/'\*\/15 \* \* \* \*'/.test(window)) {
    throw new Error('src/server.js does not schedule error_rate_check at every-15-min cadence.');
  }
  if (!/Error-rate 5x cron registered/.test(src)) {
    throw new Error("src/server.js does not log 'Error-rate 5x cron registered' on boot — ops loses the boot signal.");
  }
  t.pass(fileTag + ': server.js registers checkErrorRate at */15 * * * * with boot log');
} catch (e) {
  t.fail(fileTag + ': A2 cron registration', e);
}
