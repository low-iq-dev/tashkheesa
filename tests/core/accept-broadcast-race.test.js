// tests/core/accept-broadcast-race.test.js
//
// A7 (AUDIT 2026-09-09) — accepting a broadcast case must be a race only ONE
// doctor can win. assignDoctor set orders.doctor_id through transitionCase with
// no predicate, so two doctors accepting the same PAID broadcast could BOTH walk
// PAID -> ASSIGNED and BOTH fire notifyCaseAssigned — the patient got two
// "assigned to Dr X" emails, and the loser saw a bland bounce. The accept path's
// comment claimed a "doctor_id != $5 check" guarded this; it does not exist.
//
// The fix is an optimistic claim in assignDoctor's FIRST-assignment path
// (WHERE doctor_id IS NULL OR doctor_id = $1) — atomically serialized by
// Postgres, no wrapping txn, no deadlock. The loser's claim matches 0 rows and
// throws CASE_ALREADY_TAKEN BEFORE the transition / email; the accept handler
// turns that into an "already taken" message, not accept_failed.
//
// Source-grep (the change is a guarded SQL write; the local DB is unmigrated so
// a live-DB race test would skip). Verified NEGATIVELY: dropping the predicate
// and dropping the 0-row throw each fail the matching assertion.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🏁 A7 — only one doctor wins a broadcast accept\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

// Carve out assignDoctor.
const cl = code('src/case_lifecycle.js');
const aStart = cl.indexOf('async function assignDoctor');
const aEnd = cl.indexOf('\nasync function reassignCase');
const assignBody = aStart >= 0 && aEnd > aStart ? cl.slice(aStart, aEnd) : '';

check('assignDoctor carries the optimistic claim on the first assignment', () => {
  if (!assignBody) return 'assignDoctor not found';
  if (!/wasInitialAssignment/.test(assignBody)) return 'no first-assignment gate';
  // The claim UPDATE must set doctor_id under the IS-NULL-or-mine predicate.
  if (!/UPDATE\s+\$\{CASE_TABLE\}\s+SET\s+doctor_id\s*=\s*\$1[\s\S]*?doctor_id IS NULL OR doctor_id = \$1/.test(assignBody)) {
    return 'no guarded claim UPDATE (doctor_id IS NULL OR doctor_id = $1)';
  }
});

check('a lost claim throws CASE_ALREADY_TAKEN before the transition/email', () => {
  // The throw must be gated on a 0-row claim, and sit BEFORE the transition.
  if (!/rowCount === 0[\s\S]*?CASE_ALREADY_TAKEN/.test(assignBody)) {
    return 'the 0-row claim does not throw CASE_ALREADY_TAKEN';
  }
  const claimIdx = assignBody.indexOf('CASE_ALREADY_TAKEN');
  const transitionIdx = assignBody.indexOf('transitionCase(caseId, CASE_STATUS.ASSIGNED');
  const emailIdx = assignBody.indexOf('notifyCaseAssigned');
  if (transitionIdx >= 0 && claimIdx > transitionIdx) return 'claim throw is AFTER the transition — loser would still transition';
  if (emailIdx >= 0 && claimIdx > emailIdx) return 'claim throw is AFTER the patient email — loser would still email';
});

check('a REASSIGNED hand-off is exempt from the claim (not a race)', () => {
  // The claim is inside `if (wasInitialAssignment)`, and wasInitialAssignment is
  // (currentStatus === PAID) — so a REASSIGNED transition never claims.
  if (!/if \(wasInitialAssignment\) \{[\s\S]*?doctor_id IS NULL OR doctor_id = \$1/.test(assignBody)) {
    return 'the claim is not gated on wasInitialAssignment';
  }
});

// Accept handler turns the loss into a message, not an error.
const doc = code('src/routes/doctor.js');
check('accept handler shows "already taken" for the loser, not accept_failed', () => {
  if (!/err && err\.code === 'CASE_ALREADY_TAKEN'/.test(doc)) return 'accept catch does not special-case CASE_ALREADY_TAKEN';
  if (!/\?msg=already_taken/.test(doc)) return 'loser is not redirected with msg=already_taken';
  // The already_taken branch must render bilingual copy on the case page.
  if (!/msg === 'already_taken'/.test(doc)) return 'case page does not render the already_taken message';
  const idx = doc.indexOf("msg === 'already_taken'");
  const branch = doc.slice(idx, idx + 300);
  if (!/isAr/.test(branch)) return 'already_taken message is not bilingual';
});
