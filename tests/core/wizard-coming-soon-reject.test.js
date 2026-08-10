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

// Neither step3 nor step4 order-blocking lookup may still use the old
// visibility-only clause inside a `WHERE sv.id = $` guard.
try {
  // Match the two literal SELECT fragments we are replacing.
  const stillVisibleOnly =
    /WHERE sv\.id = \$1 AND \$\{visibleClause\}/.test(src) ||
    /WHERE sv\.id = \$2 AND \$\{visibleClause\}/.test(src);
  if (stillVisibleOnly) {
    throw new Error('A wizard service lookup still uses ${visibleClause} — must be the bookable clause.');
  }
  t.pass('no wizard service lookup uses the visibility-only clause');
} catch (e) { t.fail('wizard-coming-soon-reject: no visibility-only lookup', e); }
