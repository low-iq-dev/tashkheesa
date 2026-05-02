// tests/services/wizard_pricing.test.js
//
// Unit tests for src/services/wizard_pricing.js — the helper that
// builds the patient new-case wizard's rich `pricing` object for
// Steps 4 + 5 (P1-PATIENT-1 Deploy 2 commit 4).
//
// Pure unit tests. No DB. Always runs.

'use strict';

const assert = require('assert');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💵 services/wizard_pricing\n');

const { buildWizardPricing } = require('../../src/services/wizard_pricing');

function run(name, fn) {
  try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── Three tiers populated with policy multipliers ───────────────

run('three tiers populated with policy multipliers (EGP base 3000)', function () {
  // Worked example A/B/C from docs/PAYOUT_AND_URGENCY_POLICY.md §5.
  const r = buildWizardPricing({
    serviceName: 'Cardiac MR Review',
    localBase: 3000,
    egpBase: 3000,
    localCurrency: 'EGP'
  });
  assert.strictEqual(r.tiers.standard.multiplier, 1.00);
  assert.strictEqual(r.tiers.standard.total.local, 3000);
  assert.strictEqual(r.tiers.standard.uplift.local, 0);
  assert.strictEqual(r.tiers.vip.multiplier, 1.30);
  assert.strictEqual(r.tiers.vip.total.local, 3900);
  assert.strictEqual(r.tiers.vip.uplift.local, 900);
  assert.strictEqual(r.tiers.urgent.multiplier, 1.60);
  assert.strictEqual(r.tiers.urgent.total.local, 4800);
  assert.strictEqual(r.tiers.urgent.uplift.local, 1800);
});

// ── Local + EGP lanes computed independently ────────────────────

run('local + EGP lanes computed independently for non-EGP currency', function () {
  // Hypothetical: 100 SAR local price vs 1500 EGP secondary
  const r = buildWizardPricing({
    serviceName: 'X',
    localBase: 100,
    egpBase: 1500,
    localCurrency: 'SAR'
  });
  assert.strictEqual(r.localCurrency, 'SAR');
  assert.strictEqual(r.showSecondary, true);
  assert.strictEqual(r.base.local, 100);
  assert.strictEqual(r.base.egp, 1500);
  assert.strictEqual(r.tiers.vip.total.local, 130);
  assert.strictEqual(r.tiers.vip.total.egp, 1950);
  assert.strictEqual(r.tiers.urgent.uplift.local, 60);
  assert.strictEqual(r.tiers.urgent.uplift.egp, 900);
});

run('EGP currency hides secondary lane', function () {
  const r = buildWizardPricing({ serviceName: 'X', localBase: 1000, egpBase: 1000, localCurrency: 'EGP' });
  assert.strictEqual(r.showSecondary, false);
});

run('default localCurrency is EGP when missing', function () {
  const r = buildWizardPricing({ serviceName: 'X', localBase: 1000, egpBase: 1000 });
  assert.strictEqual(r.localCurrency, 'EGP');
  assert.strictEqual(r.showSecondary, false);
});

// ── Per-service multiplier overrides ────────────────────────────

run('per-service vip_multiplier override applied', function () {
  const r = buildWizardPricing({
    serviceName: 'X',
    localBase: 1000, egpBase: 1000, localCurrency: 'EGP',
    vipMultiplier: 1.50
  });
  assert.strictEqual(r.tiers.vip.multiplier, 1.50);
  assert.strictEqual(r.tiers.vip.total.local, 1500);
  assert.strictEqual(r.tiers.vip.uplift.local, 500);
});

run('per-service urgent_multiplier override applied', function () {
  const r = buildWizardPricing({
    serviceName: 'X',
    localBase: 1000, egpBase: 1000, localCurrency: 'EGP',
    urgentMultiplier: 2.00
  });
  assert.strictEqual(r.tiers.urgent.multiplier, 2.00);
  assert.strictEqual(r.tiers.urgent.total.local, 2000);
});

run('NULL vip_multiplier falls back to default 1.30', function () {
  const r = buildWizardPricing({
    serviceName: 'X',
    localBase: 1000, egpBase: 1000, localCurrency: 'EGP',
    vipMultiplier: null
  });
  assert.strictEqual(r.tiers.vip.multiplier, 1.30);
});

// ── Edge cases ──────────────────────────────────────────────────

run('zero base price degrades cleanly to zero everywhere', function () {
  const r = buildWizardPricing({ serviceName: 'X', localBase: 0, egpBase: 0, localCurrency: 'EGP' });
  assert.strictEqual(r.tiers.standard.total.local, 0);
  assert.strictEqual(r.tiers.vip.total.local, 0);
  assert.strictEqual(r.tiers.urgent.uplift.local, 0);
});

run('missing args produce a fully-shaped object with zero numbers', function () {
  const r = buildWizardPricing({});
  assert.strictEqual(r.serviceName, '');
  assert.strictEqual(r.localCurrency, 'EGP');
  assert.deepStrictEqual(Object.keys(r.tiers).sort(), ['standard', 'urgent', 'vip']);
  assert.strictEqual(r.tiers.standard.total.local, 0);
});

run('serviceName passed through unchanged', function () {
  const r = buildWizardPricing({ serviceName: 'Cardiac MR Review', localBase: 3000, egpBase: 3000, localCurrency: 'EGP' });
  assert.strictEqual(r.serviceName, 'Cardiac MR Review');
});
