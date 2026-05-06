// tests/core/no-orders-urgent.test.js
//
// Theme 1, sub-issue B regression guard.
//
// orders.urgent was migrated → urgency_flag in migration 010. The deleted
// boot script was re-adding it on every cold start. Migration 044 drops
// the column from production. This test asserts no source file references
// orders.urgent (only urgency_flag and unrelated urgenc* tokens are
// permitted).
//
// Pure source-grep — no DB, no boot. Fast.

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧹 no source file references orders.urgent (Theme 1, B)\n');

const SRC = path.join(__dirname, '..', '..', 'src');

try {
  // Two patterns:
  //   - `orders.urgent\b`  (e.g. `o.urgent`, `orders.urgent`)
  //   - `\.urgent\s*=`     (e.g. `urgent = true` setter)
  // Filter out urgency_*, urgent_uplift, urgent_window, isUrgentWindowOpen, etc.
  const hits = execSync(
    "grep -rnE '(\\borders\\.urgent\\b|\\.urgent\\s*=)' --include='*.js' --include='*.sql' " + SRC +
      " | grep -vE 'urgency|urgent_(uplift|window|tier|amount)|isUrgent|markUrgent|urgentTier|urgentMode' || true",
    { encoding: 'utf8' }
  ).trim();

  // Migrations 010 and 044 legitimately reference the column to drop it.
  const filtered = hits
    .split('\n')
    .filter(function (line) {
      if (!line) return false;
      if (/migrations[\\/]010_broadcast_system\.sql/.test(line)) return false;
      if (/migrations[\\/]043_codify_mobile_api_schema\.sql/.test(line)) return false;
      if (/migrations[\\/]044_drop_orders_urgent\.sql/.test(line)) return false;
      if (/migrations[\\/]046_cleanup_legacy_zombies\.sql/.test(line)) return false;
      return true;
    });

  if (filtered.length) {
    throw new Error('Source still references orders.urgent:\n' + filtered.join('\n'));
  }
  t.pass('no source file references orders.urgent');
} catch (e) { t.fail('orders.urgent grep', e); }
