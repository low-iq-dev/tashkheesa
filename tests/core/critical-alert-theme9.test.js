// tests/core/critical-alert-theme9.test.js
//
// Theme 9 Sub-issue B regression guard for src/critical-alert.js.
//
// Three invariants this test protects:
//
//   T2 (template body):     sendCriticalAlert posts `type: 'template'` to
//                           Meta, not the free-form `type: 'text'` form
//                           that Meta silently drops outside the 24h
//                           customer-service window with error code 131047.
//
//   T3 (env rotation):      sendCriticalAlert reads ADMIN_PHONE /
//                           WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN
//                           / CRITICAL_ALERT_TEMPLATE_NAME inside the
//                           function body (not via a top-level
//                           `var X = process.env.X` capture). A Render env
//                           rotation must take effect on the next call,
//                           not the next deploy.
//
//   OQ-7 (API version):     the `v22.0` literal is gone from critical-alert
//                           and notify/whatsapp; both import apiVersion()
//                           from src/config/whatsapp.js.
//
// Forensic context: prior to Theme 9-B, sendCriticalAlert used
// `type:'text'` + module-load env reads. After a 24h-window expiry, every
// admin alert was silently rejected by Meta (code 131047). After a token
// rotation, the in-process module continued sending with the stale token
// until the next deploy. Both regressions had silent symptoms — Meta
// returned 4xx, the catch logged to console, and no one was paged.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📞 Theme 9 Sub-issue B — critical-alert template body + env rotation + API version unification\n');

const ROOT = path.join(__dirname, '..', '..');
const CRITICAL_ALERT  = path.join(ROOT, 'src', 'critical-alert.js');
const NOTIFY_WHATSAPP = path.join(ROOT, 'src', 'notify', 'whatsapp.js');
const CONFIG_WHATSAPP = path.join(ROOT, 'src', 'config', 'whatsapp.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Strip line + block comments so the regexes below don't match doc-strings
// that mention the legacy payload by name.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (preserve "://")
}

// ── T2: template body shape ──────────────────────────────────────────────────
try {
  const src = stripComments(read(CRITICAL_ALERT));
  if (!/type:\s*['"]template['"]/.test(src)) {
    throw new Error("src/critical-alert.js no longer posts type:'template' in the Meta payload — Meta will reject outside the 24h window.");
  }
  // Specifically catch the legacy free-form-text body shape: type:'text', text:{...}
  if (/type:\s*['"]text['"]\s*,\s*text\s*:\s*\{/.test(src)) {
    throw new Error("src/critical-alert.js still emits the legacy type:'text', text:{body:...} payload — must be a template payload.");
  }
  if (!/CRITICAL_ALERT_TEMPLATE_NAME/.test(src)) {
    throw new Error("src/critical-alert.js does not read CRITICAL_ALERT_TEMPLATE_NAME — template selection is hardcoded.");
  }
  if (!/template_not_configured/.test(src)) {
    throw new Error("src/critical-alert.js missing the template_not_configured skip path — would call Meta with an empty template name.");
  }
  t.pass(fileTag + ": critical-alert posts type:'template' with env-driven CRITICAL_ALERT_TEMPLATE_NAME + has skip-when-unset path");
} catch (e) {
  t.fail(fileTag + ': T2 template-body invariant', e);
}

// ── T3: envs read inside sendCriticalAlert, not at module load ───────────────
try {
  const src = stripComments(read(CRITICAL_ALERT));

  // The legacy pattern was:
  //   var ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(...)
  //   var WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim()
  // ...at module top level. Detect: any `var X = (process.env.WHATSAPP_*` outside a function.

  // Crude but effective: split on `function ` boundaries; the prelude (before
  // the first `function`) must not capture these env reads.
  const firstFunctionIdx = src.indexOf('function ');
  const prelude = firstFunctionIdx >= 0 ? src.slice(0, firstFunctionIdx) : src;
  const leaked = /process\.env\.(ADMIN_PHONE|WHATSAPP_PHONE_NUMBER_ID|WHATSAPP_ACCESS_TOKEN|CRITICAL_ALERT_TEMPLATE_NAME|CRITICAL_ALERT_TEMPLATE_LANG)/.test(prelude);
  if (leaked) {
    throw new Error('src/critical-alert.js still captures an env at module load (top of file, before any function). Env rotation will be ignored until next deploy. Move reads inside sendCriticalAlert().');
  }

  // Positive assertion: the function body itself must read each env.
  if (!/process\.env\.ADMIN_PHONE/.test(src)) {
    throw new Error('src/critical-alert.js does not reference process.env.ADMIN_PHONE — must read inside the function body.');
  }
  if (!/process\.env\.WHATSAPP_ACCESS_TOKEN/.test(src)) {
    throw new Error('src/critical-alert.js does not reference process.env.WHATSAPP_ACCESS_TOKEN — must read inside the function body.');
  }
  t.pass(fileTag + ': critical-alert reads ADMIN_PHONE / WHATSAPP_* / CRITICAL_ALERT_TEMPLATE_* per call, not at module load');
} catch (e) {
  t.fail(fileTag + ': T3 env-rotation invariant', e);
}

// ── OQ-7: WHATSAPP_API_VERSION centralised in src/config/whatsapp.js ─────────
try {
  // 1. The config module exists and exports apiVersion.
  const cfg = read(CONFIG_WHATSAPP);
  if (!/function\s+apiVersion\s*\(/.test(cfg)) {
    throw new Error('src/config/whatsapp.js does not export an apiVersion() resolver.');
  }
  if (!/module\.exports\s*=\s*\{[^}]*apiVersion/.test(cfg)) {
    throw new Error('src/config/whatsapp.js does not export apiVersion in module.exports.');
  }

  // 2. critical-alert imports apiVersion and does NOT hardcode v22.0.
  const ca = stripComments(read(CRITICAL_ALERT));
  if (!/require\(['"]\.\/config\/whatsapp['"]\)/.test(ca)) {
    throw new Error("src/critical-alert.js does not require('./config/whatsapp').");
  }
  if (/['"]v22\.0['"]/.test(ca)) {
    throw new Error("src/critical-alert.js still hardcodes 'v22.0' — must use apiVersion() from config/whatsapp.");
  }
  if (!/apiVersion\s*\(\s*\)/.test(ca)) {
    throw new Error('src/critical-alert.js does not invoke apiVersion() — the import is dead code.');
  }

  // 3. notify/whatsapp imports apiVersion and does NOT hardcode v22.0.
  const nw = stripComments(read(NOTIFY_WHATSAPP));
  if (!/require\(['"]\.\.\/config\/whatsapp['"]\)/.test(nw)) {
    throw new Error("src/notify/whatsapp.js does not require('../config/whatsapp').");
  }
  if (/['"]v22\.0['"]/.test(nw)) {
    throw new Error("src/notify/whatsapp.js still hardcodes 'v22.0' — must use apiVersion() from config/whatsapp.");
  }

  t.pass(fileTag + ': WHATSAPP_API_VERSION centralised in src/config/whatsapp.js — both critical-alert and notify/whatsapp consume it');
} catch (e) {
  t.fail(fileTag + ': OQ-7 API-version unification', e);
}

// ── Sanity: the Theme 8 Phase 7 DB throttle is preserved ─────────────────────
try {
  const src = read(CRITICAL_ALERT);
  if (!/critical_alert_log/.test(src)) {
    throw new Error('src/critical-alert.js no longer references critical_alert_log — Theme 8 Phase 7 DB throttle has been regressed.');
  }
  if (!/_shouldSend/.test(src)) {
    throw new Error('src/critical-alert.js no longer has the per-key DB throttle (_shouldSend) — regression.');
  }
  if (!/_logCriticalAlertAttempt/.test(src)) {
    throw new Error('src/critical-alert.js no longer logs to critical_alert_log (_logCriticalAlertAttempt) — regression.');
  }
  t.pass(fileTag + ': Theme 8 Phase 7 DB throttle + critical_alert_log writes preserved');
} catch (e) {
  t.fail(fileTag + ': Theme 8 Phase 7 DB-throttle preservation', e);
}

// ── Sub-issue A bridge: failures also write to error_logs.category=whatsapp_send ──
try {
  const src = read(CRITICAL_ALERT);
  if (!/_logToErrorLogs/.test(src)) {
    throw new Error('src/critical-alert.js does not bridge failures to error_logs — Sub-issue A WA-401 cron will not see them.');
  }
  if (!/whatsapp_send/.test(src)) {
    throw new Error("src/critical-alert.js does not tag error_logs failures with category='whatsapp_send' — Sub-issue A cron filters on that category.");
  }
  t.pass(fileTag + ": critical-alert bridges failures to error_logs.category='whatsapp_send' for the Sub-issue A WA-401 cron");
} catch (e) {
  t.fail(fileTag + ': error_logs bridge for Sub-issue A', e);
}
