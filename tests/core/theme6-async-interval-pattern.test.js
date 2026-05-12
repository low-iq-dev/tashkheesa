// tests/core/theme6-async-interval-pattern.test.js
//
// Theme 6 sub-issue B regression guard.
//
// Forbids the "sync try/catch around an async setInterval body" shape:
//
//   setInterval(function() { try { runAsyncFn();   } catch (e) {...} }, ms)  // ❌
//   setInterval(()        => { try { runAsyncFn();   } catch (e) {...} }, ms)  // ❌
//   setTimeout (function() { try { runAsyncFn();   } catch (e) {...} }, ms)  // ❌ (recurse-style)
//
// The bug: setInterval/setTimeout invoke the callback synchronously each
// tick. If the callback's body is `try { asyncFn(); } catch`, the try
// catches only the synchronous portion up to the first await inside
// asyncFn — anything past that becomes an `unhandledRejection` and trips
// server.js's `process.exit(1)` guard. Theme 6 Sub-issue B audited and
// fixed every occurrence to either:
//
//   setInterval(() => { asyncFn().catch(handleErr); }, ms)                    // ✅ promise-aware catcher
//   setInterval(async () => { try { await asyncFn(); } catch (e) {...} })     // ✅ async/await
//   setInterval(syncFn, ms)                                                   // ✅ truly sync callee
//   setInterval(asyncFnWithFullBodyTryCatch, ms)                              // ✅ inner fn always resolves
//
// This test grep-matches the offending shape and fails on any net-new
// occurrence outside the audited allowlist.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 Theme 6 sub-B — no async-fn-in-sync-try inside setInterval/setTimeout\n');

const SRC = path.join(__dirname, '..', '..', 'src');

// ── Allowlist of audited safe call sites ──────────────────────────
//
// Each entry is `{file, callee}`: a setInterval/setTimeout body that
// invokes `<callee>()` inside `try { ... } catch`. The audit confirmed
// the callee's Promise always resolves (it has its own full-body try/
// catch), so the outer sync wrapper is harmless. Net-new entries
// require a PR-level justification.
const ALLOWLIST = [
  // closeStaleConversations (src/routes/messaging.js:398-413) wraps its
  // entire body in `try { ... } catch (_) { return 0; }` — it cannot
  // reject. The boot setTimeout and the daily setInterval in server.js
  // both invoke it inside a sync try; the wrapper is defensive only.
  { file: path.join(SRC, 'server.js'), callee: 'closeStaleConversations' },
  // runAppointmentReminders (jobs/appointment_reminders.js) is invoked
  // from a node-cron callback wrapped in `try { ... } catch (_) {}` —
  // node-cron schedules an async callback, but the bare try around the
  // call is harmless because runAppointmentReminders's outer try/catch
  // covers its body. Allowed.
  { file: path.join(SRC, 'server.js'), callee: 'runAppointmentReminders' },
  // (processCampaign was previously allowlisted here for the campaign
  // cron's `setImmediate(() => { try { processCampaign(...) } catch })`
  // shape — entry removed under Theme 6 Sub-issue C / Phase 3, which
  // converted that call site to `processCampaign(...).catch(...)`. Note
  // the lint regex only matches setInterval/setTimeout, not setImmediate,
  // so the entry was already defensive-only; keeping the call site clean
  // matters for the dedicated campaigns-cron test in
  // tests/core/theme6-campaigns-cron-correct-iteration.test.js.)

  // case_sla_worker.runCaseSlaSweep — the AUDITED bug pattern. After
  // Theme 6 Sub-issue B the call site is `runCaseSlaSweep().catch(...)`
  // (no sync try wrapper) so this entry should NOT be triggered. Listed
  // here only as a guard against accidental re-introduction.

  // runSlaEnforcementSweep wraps its entire body in a top-level
  // `try { ... } catch (err) { logFatal(...) } finally { slaEnforcementRunning = false; }`
  // (server.js:962-976), and the catch handler doesn't throw. The
  // Promise therefore always resolves, so the two sync-try wrappers in
  // server.js — the boot setTimeout (around line 1017) and the
  // event-triggered setTimeout (around line 749, audit P0-WORKER-5) —
  // are defensive only. NOT a Sub-issue B target; flagged only by
  // shape lint. If the function ever loses its full-body try/catch,
  // remove this allowlist entry and convert both sites to
  // `.catch()`-style.
  { file: path.join(SRC, 'server.js'), callee: 'runSlaEnforcementSweep' },
];

// ── Pattern definition ────────────────────────────────────────────
//
// Two regexes match the offending shape. The KEY distinguisher:
// the FIRST identifier inside `try {` is captured. If it's `await`,
// the call is properly awaited (safe). Anything else is the bug.
//
//   setInterval ( function () { try { <ident> ( ...     // function-form
//   setInterval ( ( ) => { try { <ident> ( ...           // arrow-form
//
// (We accept optional `async` prefix on the wrapper because that
// shape would also be a bug if the body still uses `try{ fn();}`
// instead of `try{ await fn();}`.)
const SHAPES = [
  /\bset(?:Interval|Timeout)\s*\(\s*(?:async\s+)?function\s*\(\s*\)\s*\{\s*try\s*\{\s*([a-zA-Z_$][\w$]*)\s*\(/g,
  /\bset(?:Interval|Timeout)\s*\(\s*(?:async\s+)?\(\s*\)\s*=>\s*\{\s*try\s*\{\s*([a-zA-Z_$][\w$]*)\s*\(/g,
];

// Find every .js file in src/ (excluding tests, node_modules, dist).
let files = [];
try {
  const raw = execSync(
    "find " + SRC + " -type f -name '*.js' " +
    "-not -path '*/node_modules/*' " +
    "-not -path '*/__tests__/*' " +
    "-not -path '*/test/*' " +
    "-not -path '*/tests/*'",
    { encoding: 'utf8' }
  ).trim();
  files = raw ? raw.split('\n') : [];
} catch (e) {
  t.fail('discover source files', e);
}

const offenders = [];
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }

  for (const re of SHAPES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const callee = m[1];
      // ✅ properly awaited
      if (callee === 'await') continue;
      // ✅ allowlisted (audited safe)
      const allowed = ALLOWLIST.some(function (a) { return a.file === file && a.callee === callee; });
      if (allowed) continue;
      // ❌ bug
      // Locate the line number of the match start for a useful error msg.
      const upTo = text.slice(0, m.index);
      const lineNo = upTo.split('\n').length;
      offenders.push({ file: file, line: lineNo, callee: callee, snippet: m[0] });
    }
  }
}

if (offenders.length) {
  const lines = offenders.map(function (o) {
    return '  ' + o.file + ':' + o.line + ' — `' + o.snippet.trim() + '` (callee: `' + o.callee + '`)';
  });
  t.fail(
    'no async-fn-in-sync-try inside setInterval/setTimeout',
    new Error(
      'Found ' + offenders.length + ' setInterval/setTimeout body that wraps a non-awaited call in a sync try/catch:\n' +
      lines.join('\n') +
      '\n\nFix: use `setInterval(() => { fn().catch(handleErr); }, ms)` OR `setInterval(async () => { try { await fn(); } catch ... })`. ' +
      'If the inner fn is audited-safe (full-body try/catch returning on error), add an entry to ALLOWLIST in this test file.'
    )
  );
} else {
  t.pass('no async-fn-in-sync-try shape inside setInterval/setTimeout (' + files.length + ' files scanned)');
}

// ── Spot-check the audited fixes ──────────────────────────────────
// Each of the six fix sites in the Theme 6 §4-B diff has a verifiable
// post-condition. We assert those directly so a future regression
// (e.g. someone reverts `await` to a bare call) is caught even if the
// callee identifier accidentally lands on the allowlist.

try {
  const slaWorkerSrc = fs.readFileSync(path.join(SRC, 'case_sla_worker.js'), 'utf8');
  // Boot run + interval body must use `.catch(`
  if (!/runCaseSlaSweep\s*\(\s*\)\s*\.catch\s*\(/.test(slaWorkerSrc)) {
    throw new Error('case_sla_worker.startCaseSlaWorker no longer uses `runCaseSlaSweep().catch(...)` — Sub-issue B regression');
  }
  // Old sync-try shape must be gone
  if (/setInterval\s*\(\s*\(\s*\)\s*=>\s*\{\s*try\s*\{\s*runCaseSlaSweep\s*\(/.test(slaWorkerSrc)) {
    throw new Error('case_sla_worker still wraps runCaseSlaSweep() in a sync try inside setInterval — Sub-issue B regression');
  }
  t.pass('case_sla_worker uses promise-aware .catch() for boot + interval');
} catch (e) { t.fail('case_sla_worker .catch() shape', e); }

try {
  const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  // runSlaEnforcementSweep must `await` runWatcherSweep, dispatchUnpaidCaseReminders, sweepExpiredDoctorAccepts.
  const sweepFnStart = serverSrc.indexOf('async function runSlaEnforcementSweep');
  const sweepFnEnd = serverSrc.indexOf('\n}\n', sweepFnStart);
  const sweepBody = sweepFnStart >= 0 && sweepFnEnd > sweepFnStart ? serverSrc.slice(sweepFnStart, sweepFnEnd) : '';
  // Side issue #47 — runWatcherSweep removed from runSlaEnforcementSweep
  // (sla_watcher.runSlaSweep was a no-op stub; canonical sweep is
  // case_sla_worker via pg-boss). The other two awaits remain load-bearing.
  const checks = [
    ['dispatchUnpaidCaseReminders awaited',  /await\s+dispatchUnpaidCaseReminders\s*\(/],
    ['sweepExpiredDoctorAccepts awaited',    /await\s+caseLifecycle\.sweepExpiredDoctorAccepts\s*\(/],
  ];
  for (const [name, re] of checks) {
    if (!re.test(sweepBody)) {
      throw new Error('runSlaEnforcementSweep: ' + name + ' — Sub-issue B regression');
    }
  }
  t.pass('runSlaEnforcementSweep awaits each async sub-sweep');
} catch (e) { t.fail('runSlaEnforcementSweep awaits', e); }

try {
  const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  // Passive payment reminders must use .catch(...)
  const PASSIVE_OK = /passiveReminderId\s*=\s*setInterval\s*\(\s*function\s*\(\s*\)\s*\{\s*dispatchUnpaidCaseReminders\s*\(\s*\)\s*\.catch/;
  if (!PASSIVE_OK.test(serverSrc)) {
    throw new Error('passive payment reminders setInterval no longer uses `dispatchUnpaidCaseReminders().catch(...)` — Sub-issue B regression');
  }
  t.pass('passive payment reminders use promise-aware .catch()');
} catch (e) { t.fail('passive payment reminders .catch() shape', e); }
