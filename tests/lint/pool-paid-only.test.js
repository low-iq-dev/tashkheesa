'use strict';
// Launch day 2026-09-25 — the doctor pool lists PAID work only.
//
// TSH-2026-000014 (submitted, unpaid) sat in every paediatrician's pool for
// three days because the four pool queries took status from
// UNACCEPTED_STATUSES ('new', 'submitted', ...) with no payment test, while the
// case-access gate (isPaidForReview) refused Accept. These pins keep the list
// and the gate on the same predicate.
//
// Runner-harness style (global._testRunner), same as batch-a2-routing-pins.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
function check(name, fn) {
  try { fn(); t.pass(name); } catch (err) { t.fail(name, err); }
}

console.log('\n📌 Doctor pool — paid work only\n');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/routes/doctor.js'), 'utf8');
const access = fs.readFileSync(path.join(ROOT, 'src/services/doctor_case_access.js'), 'utf8');

function sliceFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

check('POOL_PAID_SQL is the same paid/captured test as isPaidForReview', () => {
  assert.ok(src.includes(`const POOL_PAID_SQL = "LOWER(COALESCE(o.payment_status, '')) IN ('paid', 'captured')";`),
    'POOL_PAID_SQL changed or was removed');
  assert.ok(/status === 'paid' \|\| status === 'captured'/.test(access),
    'isPaidForReview no longer accepts exactly paid/captured — update POOL_PAID_SQL with it');
});

for (const fn of ['countPortalCasesUnassigned', 'buildPortalCasesUnassigned', 'countQueueNewCases', 'buildQueueNewCasesPaged']) {
  check(`${fn}: the pool arm carries the payment gate`, () => {
    const body = sliceFunction(fn);
    assert.ok(body.includes('AND ${POOL_PAID_SQL}'), `${fn} lost the paid-only gate on its pool arm`);
  });
}
