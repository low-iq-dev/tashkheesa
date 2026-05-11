// tests/core/theme8-notification-worker-skip-locked.test.js
//
// Theme 8 Phase 4-D regression guard — notification_worker SELECT must
// include `FOR UPDATE SKIP LOCKED` (deferred from Theme 6 sub-issue D
// per OQ-5). ORDER BY at ASC must stay for FIFO.
//
// Forensic context: single-instance Render deploy makes SKIP LOCKED a
// no-op today (no contention). It activates the moment a second
// instance spins up — scale-out test, accidental dual deploy, manual
// one-off worker. Without SKIP LOCKED, two workers would both grab
// the same rows under the FOR UPDATE clause; without the clause, they
// could even dispatch duplicate notifications.
//
// Pairs with Theme 6 sub-issue A's SLA_MODE=primary worker gating —
// SKIP LOCKED is defense-in-depth if that gate ever fails.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔒 Theme 8 Phase 4-D — notification_worker SELECT uses FOR UPDATE SKIP LOCKED\n');

const NOTIFY_WORKER = path.join(__dirname, '..', '..', 'src', 'notification_worker.js');
let raw = '';
try { raw = fs.readFileSync(NOTIFY_WORKER, 'utf8'); }
catch (e) { t.fail(fileTag + ': read notification_worker.js', e); }

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// 1. The SELECT clause includes FOR UPDATE SKIP LOCKED.
assert(
  /FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(raw),
  "notification_worker SELECT contains FOR UPDATE SKIP LOCKED",
  "missing FOR UPDATE SKIP LOCKED — required to safely scale to >1 worker instance"
);

// 2. ORDER BY at ASC is preserved (FIFO).
assert(
  /ORDER\s+BY\s+at\s+ASC/i.test(raw),
  "notification_worker SELECT preserves ORDER BY at ASC (FIFO)",
  "ORDER BY at ASC removed — FIFO regression"
);

// 3. SKIP LOCKED is INSIDE the same SELECT that has ORDER BY at ASC and
//    the queued/retry filter. Catches a future refactor that moves SKIP
//    LOCKED to a different query.
{
  // Find the SELECT * FROM notifications block, capture up to the next
  // semicolon or backtick close, and assert all three clauses live
  // together.
  const selectRe = /SELECT\s+\*\s+FROM\s+notifications[\s\S]*?(?:;|`)/i;
  const m = raw.match(selectRe);
  const block = m ? m[0] : '';
  assert(
    /WHERE\s+status\s+IN\s*\(\s*'queued',\s*'retry'\s*\)/i.test(block),
    "notification_worker SELECT filters status IN ('queued','retry')",
    "expected status filter; block=" + block.slice(0, 120)
  );
  assert(
    /FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(block),
    "SKIP LOCKED is INSIDE the queued/retry SELECT (not a different query)",
    "SKIP LOCKED appeared elsewhere in file but not in the main fetch query"
  );
  assert(
    /ORDER\s+BY\s+at\s+ASC/i.test(block),
    "ORDER BY at ASC is INSIDE the queued/retry SELECT",
    "ORDER BY at ASC appeared elsewhere but not in the main fetch query"
  );
  // SKIP LOCKED must come AFTER LIMIT (Postgres syntax requirement).
  const limitIdx = block.search(/LIMIT\s+\$2/i);
  const lockIdx = block.search(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  assert(
    limitIdx !== -1 && lockIdx !== -1 && lockIdx > limitIdx,
    "FOR UPDATE SKIP LOCKED comes AFTER LIMIT $2 (Postgres clause order)",
    "limitIdx=" + limitIdx + ", lockIdx=" + lockIdx
  );
}
