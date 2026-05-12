// tests/core/theme8-worker-errlog-coverage.test.js
//
// Theme 8 Phase 4 regression guard — every console.error/warn in worker
// files must be paired with a logErrorToDb call (or sentinel-exempt).
// Modelled on Phase 2's route coverage test but scoped to the 6 worker
// files (plus 2 dead files that are intentionally skipped).
//
// Pairing rule: for each console.(error|warn)(...) call, a logErrorToDb(
// or logFatal( call (logFatal auto-routes Errors to error_logs per
// Phase 4-A) must appear within ±500 chars (typically the enclosing
// catch block).
//
// Exemptions via THEME8-LINT-EXEMPT-HELPER sentinel within ±500 chars.
//
// Side issue #47 (2026-05-12) deleted src/sla_worker.js +
// src/sla_watcher.js + src/jobs/sla_watcher.js; the prior dead-file
// allowlist documented here is no longer needed.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n⚙️  Theme 8 Phase 4 — every console.error/warn in worker files is wrapped\n');

const SRC = path.join(__dirname, '..', '..', 'src');
const FILES = [
  path.join(SRC, 'case_sla_worker.js'),
  path.join(SRC, 'notification_worker.js'),
  path.join(SRC, 'video_scheduler.js'),
  path.join(SRC, 'instagram', 'scheduler.js'),
  path.join(SRC, 'workers', 'acceptance_watcher.js'),
  path.join(SRC, 'jobs', 'appointment_reminders.js'),
];

const RADIUS = 500;

function findCalls(raw, fnName) {
  const re = new RegExp('\\bconsole\\.' + fnName + '\\s*\\(', 'g');
  const out = [];
  let m;
  while ((m = re.exec(raw)) !== null) out.push({ offset: m.index, kind: fnName });
  return out;
}

function withinRadius(raw, offset, needle) {
  const start = Math.max(0, offset - RADIUS);
  const end = Math.min(raw.length, offset + RADIUS);
  return raw.slice(start, end).indexOf(needle) !== -1;
}

function offsetToLine(raw, offset) {
  return raw.slice(0, offset).split('\n').length;
}

const offenders = [];
const wrappedCount = { total: 0, byFile: {} };
const exemptCount = { total: 0, byFile: {} };
const logFatalPairCount = { total: 0, byFile: {} };

for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  wrappedCount.byFile[rel] = 0;
  exemptCount.byFile[rel] = 0;
  logFatalPairCount.byFile[rel] = 0;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { t.fail(fileTag + ': read ' + rel, e); continue; }

  const calls = findCalls(raw, 'error').concat(findCalls(raw, 'warn'));
  for (const c of calls) {
    const lineNo = offsetToLine(raw, c.offset);
    const exempt = withinRadius(raw, c.offset, 'THEME8-LINT-EXEMPT-HELPER');
    const wrappedDirect = withinRadius(raw, c.offset, 'logErrorToDb(');
    // logFatal( within radius counts as an indirect wrap because the
    // Phase 4-A rewrite makes logFatal auto-route Errors to error_logs.
    const wrappedViaLogFatal = withinRadius(raw, c.offset, 'logFatal(');
    if (exempt) {
      exemptCount.total++;
      exemptCount.byFile[rel]++;
    } else if (wrappedDirect) {
      wrappedCount.total++;
      wrappedCount.byFile[rel]++;
    } else if (wrappedViaLogFatal) {
      logFatalPairCount.total++;
      logFatalPairCount.byFile[rel]++;
    } else {
      offenders.push({ file: rel, line: lineNo, kind: c.kind });
    }
  }
}

function report(rel) {
  const d = wrappedCount.byFile[rel];
  const f = logFatalPairCount.byFile[rel];
  const x = exemptCount.byFile[rel];
  console.log('  ' + rel + ':   ' + d + ' logErrorToDb, ' + f + ' logFatal-paired, ' + x + ' exempt');
}
try { for (const file of FILES) report(file.replace(SRC + '/', 'src/')); } catch (_) {}

// ── Assertion 1: no unpaired console calls in worker files ─────────────
try {
  if (offenders.length) {
    const detail = offenders.map(function (o) {
      return '    ' + o.file + ':' + o.line + ' [console.' + o.kind + ']';
    }).join('\n');
    throw new Error(
      offenders.length + ' unpaired console call(s):\n' + detail +
      "\n    → fix: wrap with logErrorToDb(err, {context, category, candidateId, workerPhase}) within ±" + RADIUS + ' chars,' +
      "\n    OR call logFatal(msg, err) so the Phase 4-A rewrite routes the Error to error_logs," +
      "\n    OR add `// THEME8-LINT-EXEMPT-HELPER: <reason>` if intentional."
    );
  }
  t.pass(fileTag + ': every console.error/warn in worker files is wrapped or exempt');
} catch (e) { t.fail(fileTag + ': every console.error/warn in worker files is wrapped or exempt', e); }

// ── Assertion 2: worker files import logErrorToDb (except case_sla_worker
//    which uses logFatal — pre-existing, Phase 4-A covers it) ──────────
//
// case_sla_worker imports `fatal: logFatal` from logger and also does a
// lazy `require('./logger')` inside its fetch catches to pull
// logErrorToDb. Either pattern is acceptable — assertion checks for the
// presence of logErrorToDb reference anywhere in the file.
const IMPORT_REQUIRED = [
  'src/notification_worker.js',
  'src/video_scheduler.js',
  'src/instagram/scheduler.js',
  'src/workers/acceptance_watcher.js',
];
for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  if (!IMPORT_REQUIRED.includes(rel)) continue;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const hasImport = /require\(['"][^'"]*logger['"]\)/.test(raw) && /\blogErrorToDb\b/.test(raw);
  try {
    if (!hasImport) {
      throw new Error(rel + ' does not require logErrorToDb');
    }
    t.pass(fileTag + ': ' + rel + ' imports logErrorToDb');
  } catch (e) { t.fail(fileTag + ': ' + rel + ' imports logErrorToDb', e); }
}

// ── Assertion 3: minimum logErrorToDb token counts per file ───────────
//
// Lower bounds — adding more wraps is always fine. These match the
// Phase 4 inventory: notification_worker 3, video_scheduler 3,
// instagram/scheduler 3, workers/acceptance_watcher 2.
// case_sla_worker already had 3 from Theme 7 Phase 2; verifying ≥3.
// jobs/appointment_reminders had 1 pre-Theme-8; verifying ≥1.
const MIN_LOGERR_PER_FILE = {
  'src/case_sla_worker.js': 3,
  'src/notification_worker.js': 3,
  'src/video_scheduler.js': 3,
  'src/instagram/scheduler.js': 3,
  'src/workers/acceptance_watcher.js': 2,
  'src/jobs/appointment_reminders.js': 1,
};
for (const file of FILES) {
  const rel = file.replace(SRC + '/', 'src/');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const count = (raw.match(/logErrorToDb\s*\(/g) || []).length;
  try {
    const min = MIN_LOGERR_PER_FILE[rel];
    if (count < min) {
      throw new Error(rel + ' has ' + count + ' logErrorToDb call(s); expected ≥ ' + min);
    }
    t.pass(fileTag + ': ' + rel + ' has ≥ ' + min + ' logErrorToDb calls (saw ' + count + ')');
  } catch (e) { t.fail(fileTag + ': ' + rel + ' has ≥ minimum logErrorToDb calls', e); }
}

// ── Assertion 4: SKIP LOCKED is present on the notification_worker
//    fetch query. (Phase 4-D — bundled here so a single test file
//    covers worker-side coverage end-to-end.) ────────────────────────
{
  const notifPath = path.join(SRC, 'notification_worker.js');
  let raw = '';
  try { raw = fs.readFileSync(notifPath, 'utf8'); } catch (_) {}
  const hasSkipLocked = /FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(raw);
  const hasOrderByFifo = /ORDER\s+BY\s+at\s+ASC/i.test(raw);
  try {
    if (!hasSkipLocked) {
      throw new Error("notification_worker.js SELECT lacks `FOR UPDATE SKIP LOCKED`");
    }
    t.pass(fileTag + ': notification_worker SELECT uses FOR UPDATE SKIP LOCKED (Phase 4-D)');
  } catch (e) { t.fail(fileTag + ': notification_worker SELECT uses FOR UPDATE SKIP LOCKED (Phase 4-D)', e); }
  try {
    if (!hasOrderByFifo) {
      throw new Error("notification_worker.js SELECT lost `ORDER BY at ASC` (FIFO regression)");
    }
    t.pass(fileTag + ': notification_worker SELECT preserves ORDER BY at ASC (FIFO)');
  } catch (e) { t.fail(fileTag + ': notification_worker SELECT preserves ORDER BY at ASC (FIFO)', e); }
}

// ── Assertion 5: 4-C status='skipped' split is wired. ──────────────────
//
// Pre-fix: `if (result.ok || result.skipped) { UPDATE status='sent' }`.
// Post-fix: separate `else if (result.skipped) { UPDATE status='skipped' }`
// branch. Asserts the literal "'skipped'" appears in a worker-side
// UPDATE statement within notification_worker.js.
{
  const notifPath = path.join(SRC, 'notification_worker.js');
  let raw = '';
  try { raw = fs.readFileSync(notifPath, 'utf8'); } catch (_) {}
  // Look for a `result.skipped` branch that UPDATEs to 'skipped'.
  // The comment block between the branch and the UPDATE can be long
  // (Phase 4-C migrated the inline P1-ERR-16 comment to a multi-line
  // explanation), so allow up to 1500 chars of intervening text.
  const hasSkippedBranch = /else\s+if\s*\(\s*result\.skipped\s*\)[\s\S]{0,1500}'skipped'/.test(raw);
  try {
    if (!hasSkippedBranch) {
      throw new Error("notification_worker.js does not write status='skipped' on result.skipped (P1-ERR-16 regression)");
    }
    t.pass(fileTag + ": notification_worker writes status='skipped' on result.skipped (Phase 4-C)");
  } catch (e) { t.fail(fileTag + ": notification_worker writes status='skipped' on result.skipped (Phase 4-C)", e); }
}
