// tests/core/no-payments-table-readers.test.js
//
// Theme 1, sub-issue C regression guard.
//
// The legacy `payments` table was dropped by migration 042 and the deleted
// boot script src/migrate_mobile_api.js was re-creating it empty on every
// cold start. The mobile API readers (routes/api/cases.js + profile.js)
// were migrated to source the same fields from `orders`.
//
// This test asserts no source file SELECTs / INSERTs / UPDATEs / JOINs the
// dead `payments` table. Comments and migration files referencing the
// table by name are allowed — only live SQL queries are flagged.

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧹 no source file reads from the deprecated payments table (Theme 1, C)\n');

const SRC = path.join(__dirname, '..', '..', 'src');

try {
  // SQL keywords that touch a table name in the canonical sense.
  // Excluded: payment_events, paymob_*, appointment_payments, payment_status,
  // payment_link, payment_method, payment_reference (all distinct names).
  const hits = execSync(
    "grep -rnE '(FROM|INTO|UPDATE|JOIN)\\s+payments\\b' --include='*.js' " + SRC + " || true",
    { encoding: 'utf8' }
  ).trim();

  if (hits) {
    throw new Error('Source still reads from `payments` table:\n' + hits);
  }
  t.pass('no source file references the deprecated `payments` table in SQL');
} catch (e) { t.fail('payments table grep', e); }
