// tests/lint/paused-doctors-excluded-everywhere.test.js
//
// A5 (AUDIT 2026-09-09) — a paused doctor must be excluded from broadcast AND
// from every assignment path. Auto-pause fires on 3 SLA breaches in 30 days with
// NO human in the loop, so this invariant goes live on its own shortly after
// launch: the day it fires, a paused doctor must stop being handed new cases.
//
// broadcast.js was the one site that did not filter is_paused (fixed in the A3
// commit). Every other assignment site already filtered it — this lint pins the
// invariant at ALL of them so none can silently drop it again. Each site either
// carries an explicit `COALESCE(is_paused,false)=false` SQL clause, delegates to
// the shared eligibleDoctorClause (which emits it), or filters it in JS.
//
// Pure source-grep — runs with no DB. Verified NEGATIVELY: deleting the
// is_paused clause from any listed site fails its assertion.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n⏸️  A5 — paused doctors excluded from broadcast + every assignment path\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// Accept any of the three shapes a site legitimately uses to exclude a paused
// doctor: the SQL clause (aliased or bare), delegation to the shared clause, or
// a JS-side skip.
function excludesPaused(src, { allowClause = true, allowShared = true, allowJs = false } = {}) {
  // Any prefix inside COALESCE before is_paused: `u.`, bare, or a `${a}.`
  // template-literal alias (the shared clause builds the SQL as a string).
  if (allowClause && /COALESCE\([^)]*is_paused,\s*false\)\s*=\s*false/.test(src)) return true;
  if (allowShared && /eligibleDoctorClause\s*\(/.test(src)) return true;
  if (allowJs && /is_paused/.test(src) && /continue|return|skip/.test(src)) return true;
  return false;
}

const SITES = [
  ['broadcast (open pool)', 'src/notify/broadcast.js', { allowShared: false }],
  ['single-assign pick', 'src/assign.js', { allowShared: false }],
  ['auto-assign', 'src/auto_assign.js', { allowShared: false }],
  ['shared eligibility clause', 'src/services/doctor_eligibility.js', { allowShared: false }],
  ['SLA-breach alternate picker', 'src/case_sla_worker.js', {}],
  ['capacity-overflow next doctor', 'src/routes/doctor.js', { allowShared: false }],
  ['bulk assign', 'src/services/admin_bulk_assign.js', { allowClause: false, allowShared: false, allowJs: true }],
];

for (const [label, rel, opts] of SITES) {
  check(label + ' excludes paused doctors', () => {
    if (!excludesPaused(code(rel), opts)) return rel + ' has no is_paused exclusion';
  });
}

// The shared clause itself must keep emitting the predicate — it is the single
// source of truth for the sites that delegate to it.
check('eligibleDoctorClause still emits the is_paused predicate', () => {
  const src = code('src/services/doctor_eligibility.js');
  if (!/is_paused,\s*false\)\s*=\s*false/.test(src)) return 'eligibleDoctorClause dropped is_paused';
});
