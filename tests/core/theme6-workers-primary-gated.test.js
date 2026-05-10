// tests/core/theme6-workers-primary-gated.test.js
//
// Theme 6 sub-issue A regression guard.
//
// Asserts that every long-lived background worker registration in
// src/server.js sits inside the `if (CONFIG.SLA_MODE === 'primary')`
// block (or the matching `else` branch for passive-only workers).
//
// Workers that MUST be primary-only:
//   - notification_worker (P0-WORKER-1)
//   - closeStaleConversations (P0-WORKER-2)
//   - appointment reminders cron (P3-WORKER-N3)
//   - campaign cron (P3-WORKER-N1)
//   - InstagramScheduler (P3-WORKER-N4)
//   - mac-mini SSH probe via require('./routes/ops').startMacMiniProbe
//     (P3-WORKER-N5; also asserts routes/ops.js no longer auto-starts
//     the interval at module-require time)
//   - acceptance_watcher (was already inside the primary block;
//     this test prevents a regression that moves it out)
//   - video_scheduler / case_sla_worker (already inside)
//
// Workers that MUST be passive-only (in the `else` branch):
//   - dispatchUnpaidCaseReminders setInterval
//
// Source-grep style — matches Theme 1/5/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 Theme 6 sub-A — workers gated on SLA_MODE=primary (source check)\n');

const SERVER = path.join(__dirname, '..', '..', 'src', 'server.js');
const OPS = path.join(__dirname, '..', '..', 'src', 'routes', 'ops.js');

const src = fs.readFileSync(SERVER, 'utf8');
const lines = src.split('\n');

// Locate the worker-registration `if (CONFIG.SLA_MODE === 'primary') { ... } else { ... }` block.
// There are two occurrences of the canonical header in src/server.js: a
// boot warning near line 193 and the worker block. We pick the one whose
// body opens with the canonical `SLA MODE: primary (single writer enabled)`
// log line, which is unique to the worker block.
const PRIMARY_OPEN = "if (CONFIG.SLA_MODE === 'primary') {";
const PRIMARY_BODY_MARKER = "SLA MODE: primary (single writer enabled)";
let openLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf(PRIMARY_OPEN) < 0) continue;
  // peek the next handful of lines for the worker-block marker
  const peek = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
  if (peek.indexOf(PRIMARY_BODY_MARKER) >= 0) { openLine = i; break; }
}
if (openLine < 0) {
  t.fail('locate primary-mode if block', new Error('"' + PRIMARY_OPEN + '" not found in src/server.js (worker block — looked for "' + PRIMARY_BODY_MARKER + '")'));
} else {
  // The worker if/else block in src/server.js follows a canonical indent:
  //   `  if (CONFIG.SLA_MODE === 'primary') {`
  //   `    ...primary body...`
  //   `  } else {`
  //   `    ...else body...`
  //   `  }`
  // i.e. the if-keyword sits at column 2 and the closing braces match.
  // We exploit this rather than walking braces (which would have to skip
  // strings/comments inside the body).
  const PRIMARY_END_RE = /^  } else \{\s*$/;
  const ELSE_END_RE = /^  }\s*$/;
  let primaryClose = -1;
  let elseOpen = -1;
  let elseClose = -1;
  for (let i = openLine + 1; i < lines.length; i++) {
    if (PRIMARY_END_RE.test(lines[i])) {
      primaryClose = i;
      elseOpen = i;
      // Find the matching `}` of the else branch (next `^  }$`).
      for (let j = i + 1; j < lines.length; j++) {
        if (ELSE_END_RE.test(lines[j])) { elseClose = j; break; }
      }
      break;
    }
  }
  if (primaryClose < 0) {
    t.fail('locate primary block close brace', new Error('canonical `  } else {` line not found after worker-block opener'));
  } else {
    // Build the primary block text + the else block text.
    const primaryBody = lines.slice(openLine, primaryClose + 1).join('\n');
    const elseBody = (elseClose >= 0) ? lines.slice(elseOpen, elseClose + 1).join('\n') : '';

    // ── 1. Workers that MUST be inside the primary block ────────────
    const PRIMARY_REQUIRED = [
      // [human-name, source-substring]
      ['notification_worker setInterval',     "runNotificationWorker(50)"],
      ['closeStaleConversations',             "closeStaleConversations"],
      ['appointment reminder cron',           "runAppointmentReminders"],
      ['campaign cron',                       "campaignCron.schedule"],
      ['Instagram scheduler instance',        "new InstagramScheduler"],
      ['mac-mini SSH probe',                  "startMacMiniProbe"],
      ['acceptance watcher',                  "startAcceptanceWatcher"],
      ['video scheduler',                     "startVideoScheduler"],
      ['case SLA worker fallback',            "startCaseSlaWorker"],
    ];
    for (const [name, needle] of PRIMARY_REQUIRED) {
      try {
        if (primaryBody.indexOf(needle) < 0) {
          throw new Error("`" + needle + "` not found inside `if (CONFIG.SLA_MODE === 'primary') { … }` block");
        }
        // The same needle must NOT appear outside the primary block (the
        // else block or anywhere after it, before EOF or next route mount).
        // Slice the *outside* span to assert no duplicate registration.
        const before = lines.slice(0, openLine).join('\n');
        const after = lines.slice((elseClose >= 0 ? elseClose : primaryClose) + 1).join('\n');
        // Allow occurrences in comments / declarations earlier in the file
        // (e.g. require statements at the top). We look only for the call
        // shape `<needle>(`. The `new InstagramScheduler` test already has
        // its own paren context.
        const callShape = name === 'Instagram scheduler instance' ? needle : needle + '(';
        if (callShape.indexOf('(') >= 0) {
          // Ignore the import line. Lines that match `require(...)` or
          // `module.exports` shape don't actually invoke the worker.
          const outsideOffenders = (before + '\n' + after)
            .split('\n')
            .filter(function (l) { return l.indexOf(callShape) >= 0; })
            .filter(function (l) { return !/require\s*\(/.test(l); })
            .filter(function (l) { return !/^\s*\/\//.test(l); });
          if (outsideOffenders.length > 0) {
            throw new Error("`" + callShape + "` invoked outside the primary-mode block:\n  " + outsideOffenders.join('\n  '));
          }
        }
        t.pass(name + ' registered inside primary-mode block');
      } catch (e) { t.fail(name + ' is primary-gated', e); }
    }

    // ── 2. Passive-mode-only workers ───────────────────────────────
    try {
      if (elseBody.indexOf('dispatchUnpaidCaseReminders') < 0) {
        throw new Error('dispatchUnpaidCaseReminders setInterval missing from passive (else) branch');
      }
      t.pass('passive payment reminders are inside the else branch');
    } catch (e) { t.fail('passive payment reminders gated correctly', e); }
  }
}

// ── 3. routes/ops.js must NOT auto-start the mac-mini probe ──────
try {
  const opsSrc = fs.readFileSync(OPS, 'utf8');
  // The pre-fix shape was: `setInterval(refreshMacMiniStatus, 2 * 60 * 1000);`
  // followed by a bare `refreshMacMiniStatus();` at module top level.
  const AUTO_START = /^\s*setInterval\s*\(\s*refreshMacMiniStatus/m;
  if (AUTO_START.test(opsSrc)) {
    throw new Error("routes/ops.js still auto-starts setInterval(refreshMacMiniStatus, ...) at module-require time");
  }
  // Also assert the new exported function exists.
  if (opsSrc.indexOf('module.exports.startMacMiniProbe') < 0) {
    throw new Error("routes/ops.js does not export startMacMiniProbe — server.js can't gate it");
  }
  t.pass('routes/ops.js no longer auto-starts the mac-mini probe at module-load');
} catch (e) { t.fail('routes/ops.js mac-mini probe is callable, not auto-started', e); }
