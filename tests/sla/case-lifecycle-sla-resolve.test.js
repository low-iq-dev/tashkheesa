// tests/sla/case-lifecycle-sla-resolve.test.js
//
// Transition-state test for the case_lifecycle SLA refactor
// (P1-PATIENT-1 Deploy 1 commit 3).
//
// Asserts that resolveSlaHoursForCase — the helper that replaces the
// SLA_HOURS[slaType] string lookup inside markCasePaid() — handles
// every shape of orders.sla_hours we expect during the Deploy 1 →
// Deploy 2 transition window AND the post-Deploy-2 steady state.
//
// Deploy 1 (this PR) drops the slaType arg from markCasePaid(); the
// function reads orders.sla_hours from the row instead.  But the
// patient wizard is NOT rewritten in this PR — it still writes the
// legacy 2-tier shape: urgency_tier='priority' / sla_hours=24, or
// 'standard' / sla_hours=72.  The transition test is what guarantees
// that Deploy 1 doesn't break payments-in-flight authored against
// the old wizard.
//
// Deploy 2 will rewrite the wizard to write canonical
// 'standard'/'vip'/'urgent' tiers + policy-aligned sla_hours
// (48/18/4) per docs/PAYOUT_AND_URGENCY_POLICY.md §2.
// resolveSlaHoursForCase passes those values through unchanged.
//
// Default fallback: 48 (canonical Standard from policy §2).  Applied
// when sla_hours is NULL, undefined, 0, or non-finite — i.e., legacy
// DRAFT rows that never reached Step 4, or pre-wizard mobile-API
// rows.  Documented choice from the planning pass: lean Standard,
// not Priority, so missing data never accidentally accelerates SLA.
//
// Pure unit test — no DB required.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n⏱️  case_lifecycle SLA resolution (transition-state)\n');

const { resolveSlaHoursForCase } = require('../../src/case_lifecycle');

function run(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── Default fallback ──────────────────────────────────────────────

run('NULL sla_hours → 48 (policy §2 Standard default)', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard', sla_hours: null });
  assert.strictEqual(h, 48);
});

run('undefined sla_hours → 48', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard' });
  assert.strictEqual(h, 48);
});

run('null orderRow → 48', function () {
  const h = resolveSlaHoursForCase(null);
  assert.strictEqual(h, 48);
});

run('zero sla_hours → 48 (treat 0 as unset)', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard', sla_hours: 0 });
  assert.strictEqual(h, 48);
});

run('negative sla_hours → 48', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard', sla_hours: -1 });
  assert.strictEqual(h, 48);
});

// ── Deploy 1 ↔ Deploy 2 transition: legacy 2-tier wizard rows ──

run('legacy 2-tier wizard standard order (sla_hours=72) → 72 honored', function () {
  // Pre-Deploy-2 wizard at patient.js:1499 writes sla_hours=72 for "standard".
  // markCasePaid must honor what the patient was promised at booking.
  // Deploy 2 will start writing 48 instead.
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard', sla_hours: 72 });
  assert.strictEqual(h, 72);
});

run('legacy 2-tier wizard priority order (urgency_tier=priority, sla_hours=24) → 24 honored', function () {
  // Pre-Deploy-2 wizard writes urgency_tier='priority' + sla_hours=24.
  // markCasePaid honors 24h — the patient was promised a 24h turnaround.
  // The 'priority' → 'vip' canonicalization is a Deploy 2 concern, not
  // markCasePaid's concern.  The deadline computed downstream from this
  // row will be paid_at + 24h.
  const h = resolveSlaHoursForCase({ urgency_tier: 'priority', sla_hours: 24 });
  assert.strictEqual(h, 24);
});

// ── Post-Deploy-2 canonical shapes ────────────────────────────────

run('post-Deploy-2 standard order (sla_hours=48) → 48', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'standard', sla_hours: 48 });
  assert.strictEqual(h, 48);
});

run('post-Deploy-2 vip order (sla_hours=18) → 18', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'vip', sla_hours: 18 });
  assert.strictEqual(h, 18);
});

run('post-Deploy-2 urgent order (sla_hours=4) → 4', function () {
  const h = resolveSlaHoursForCase({ urgency_tier: 'urgent', sla_hours: 4 });
  assert.strictEqual(h, 4);
});
