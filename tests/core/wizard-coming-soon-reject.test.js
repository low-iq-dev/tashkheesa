// tests/core/wizard-coming-soon-reject.test.js
//
// Coming Soon guard — web wizard (spec §4.5). Both the step3 service-belongs
// check and the step4 pricing lookup MUST gate on servicesBookableClause
// (visible AND not coming_soon), not the old visibility-only clause. A live
// wizard POST needs an authenticated patient + a DRAFT order + a DB that does
// NOT boot locally (migration 070 needs a Supabase anon role), so this is a
// source-grep guard: it fails if either step reverts to servicesVisibleClause
// for the order-blocking lookup.
'use strict';
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛑 web wizard steps gate on servicesBookableClause (Coming Soon §4.5)\n');

const SRC = path.join(__dirname, '..', '..', 'src', 'routes', 'patient.js');
const src = fs.readFileSync(SRC, 'utf8');

// How many times the ORDER-BLOCKING service lookups (step3 + step4) call the
// bookable clause. Must be >= 2 (one per wizard step).
const bookableCalls = (src.match(/servicesBookableClause\(['"]sv['"]\)/g) || []).length;

try {
  if (bookableCalls < 2) {
    throw new Error(
      'Expected >= 2 servicesBookableClause(\'sv\') calls in patient.js wizard ' +
      '(step3 + step4); found ' + bookableCalls + '. Coming Soon guard missing.'
    );
  }
  t.pass('both wizard service lookups call servicesBookableClause (found ' + bookableCalls + ')');
} catch (e) { t.fail('wizard-coming-soon-reject: bookable clause present', e); }

// Neither step3 nor step4 POST handler body may use the old visibility-only
// clause in a `WHERE sv.id = $` guard.  We scope the check to each handler
// body only (from its `router.post(…)` line up to — but not including — the
// next `router.post(` boundary) so dead or unrelated code elsewhere cannot
// force false positives or require unnecessary churn.
try {
  // Extract the step3 POST handler body.
  const step3Start = src.indexOf("router.post('/patient/new-case/step3'");
  const step3End   = src.indexOf("router.post('/patient/new-case/step4'", step3Start + 1);
  const step3Body  = step3Start !== -1 && step3End !== -1
    ? src.slice(step3Start, step3End)
    : '';

  // Extract the step4 POST handler body (up to the next router.post boundary).
  const step4Start = src.indexOf("router.post('/patient/new-case/step4'");
  const step4End   = src.indexOf("router.post('/patient/new-case/step4/urgency-resolve'", step4Start + 1);
  const step4Body  = step4Start !== -1 && step4End !== -1
    ? src.slice(step4Start, step4End)
    : '';

  if (!step3Body || !step4Body) {
    throw new Error('Could not locate step3/step4 POST handler bodies — route anchors may have changed.');
  }

  const visibleOnlyPattern = /WHERE sv\.id = \$\d AND \$\{visibleClause\}/;
  const step3StillVisible  = visibleOnlyPattern.test(step3Body);
  const step4StillVisible  = visibleOnlyPattern.test(step4Body);

  if (step3StillVisible || step4StillVisible) {
    const who = [step3StillVisible && 'step3', step4StillVisible && 'step4'].filter(Boolean).join(' and ');
    throw new Error(who + ' service lookup(s) still use ${visibleClause} — must be the bookable clause.');
  }
  t.pass('neither step3 nor step4 POST handler uses the visibility-only clause');
} catch (e) { t.fail('wizard-coming-soon-reject: no visibility-only lookup in step3/step4', e); }
