// tests/core/theme7-enforce-breach-noop.test.js
//
// Theme 7 sub-issue B regression guard.
//
// HISTORY — this file used to assert that sla_status.enforceBreachIfNeeded was
// a `return null;` no-op AND that all 7 inline call sites were still present.
// That second half was a deliberately temporary contract: the function was
// neutered in May 2026 but left callable for one release so nothing crashed,
// with deletion scheduled after 30 days of stable canonical-worker behaviour.
//
// The window passed. Two of the call sites went in the Phase 2 superadmin
// dashboard perf rework; the remaining five and the no-op itself were deleted
// on 2026-08-16. The old assertions were therefore pinning a migration
// half-step in place — a test demanding that dead code stay in the tree.
//
// What this file guards now is the thing that actually matters and did not
// change: breach detection and state mutation happen in exactly ONE place,
// case_sla_worker.runCaseSlaSweep. If anyone reintroduces a page-load breach
// write — under this name or any other — these assertions fail.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💤 Theme 7 sub-B — breach writes live only in the canonical worker\n');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
function read(p) { return fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'); }

// 1. enforceBreachIfNeeded is fully gone — no definition, no export, no callers.
try {
  const slaStatus = read('sla_status.js');
  if (/function\s+enforceBreachIfNeeded\s*\(/.test(slaStatus)) {
    throw new Error('enforceBreachIfNeeded has been reintroduced in sla_status.js');
  }
  if (/module\.exports\s*=\s*\{[^}]*enforceBreachIfNeeded/.test(slaStatus)) {
    throw new Error('sla_status.js exports enforceBreachIfNeeded again');
  }
  t.pass('enforceBreachIfNeeded is gone from sla_status.js (definition + export)');
} catch (e) { t.fail('enforce-breach-removed', e); }

// 2. No route file calls it any more.
const ROUTE_FILES = [
  'routes/admin.js',
  'routes/doctor.js',
  'routes/patient.js',
  'routes/superadmin.js'
];
try {
  const offenders = [];
  for (const rel of ROUTE_FILES) {
    const content = read(rel);
    // `enforceBreachIfNeeded(` = an invocation. The word also appears in
    // explanatory comments (routes/admin.js, routes/superadmin.js) — those
    // carry no open paren and are intentionally left as history.
    const calls = (content.match(/enforceBreachIfNeeded\s*\(/g) || []).length;
    if (calls > 0) offenders.push(rel + ' (' + calls + ')');
    // The destructured import must be gone too, or the module would throw
    // on a call that no longer exists.
    if (/enforceBreachIfNeeded\s*\}?\s*=\s*require/.test(content) ||
        /\{[^}]*enforceBreachIfNeeded[^}]*\}\s*=\s*require\(/.test(content)) {
      offenders.push(rel + ' (still imports it)');
    }
  }
  if (offenders.length) {
    throw new Error('page-load breach enforcement reintroduced in: ' + offenders.join(', '));
  }
  t.pass('no route file calls or imports enforceBreachIfNeeded (' + ROUTE_FILES.length + ' checked)');
} catch (e) { t.fail('no-page-load-breach-calls', e); }

// 3. The deletion rationale is recorded where the function used to be, so the
//    next person to wonder "why is there no single-order breach helper?" finds
//    the answer instead of writing one.
try {
  const slaStatus = read('sla_status.js');
  if (!/Theme 7 sub-issue B/.test(slaStatus)) {
    throw new Error('sla_status.js lost the Theme 7 sub-issue B marker comment');
  }
  if (!/case_sla_worker\.runCaseSlaSweep/.test(slaStatus)) {
    throw new Error('sla_status.js does not point at the canonical case_sla_worker.runCaseSlaSweep');
  }
  t.pass('removal rationale present and points at the canonical worker');
} catch (e) { t.fail('removal-rationale', e); }

// 4. computeSla is still exported — it is pure (read-only projection) and every
//    former caller of the pair still uses it.
try {
  const slaStatus = read('sla_status.js');
  if (!/module\.exports\s*=\s*\{[\s\S]*?computeSla[\s\S]*?\}/.test(slaStatus)) {
    throw new Error('sla_status.js no longer exports computeSla');
  }
  let users = 0;
  for (const rel of ROUTE_FILES) {
    if (/computeSla\s*\(/.test(read(rel))) users++;
  }
  if (users < 3) {
    throw new Error('only ' + users + ' route files call computeSla — expected ≥3. The removal may have taken the projection with it.');
  }
  t.pass('computeSla still exported and used by ' + users + ' route files (read-only projection preserved)');
} catch (e) { t.fail('computesla-preserved', e); }

// 5. The canonical worker still does the write. This is the assertion that
//    would catch "breach enforcement removed everywhere and never replaced".
try {
  const worker = read('case_sla_worker.js');
  if (!/runCaseSlaSweep/.test(worker)) {
    throw new Error('case_sla_worker.js no longer defines runCaseSlaSweep');
  }
  if (!/markSlaBreach/.test(worker)) {
    throw new Error('case_sla_worker.js no longer calls markSlaBreach — nothing enforces breaches at all');
  }
  t.pass('canonical worker still sweeps and calls markSlaBreach');
} catch (e) { t.fail('canonical-worker-intact', e); }
