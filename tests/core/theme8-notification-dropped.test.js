// tests/core/theme8-notification-dropped.test.js
//
// Theme 8 Phase 3 regression guard — verifies the wiring that emits
// NOTIFICATION_DROPPED case_events when queueNotification /
// queueMultiChannelNotification drops on a skip path, and that the
// DB-insert catch routes through logErrorToDb with
// category='notification_queue_failure'.
//
// Forensic context: the video_scheduler bug (Theme 6 sub-issue D, commit
// 3d6f05f) caused every patient + admin stale-slot notification to drop
// silently at notify.js:233 (`invalid_to_user_id`) for the lifetime of
// the feature — because three call sites used `userId:` instead of the
// canonical `toUserId:` field. Nothing surfaced the drops. Phase 3 now
// emits NOTIFICATION_DROPPED on every skip path (orderId-gated) so the
// `/ops/silent-failures` view (Phase 5) can surface them.
//
// Two-stage verification:
//
//   STAGE A — source-grep lint (this file, runs in-process with the
//   suite). Asserts the WIRING is in place: notify.js has the
//   emitNotificationDropped helper, each skip path is preceded by it,
//   the DB-insert catch uses logErrorToDb with the right category, and
//   case_lifecycle.js exports SILENT_FAILURE_EVENTS with the 4
//   expected literals.
//
//   STAGE B — behavioral assertion via child_process. Spawns a fresh
//   node subprocess (isolated module cache) that exercises
//   queueNotification with an invalid toUserId and a mocked pg, and
//   prints the captured case_event emit. The parent asserts on the
//   subprocess output. This is the same "no real DB, no server boot"
//   shape as the Phase 1 test, but isolated to a subprocess so the
//   parent suite's require cache is untouched.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📨 Theme 8 Phase 3 — queueNotification skip paths emit NOTIFICATION_DROPPED\n');

const SRC_NOTIFY = path.join(__dirname, '..', '..', 'src', 'notify.js');
const SRC_CASE_LIFECYCLE = path.join(__dirname, '..', '..', 'src', 'case_lifecycle.js');
const SRC_CASE_SLA_WORKER = path.join(__dirname, '..', '..', 'src', 'case_sla_worker.js');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE A — Source-grep lint
// ─────────────────────────────────────────────────────────────────────────

let notifySrc = '';
let caseLifecycleSrc = '';
let caseSlaWorkerSrc = '';
try {
  notifySrc = fs.readFileSync(SRC_NOTIFY, 'utf8');
  caseLifecycleSrc = fs.readFileSync(SRC_CASE_LIFECYCLE, 'utf8');
  caseSlaWorkerSrc = fs.readFileSync(SRC_CASE_SLA_WORKER, 'utf8');
} catch (e) {
  t.fail(fileTag + ': read sources', e);
}

// 1. notify.js defines the emitNotificationDropped helper.
assert(
  /function\s+emitNotificationDropped\s*\(/.test(notifySrc),
  "notify.js defines emitNotificationDropped helper",
  "expected function declaration in src/notify.js"
);

// Slice out just the emitNotificationDropped function body so we can run
// targeted regex over it (without [^}] tripping on nested braces).
function extractFunctionBody(src, fnName) {
  const startRe = new RegExp('function\\s+' + fnName + '\\s*\\(');
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  // Walk past the parameter list FIRST (skip nested `{...}` from destructuring
  // patterns). Track paren depth to find the closing `)` of the parameter list.
  let i = startMatch.index + startMatch[0].length - 1;  // points at the `(`
  let parenDepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { i++; break; }
    }
  }
  if (i >= src.length) return null;
  // Now find the body's opening `{`.
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;
  // Walk forward, tracking brace depth.
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return null;
}
const emitBody = extractFunctionBody(notifySrc, 'emitNotificationDropped');

// 2. The helper is orderId-gated (early-return when !orderId).
assert(
  emitBody && /if\s*\(\s*!\s*orderId\s*\)\s*return/.test(emitBody),
  "emitNotificationDropped is orderId-gated (returns early when !orderId)",
  "expected `if (!orderId) return` inside emitNotificationDropped"
);

// 3. The helper uses lazy-require for case_lifecycle (circular-dep safe).
assert(
  emitBody && /require\s*\(\s*['"]\.\/case_lifecycle['"]\s*\)/.test(emitBody),
  "emitNotificationDropped lazy-requires case_lifecycle (circular-dep safe)",
  "expected `require('./case_lifecycle')` inside emitNotificationDropped body"
);

// 4. Every skip-with-reason return in notify.js is preceded by an
//    emitNotificationDropped call within ~500 chars (same block).
//    Allowlist: `deduped` (idempotent success, not a drop).
{
  const stripComments = function (code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  };
  const stripped = stripComments(notifySrc);
  const SKIP_ALLOWLIST = new Set(['deduped']);
  const reasonRe = /reason\s*:\s*['"]([a-z_]+)['"]/g;
  const offenders = [];
  let m;
  while ((m = reasonRe.exec(stripped)) !== null) {
    const reason = m[1];
    if (SKIP_ALLOWLIST.has(reason)) continue;
    // Don't count occurrences that are themselves inside an
    // emitNotificationDropped argument list.
    const back80 = stripped.slice(Math.max(0, m.index - 80), m.index);
    if (/emitNotificationDropped\s*\(/.test(back80)) continue;
    const back500 = stripped.slice(Math.max(0, m.index - 500), m.index);
    if (!/emitNotificationDropped\s*\(/.test(back500)) {
      offenders.push({ line: stripped.slice(0, m.index).split('\n').length, reason });
    }
  }
  assert(
    offenders.length === 0,
    "every queueNotification skip path has a preceding emitNotificationDropped",
    offenders.length + " offender(s): " + offenders.map(function (o) {
      return "line " + o.line + " reason='" + o.reason + "'";
    }).join(", ")
  );
}

// 5. The DB-insert catch routes through logErrorToDb with
//    category='notification_queue_failure'.
assert(
  /logErrorToDb\s*\(\s*err\s*,\s*\{[^}]*context\s*:\s*['"]queueNotification\.db_insert['"][^}]*category\s*:\s*['"]notification_queue_failure['"]/s.test(notifySrc),
  "DB-insert catch calls logErrorToDb with category='notification_queue_failure'",
  "expected logErrorToDb({context:'queueNotification.db_insert', category:'notification_queue_failure'}) in notify.js"
);

// 6. SILENT_FAILURE_EVENTS registry — 4 expected literals.
const expectedLiterals = [
  'SLA_PAUSE_SKIPPED',
  'SLA_RESUME_SKIPPED',
  'CASE_REASSIGNMENT_FAILED',
  'NOTIFICATION_DROPPED'
];
for (const lit of expectedLiterals) {
  const inRegistry = caseLifecycleSrc.indexOf("'" + lit + "'") !== -1 ||
                     caseLifecycleSrc.indexOf('"' + lit + '"') !== -1;
  assert(inRegistry,
    "SILENT_FAILURE_EVENTS registry references " + lit,
    "not found in src/case_lifecycle.js");
}

// 7. SILENT_FAILURE_EVENTS is exported.
assert(
  /SILENT_FAILURE_EVENTS/.test(caseLifecycleSrc) &&
  /module\.exports\s*=\s*\{[\s\S]*\bSILENT_FAILURE_EVENTS\b/.test(caseLifecycleSrc),
  "case_lifecycle.js exports SILENT_FAILURE_EVENTS",
  "expected `SILENT_FAILURE_EVENTS` inside module.exports object"
);

// 8. Live emit sites for each literal (regression guard — typos would
//    break the registry↔emit linkage even if the literal is in the
//    registry).
function countLiteral(src, lit) {
  const re = new RegExp("'" + lit + "'|\"" + lit + "\"", 'g');
  return (src.match(re) || []).length;
}
// case_lifecycle.js contains SLA_PAUSE_SKIPPED and SLA_RESUME_SKIPPED
// in both the registry AND emit calls — so ≥2 each.
assert(countLiteral(caseLifecycleSrc, 'SLA_PAUSE_SKIPPED') >= 2,
  "SLA_PAUSE_SKIPPED has registry + emit site in case_lifecycle.js",
  "count=" + countLiteral(caseLifecycleSrc, 'SLA_PAUSE_SKIPPED'));
assert(countLiteral(caseLifecycleSrc, 'SLA_RESUME_SKIPPED') >= 2,
  "SLA_RESUME_SKIPPED has registry + emit site in case_lifecycle.js",
  "count=" + countLiteral(caseLifecycleSrc, 'SLA_RESUME_SKIPPED'));
// CASE_REASSIGNMENT_FAILED — emit sites live in case_sla_worker.js (2 sites).
assert(countLiteral(caseSlaWorkerSrc, 'CASE_REASSIGNMENT_FAILED') >= 2,
  "CASE_REASSIGNMENT_FAILED has ≥2 emit sites in case_sla_worker.js",
  "count=" + countLiteral(caseSlaWorkerSrc, 'CASE_REASSIGNMENT_FAILED'));
// NOTIFICATION_DROPPED — emit site is the helper in notify.js itself.
assert(countLiteral(notifySrc, 'NOTIFICATION_DROPPED') >= 1,
  "NOTIFICATION_DROPPED is emitted from notify.js",
  "count=" + countLiteral(notifySrc, 'NOTIFICATION_DROPPED'));

// ─────────────────────────────────────────────────────────────────────────
// STAGE B — Behavioral assertion via child_process (isolated module cache)
//
// Spawns a fresh node subprocess that monkey-patches case_lifecycle's
// logCaseEvent in ITS OWN cache (the parent's cache is untouched),
// calls queueNotification with an invalid toUserId + orderId, and
// prints the captured event as JSON. The parent test parses the JSON
// and asserts on the shape. If the subprocess crashes or the JSON is
// malformed, the assertions fail loudly.
//
// This is the same general approach as Phase 1's monkey-patched test
// but guaranteed to NOT pollute the parent suite's require cache.
// ─────────────────────────────────────────────────────────────────────────

const subprocessScript = `
'use strict';
(async function () {
  const path = require('path');
  const projectRoot = ${JSON.stringify(path.join(__dirname, '..', '..'))};
  // Monkey-patch pg to never hit a real DB.
  const pgModule = require(path.join(projectRoot, 'src', 'pg'));
  pgModule.queryOne = async function () { return null; };  // user lookup fails → invalid_to_user_id path
  pgModule.queryAll = async function () { return []; };
  pgModule.execute  = async function () { return { rowCount: 0 }; };

  // Monkey-patch case_lifecycle.logCaseEvent to capture the emit.
  const lifecycle = require(path.join(projectRoot, 'src', 'case_lifecycle'));
  const captured = [];
  const realLogCaseEvent = lifecycle.logCaseEvent;
  lifecycle.logCaseEvent = function (caseId, eventType, payload) {
    captured.push({ caseId: caseId, eventType: eventType, payload: payload });
    return Promise.resolve();
  };

  const notify = require(path.join(projectRoot, 'src', 'notify'));

  // Call 1: with orderId → emit expected.
  await notify.queueNotification({
    orderId: 'ord_subproc_with_id',
    toUserId: 'nonexistent@example.com',
    template: 'test_template',
    channel: 'internal'
  });
  // Give the floating emit a microtask tick to settle.
  await new Promise(function (r) { setImmediate(r); });

  // Call 2: without orderId → emit NOT expected.
  await notify.queueNotification({
    toUserId: 'nonexistent@example.com',
    template: 'test_template_no_orderid',
    channel: 'internal'
  });
  await new Promise(function (r) { setImmediate(r); });

  // Restore (cosmetic — subprocess exits anyway).
  lifecycle.logCaseEvent = realLogCaseEvent;

  process.stdout.write('THEME8_PHASE3_RESULT=' + JSON.stringify(captured) + '\\n');
})().catch(function (err) {
  process.stderr.write('SUBPROC_ERROR: ' + (err && err.stack || err) + '\\n');
  process.exit(2);
});
`;

let subprocOut = '';
let subprocErr = null;
try {
  subprocOut = execFileSync(process.execPath, ['-e', subprocessScript], {
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, { PG_SSL: 'false' })
  });
} catch (e) {
  subprocErr = e;
}

if (subprocErr) {
  t.fail(fileTag + ': subprocess exited with error',
    new Error('stderr: ' + ((subprocErr.stderr && subprocErr.stderr.toString()) || subprocErr.message)));
} else {
  const marker = 'THEME8_PHASE3_RESULT=';
  const idx = subprocOut.indexOf(marker);
  if (idx === -1) {
    t.fail(fileTag + ': subprocess did not emit THEME8_PHASE3_RESULT line',
      new Error('stdout was: ' + subprocOut.slice(0, 500)));
  } else {
    const jsonLine = subprocOut.slice(idx + marker.length).split('\n')[0];
    let captured;
    try { captured = JSON.parse(jsonLine); }
    catch (e) {
      t.fail(fileTag + ': subprocess produced malformed JSON',
        new Error('line=' + jsonLine.slice(0, 200)));
      captured = null;
    }
    if (captured) {
      // Expected: exactly one emit (the one with orderId), reason='invalid_to_user_id'.
      const drops = captured.filter(function (e) { return e.eventType === 'NOTIFICATION_DROPPED'; });
      assert(drops.length === 1,
        "behavioral: invalid toUserId + orderId emits exactly one NOTIFICATION_DROPPED (no-orderId call emits nothing)",
        "saw " + drops.length + " drops: " + JSON.stringify(drops));
      if (drops.length === 1) {
        const evt = drops[0];
        assert(evt.caseId === 'ord_subproc_with_id',
          "behavioral: NOTIFICATION_DROPPED caseId === orderId",
          "caseId=" + evt.caseId);
        assert(evt.payload && evt.payload.reason === 'invalid_to_user_id',
          "behavioral: NOTIFICATION_DROPPED payload.reason === 'invalid_to_user_id'",
          "payload=" + JSON.stringify(evt.payload));
        assert(evt.payload.template === 'test_template',
          "behavioral: NOTIFICATION_DROPPED payload.template propagated",
          "template=" + evt.payload.template);
      }
    }
  }
}
