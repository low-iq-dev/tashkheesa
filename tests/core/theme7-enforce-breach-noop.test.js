// tests/core/theme7-enforce-breach-noop.test.js
//
// Theme 7 sub-issue B regression guard.
//
// Asserts that sla_status.enforceBreachIfNeeded is now a no-op with a
// deprecation comment, and that the 7 inline call sites still exist
// (the function is kept callable so a follow-up PR can delete the call
// sites mechanically — a deletion now would risk a runtime crash if any
// caller depended on the return value).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💤 Theme 7 sub-B — enforceBreachIfNeeded no-op + call sites preserved\n');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
function read(p) { return fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'); }

// 1. sla_status.enforceBreachIfNeeded body is a `return null;` no-op.
try {
  const slaStatus = read('sla_status.js');
  const start = slaStatus.indexOf('async function enforceBreachIfNeeded(');
  if (start < 0) throw new Error('enforceBreachIfNeeded not found in sla_status.js');
  const after = slaStatus.slice(start);
  const end = after.indexOf('\n}\n');
  const body = end > 0 ? after.slice(0, end + 2) : after;

  // Body must NOT contain a real UPDATE on orders.
  if (/UPDATE\s+orders/i.test(body)) {
    throw new Error('enforceBreachIfNeeded body still contains UPDATE orders');
  }
  // Body must NOT call issueBreachRefundSafe (that responsibility moved
  // to case_lifecycle.markSlaBreach).
  if (/issueBreachRefundSafe/.test(body)) {
    throw new Error('enforceBreachIfNeeded still calls issueBreachRefundSafe (now belongs to markSlaBreach)');
  }
  // Body must be a `return null` no-op.
  if (!/return null;/.test(body)) {
    throw new Error('enforceBreachIfNeeded body is not a `return null;` no-op');
  }
  t.pass('enforceBreachIfNeeded body is a `return null;` no-op');
} catch (e) { t.fail('enforce-breach-noop-body', e); }

// 2. Deprecation comment present and references Theme 7 sub-issue B.
try {
  const slaStatus = read('sla_status.js');
  if (!/DEPRECATED — Theme 7 sub-issue B/.test(slaStatus)) {
    throw new Error('sla_status.js missing DEPRECATED Theme 7 marker comment');
  }
  if (!/case_sla_worker\.runCaseSlaSweep/.test(slaStatus)) {
    throw new Error('deprecation comment does not point to canonical case_sla_worker.runCaseSlaSweep');
  }
  if (!/30 days/.test(slaStatus)) {
    throw new Error('deprecation comment does not specify the 30-day stability window before deletion');
  }
  t.pass('deprecation comment present, references canonical worker + 30-day deletion window');
} catch (e) { t.fail('enforce-breach-deprecation-comment', e); }

// 3. All 7 inline call sites still exist (call surface preserved per the
//    user's explicit request — delete in a follow-up PR).
const EXPECTED_CALL_SITES = [
  { file: 'routes/admin.js',       count: 2 },
  { file: 'routes/doctor.js',      count: 1 },
  { file: 'routes/patient.js',     count: 2 },
  { file: 'routes/superadmin.js',  count: 2 }
];

let totalCalls = 0;
for (const cs of EXPECTED_CALL_SITES) {
  try {
    const content = read(cs.file);
    // Match invocation patterns: `enforceBreachIfNeeded(` (with paren).
    // The destructured import line uses `enforceBreachIfNeeded }` (no
    // paren) so it does not match this regex — we count call sites
    // directly without subtracting.
    const matches = content.match(/enforceBreachIfNeeded\(/g) || [];
    const callCount = matches.length;
    if (callCount < cs.count) {
      throw new Error(
        cs.file + ' has ' + callCount + ' enforceBreachIfNeeded call sites, expected at least ' + cs.count
      );
    }
    totalCalls += callCount;
    t.pass(cs.file + ' preserves ≥ ' + cs.count + ' enforceBreachIfNeeded call site(s) (found ' + callCount + ')');
  } catch (e) { t.fail('callsite: ' + cs.file, e); }
}

try {
  if (totalCalls < 7) {
    throw new Error('total enforceBreachIfNeeded call sites = ' + totalCalls + ', expected ≥ 7');
  }
  t.pass('total enforceBreachIfNeeded call sites preserved: ' + totalCalls + ' (≥ 7)');
} catch (e) { t.fail('total-callsites', e); }

// 4. enforceBreachIfNeeded export shape preserved (callers do destructured imports).
try {
  const slaStatus = read('sla_status.js');
  if (!/module\.exports\s*=\s*\{[\s\S]*?enforceBreachIfNeeded[\s\S]*?\}/.test(slaStatus)) {
    throw new Error('sla_status.js export shape lost — enforceBreachIfNeeded no longer exported');
  }
  t.pass('sla_status.js still exports enforceBreachIfNeeded (callers can keep destructured imports)');
} catch (e) { t.fail('export-shape', e); }
