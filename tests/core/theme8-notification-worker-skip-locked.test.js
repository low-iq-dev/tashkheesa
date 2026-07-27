// tests/core/theme8-notification-worker-skip-locked.test.js
//
// notification_worker claim-query regression guard.
//
// HISTORY: this file originally pinned a plain
//   `SELECT * FROM notifications ... FOR UPDATE SKIP LOCKED`
// fetch. Launch-audit finding B10 established that that SELECT ran in
// autocommit — the row lock was released the instant the statement
// returned, so `FOR UPDATE SKIP LOCKED` protected nothing and a slow
// provider (overlapping 30s ticks) could dispatch the same row twice.
//
// The fix replaces the SELECT with an ATOMIC CLAIM: a single
//   `UPDATE notifications SET status='sending' WHERE id IN (SELECT ...
//    FOR UPDATE SKIP LOCKED) RETURNING *`
// that flips queued/retry rows to 'sending' and returns them, so no
// concurrent tick/instance can grab the same row. A crashed worker's
// orphaned 'sending' rows (lease expired) are re-queued at the top of
// each run. This test now guards THAT behavior.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔒 notification_worker uses an atomic claim (UPDATE…RETURNING) + SKIP LOCKED\n');

const NOTIFY_WORKER = path.join(__dirname, '..', '..', 'src', 'notification_worker.js');
let raw = '';
try { raw = fs.readFileSync(NOTIFY_WORKER, 'utf8'); }
catch (e) { t.fail(fileTag + ': read notification_worker.js', e); }

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// 1. The file still uses FOR UPDATE SKIP LOCKED (scale-out safety).
assert(
  /FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(raw),
  "notification_worker contains FOR UPDATE SKIP LOCKED",
  "missing FOR UPDATE SKIP LOCKED — required to safely scale to >1 worker instance"
);

// 2. ORDER BY at ASC is preserved (FIFO).
assert(
  /ORDER\s+BY\s+at\s+ASC/i.test(raw),
  "notification_worker preserves ORDER BY at ASC (FIFO)",
  "ORDER BY at ASC removed — FIFO regression"
);

// 3. The row fetch is an ATOMIC CLAIM: `UPDATE notifications SET status='sending'
//    ... RETURNING`. A plain SELECT would not protect against duplicate dispatch.
const claimRe = /UPDATE\s+notifications\s+SET\s+status\s*=\s*'sending'[\s\S]*?RETURNING\s*\*/i;
const claimMatch = raw.match(claimRe);
const claimBlock = claimMatch ? claimMatch[0] : '';
assert(
  !!claimBlock,
  "row fetch is an atomic claim: UPDATE notifications SET status='sending' ... RETURNING *",
  "no `UPDATE notifications SET status='sending' ... RETURNING *` block found — a plain SELECT does not protect against duplicate sends"
);

// 4. The claim block carries all three clauses together (SKIP LOCKED, FIFO,
//    queued/retry filter) — catches a refactor that splits them apart.
assert(
  /WHERE\s+status\s+IN\s*\(\s*'queued',\s*'retry'\s*\)/i.test(claimBlock),
  "claim filters status IN ('queued','retry')",
  "expected status filter inside the claim; block=" + claimBlock.slice(0, 160)
);
assert(
  /FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(claimBlock),
  "SKIP LOCKED is INSIDE the claim query (not a different query)",
  "SKIP LOCKED appeared elsewhere in file but not in the claim query"
);
assert(
  /ORDER\s+BY\s+at\s+ASC/i.test(claimBlock),
  "ORDER BY at ASC is INSIDE the claim query",
  "ORDER BY at ASC appeared elsewhere but not in the claim query"
);

// 5. SKIP LOCKED must come AFTER LIMIT (Postgres clause order).
{
  const limitIdx = claimBlock.search(/LIMIT\s+\$3/i);
  const lockIdx = claimBlock.search(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  assert(
    limitIdx !== -1 && lockIdx !== -1 && lockIdx > limitIdx,
    "FOR UPDATE SKIP LOCKED comes AFTER LIMIT $3 (Postgres clause order)",
    "limitIdx=" + limitIdx + ", lockIdx=" + lockIdx
  );
}

// 6. Crashed-worker recovery: orphaned 'sending' rows are re-queued so a
//    process death mid-dispatch never loses a notification forever.
assert(
  /UPDATE\s+notifications\s+SET\s+status\s*=\s*'queued'[\s\S]{0,160}WHERE\s+status\s*=\s*'sending'/i.test(raw),
  "recovers orphaned 'sending' rows back to 'queued' (crash recovery)",
  "expected an `UPDATE notifications SET status='queued' ... WHERE status='sending'` recovery statement"
);

// 7. Re-entrancy guard: a module-level `running` flag prevents overlapping
//    ticks (double-send under a slow provider), reset in a finally.
assert(
  /\blet\s+running\s*=\s*false\b/.test(raw) &&
  /if\s*\(\s*running\s*\)\s*return\s*;/.test(raw) &&
  /finally\s*\{[\s\S]*?running\s*=\s*false/.test(raw),
  "has a module-level `running` re-entrancy guard reset in a finally",
  "expected `let running = false`, an `if (running) return;` guard, and `running = false` in a finally"
);
