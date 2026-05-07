// tests/core/theme5-mark-paid-pool-discipline.test.js
//
// Theme 5 sub-issue A regression guard.
//
// Asserts via source inspection that markCasePaid threads its txn `client`
// through every helper it calls inside withTransaction:
//
//   * Every helper called inside the markCasePaid txn block passes `client`.
//   * The helper signatures themselves accept `client` as the trailing
//     optional positional parameter.
//   * The previously-stray `execute(UPDATE notifications…)` call inside
//     the txn has been replaced with `client.query(...)`.
//
// Source-grep style — matches the Theme 1 / Theme 3 lint-test pattern.
// Catches the regression class where someone refactors and silently
// drops the `client` argument on a helper.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🪣 Theme 5 — markCasePaid pool discipline (source check)\n');

const SRC = path.join(__dirname, '..', '..', 'src', 'case_lifecycle.js');
const src = fs.readFileSync(SRC, 'utf8');

// Helper signatures that MUST accept `client` as a trailing optional arg.
const SIGNATURES = [
  { name: 'getCase',                     re: /async function getCase\(caseIdOrParams,\s*client\)/ },
  { name: 'updateCase',                  re: /async function updateCase\(caseId,\s*fields,\s*client\)/ },
  { name: 'logCaseEvent',                re: /async function logCaseEvent\(caseId,\s*eventType,\s*payload[^,]*,\s*client\)/ },
  { name: 'triggerNotification',         re: /async function triggerNotification\(caseId,\s*type,\s*payload,\s*client\)/ },
  { name: 'transitionCase',              re: /async function transitionCase\(caseId,\s*nextStatus,\s*data[^,]*,\s*client\)/ },
  { name: 'closeOpenDoctorAssignments',  re: /async function closeOpenDoctorAssignments\(caseId,\s*client\)/ },
  { name: 'dispatchSlaReminders',        re: /async function dispatchSlaReminders\(caseIdOrRow,\s*opts[^,]*,\s*client\)/ }
];

for (const sig of SIGNATURES) {
  try {
    if (!sig.re.test(src)) {
      throw new Error('helper "' + sig.name + '" does not accept `client` as expected — signature drifted');
    }
    t.pass(sig.name + ' accepts optional `client` parameter');
  } catch (e) { t.fail('signature: ' + sig.name, e); }
}

// Extract the markCasePaid body (between its `async function` line and the
// next top-level `async function`). Then assert every internal helper call
// passes `client`.
const mcpStart = src.indexOf('async function markCasePaid(caseId) {');
if (mcpStart < 0) {
  t.fail('markCasePaid', new Error('markCasePaid function not found'));
} else {
  // Take a generous slice and stop at the next async function declaration.
  const after = src.slice(mcpStart);
  const nextFn = after.search(/\nasync function /);
  const mcpBody = nextFn > 0 ? after.slice(0, nextFn) : after;

  const REQUIRED_THREADED_CALLS = [
    { label: 'transitionCase(... , client)',         re: /transitionCase\([\s\S]*?\},\s*client\)/ },
    // markCasePaid body has 2 direct logCaseEvent calls (PAYMENT_CONFIRMED,
    // CASE_READY_FOR_ASSIGNMENT). The 3rd lands via triggerNotification
    // and is asserted separately below.
    { label: 'logCaseEvent(... , client) (×2 direct)', re: /logCaseEvent\([\s\S]*?,\s*client\)/g, minMatches: 2 },
    { label: 'triggerNotification(... , client)',    re: /triggerNotification\([\s\S]*?,\s*client\)/ },
    { label: 'dispatchSlaReminders(... , {}, client)', re: /dispatchSlaReminders\(caseId,\s*\{\},\s*client\)/ },
    { label: 'getCase(caseId, client) (final)',      re: /return\s+await\s+getCase\(caseId,\s*client\)/ },
    // The notifications cancellation must be on the txn client, not the pool.
    { label: 'client.query(`UPDATE notifications`)', re: /client\.query\(\s*`UPDATE notifications/ }
  ];

  for (const c of REQUIRED_THREADED_CALLS) {
    try {
      if (c.minMatches) {
        const matches = mcpBody.match(c.re) || [];
        if (matches.length < c.minMatches) {
          throw new Error('expected at least ' + c.minMatches + ' threaded ' +
            c.label + ' calls, found ' + matches.length);
        }
      } else if (!c.re.test(mcpBody)) {
        throw new Error('markCasePaid body missing threaded call: ' + c.label);
      }
      t.pass('markCasePaid threads: ' + c.label);
    } catch (e) { t.fail('threaded: ' + c.label, e); }
  }

  // Belt-and-suspenders: forbid module-level `await execute(`...`)` inside the
  // markCasePaid body — it would mean a helper bypassed the txn.
  try {
    if (/\bawait\s+execute\(/.test(mcpBody)) {
      throw new Error('markCasePaid body still contains `await execute(...)` — must use client.query inside the txn');
    }
    t.pass('markCasePaid body uses client.query exclusively (no module-pool execute)');
  } catch (e) { t.fail('no module-pool execute', e); }
}
