// tests/core/theme7-sla-breach-uses-canonical.test.js
//
// Theme 7 sub-issue B regression guard.
//
// Asserts via source inspection that all SLA-breach-mutation paths route
// through the canonical case_lifecycle.markSlaBreach helper, and that the
// 4 legacy paths that previously wrote `status='breached'` raw are now
// no-ops or delegations to the canonical worker.
//
// Source-grep style — matches the Theme 5 pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🌀 Theme 7 sub-B — SLA-breach paths use canonical helper (source check)\n');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
function read(p) { return fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'); }

// 1. case_lifecycle.markSlaBreach now fires issueBreachRefundSafe + the
//    patient bell `order_breached_patient`.
try {
  const lifecycle = read('case_lifecycle.js');
  // Slice the markSlaBreach body — from declaration to the next `async function`.
  const start = lifecycle.indexOf('async function markSlaBreach(');
  if (start < 0) throw new Error('markSlaBreach not found in case_lifecycle.js');
  const after = lifecycle.slice(start);
  const nextFn = after.search(/\nasync function /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;

  if (!/issueBreachRefundSafe\(caseId\)/.test(body)) {
    throw new Error('markSlaBreach does not call issueBreachRefundSafe(caseId)');
  }
  if (!/template:\s*['"]order_breached_patient['"]/.test(body)) {
    throw new Error('markSlaBreach does not queue the order_breached_patient bell');
  }
  if (!/dedupe_key:\s*['"]sla:breach:['"]\s*\+\s*caseId\s*\+\s*['"]:patient['"]/.test(body)) {
    throw new Error('markSlaBreach order_breached_patient bell missing per-(case, patient) dedupe_key');
  }
  t.pass('markSlaBreach fires issueBreachRefundSafe + order_breached_patient bell');
} catch (e) { t.fail('markSlaBreach-additions', e); }

// 2. case_sla_worker.runCaseSlaSweep includes pre-breach loop + returns preBreaches.
try {
  const worker = read('case_sla_worker.js');
  if (!/async function fetchPreBreachCandidates/.test(worker)) {
    throw new Error('case_sla_worker.js missing fetchPreBreachCandidates');
  }
  if (!/async function handlePreBreach/.test(worker)) {
    throw new Error('case_sla_worker.js missing handlePreBreach');
  }
  if (!/template:\s*['"]order_sla_prebreach['"]/.test(worker)) {
    throw new Error('handlePreBreach does not queue order_sla_prebreach to superadmins');
  }
  if (!/template:\s*['"]sla_reminder_doctor['"]/.test(worker)) {
    throw new Error('handlePreBreach does not queue sla_reminder_doctor to assigned doctor');
  }
  if (!/SLA pre-breach alert/.test(worker)) {
    throw new Error("handlePreBreach does not log 'SLA pre-breach alert' for dedupe");
  }
  if (!/return\s*\{\s*preBreaches:\s*preBreachCount,\s*breaches:\s*breachCount,\s*timeouts:\s*timeoutCount\s*\}/.test(worker)) {
    throw new Error('runCaseSlaSweep does not return preBreaches in the result object');
  }
  t.pass('case_sla_worker has pre-breach loop + returns preBreaches');
} catch (e) { t.fail('case-sla-worker-prebreach', e); }

// 3. server.js:runSlaReminderJob is now a no-op.
try {
  const server = read('server.js');
  const start = server.indexOf('async function runSlaReminderJob(');
  if (start < 0) throw new Error('runSlaReminderJob not found in server.js');

  // Capture the comment block + function body — comment lives BEFORE the
  // function declaration. Back up ~1500 chars to grab the preceding
  // deprecation comment.
  const sliceStart = Math.max(0, start - 1500);
  const after = server.slice(start);
  const nextFn = after.search(/\n(async )?function /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;
  const commentBlock = server.slice(sliceStart, start);

  if (/client\.query\([\s\S]*?UPDATE\s+orders\s+SET\s+status\s*=\s*\$1,\s*breached_at/i.test(body)) {
    throw new Error('runSlaReminderJob still writes status=breached on orders rows');
  }
  if (/UPDATE\s+orders[\s\S]{0,80}sla_reminder_sent\s*=\s*true/i.test(body)) {
    throw new Error('runSlaReminderJob still writes sla_reminder_sent column flag');
  }
  if (!/DEPRECATED — Theme 7 sub-issue B/.test(commentBlock + body)) {
    throw new Error('runSlaReminderJob missing DEPRECATED Theme 7 marker comment');
  }
  if (!/return;/.test(body)) {
    throw new Error('runSlaReminderJob body is not a `return;` no-op');
  }
  t.pass('server.js:runSlaReminderJob is a deprecation-marked no-op');
} catch (e) { t.fail('server-runSlaReminderJob-noop', e); }

// 4. Side issue #47 (2026-05-12) — sla_watcher.js + sla_worker.js +
//    jobs/sla_watcher.js were all deleted. The block that lived here
//    asserted the file was a deprecation-marked no-op with export shape
//    preserved (so the server.js:212 + superadmin.js:9 imports wouldn't
//    crash). Both imports + the file itself are gone, so the contract
//    is moot. See commit message of #47 step 4/4 for the full sweep.

// 5. routes/superadmin.js:performSlaCheck delegates to runCaseSlaSweep.
try {
  const superadmin = read('routes/superadmin.js');
  const start = superadmin.indexOf('async function performSlaCheck(');
  if (start < 0) throw new Error('performSlaCheck not found');
  const after = superadmin.slice(start);
  const nextFn = after.search(/\n(async )?function /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;

  if (/UPDATE\s+orders\s+SET\s+status\s*=\s*['"]breached['"]/i.test(body)) {
    throw new Error('performSlaCheck still writes status=breached raw');
  }
  if (/UPDATE\s+orders[\s\S]{0,80}status\s*=\s*['"]new['"][\s\S]{0,120}accepted_at\s*=\s*NULL/i.test(body)) {
    throw new Error("performSlaCheck still resets status='new' + accepted_at=NULL on reassign (P0-STATE-2 anti-pattern)");
  }
  if (/UPDATE\s+orders[\s\S]{0,40}pre_breach_notified\s*=\s*true/i.test(body)) {
    throw new Error('performSlaCheck still writes pre_breach_notified column flag');
  }
  if (!/runCaseSlaSweep\(now\)/.test(body)) {
    throw new Error('performSlaCheck does not delegate to runCaseSlaSweep(now)');
  }
  if (!/result\.preBreaches/.test(body) || !/result\.breaches/.test(body)) {
    throw new Error('performSlaCheck does not unwrap preBreaches + breaches from runCaseSlaSweep result');
  }
  t.pass('performSlaCheck delegates to canonical runCaseSlaSweep');
} catch (e) { t.fail('performSlaCheck-delegation', e); }

// 6. Lint: no `UPDATE orders SET status = 'breached'` raw write anywhere
//    in src/ except inside the disabled (header-deprecated) files.
try {
  // Side issue #47 — files previously allowlisted here
  // (sla_worker.js + jobs/sla_watcher.js + sla_watcher.js) have been
  // deleted. Empty allowlist: any raw `UPDATE orders SET status='breached'`
  // write anywhere in src/ fails the lint with no exemption.
  const ALLOWLISTED_FILES = new Set();
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'public' ||
            entry.name === 'views' || entry.name === 'migrations' ||
            entry.name === 'locales.archived-2026-05' || entry.name === '__tests__') {
          continue;
        }
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.js$/.test(entry.name)) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(SRC_ROOT, full);
        if (ALLOWLISTED_FILES.has(rel)) continue;
        const content = fs.readFileSync(full, 'utf8');
        // Match `UPDATE orders SET status = 'breached'` patterns inside
        // SQL invocations (not in comments). Look for an actual SQL caller
        // before the literal.
        const RE = /(execute|client\.query|safeRun)\(\s*[`'"][\s\S]{0,400}UPDATE\s+orders[\s\S]{0,400}status\s*=\s*['"]breached['"]/i;
        if (RE.test(content)) {
          offenders.push(rel);
        }
      }
    }
  }
  walk(SRC_ROOT);
  if (offenders.length) {
    throw new Error("raw `UPDATE orders SET status='breached'` writes still exist in: " + offenders.join(', '));
  }
  t.pass("no raw `UPDATE orders SET status='breached'` writes outside deprecated files");
} catch (e) { t.fail('lint-no-raw-breached-writes', e); }
