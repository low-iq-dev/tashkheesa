#!/usr/bin/env node
'use strict';

// Phase-2 integration test for the addon abstraction. Runs the full
// lifecycle for each of the three addon types against the live local
// tashkheesa DB and asserts state transitions. Sentinel-prefix cleanup.
//
// Run: node scripts/test_addon_lifecycle.js
// Exit: 0 on success, 1 on any assertion failure.

const assert = require('node:assert/strict');
const reg = require('../src/services/addons/registry');
const {
  createDisposableDoctor,
  createDisposableOrder,
  getAddonService,
  getOrderAddon,
  getEarningsFor,
  cleanupAll,
  closePool
} = require('../src/services/addons/__tests__/_helpers');

async function run() {
  const doctor = await createDisposableDoctor();

  const cases = [
    {
      addonId: 'video_consult',
      fulfillPayload: { appointment_id: 'integ-appt-1', call_duration_seconds: 600 },
      expectEarningsEgp: 160   // 200 * 80%
    },
    {
      addonId: 'prescription',
      fulfillPayload: { pdf_storage_key: 'doctor-prescriptions/integ/1.pdf', text_body: 'Rx: atorvastatin 20 mg' },
      expectEarningsEgp: 320   // 400 * 80%
    }
  ];

  // Has-lifecycle addons: purchase → fulfill → complete → earnings + refund negative path
  for (const c of cases) {
    const order = await createDisposableOrder({ doctorId: doctor.id });
    const svc = reg.getAddon(c.addonId);
    const addonService = await getAddonService(c.addonId);
    if (!svc || !addonService) throw new Error('missing addon ' + c.addonId);

    console.log('→ ' + c.addonId + ': onPurchase');
    const purchased = await svc.onPurchase({ order, addonService, currency: 'EGP' });
    assert.equal(purchased.status, 'paid', c.addonId + ' should be paid after purchase');

    console.log('  ' + c.addonId + ': onFulfill');
    const fulfilled = await svc.onFulfill({ order, addon: purchased, doctor, payload: c.fulfillPayload });
    assert.equal(fulfilled.status, 'fulfilled');

    console.log('  ' + c.addonId + ': onComplete');
    const earnings = await svc.onComplete({ order, addon: fulfilled, doctorId: doctor.id });
    assert.ok(earnings, c.addonId + ' should produce earnings');
    assert.equal(earnings.earned_amount_egp, c.expectEarningsEgp);

    // Negative path: new order, purchase, refund without fulfil
    const order2 = await createDisposableOrder({ doctorId: doctor.id });
    console.log('  ' + c.addonId + ': onPurchase (negative-path)');
    const purchased2 = await svc.onPurchase({ order: order2, addonService, currency: 'EGP' });
    console.log('  ' + c.addonId + ': onRefund');
    const refunded = await svc.onRefund({ order: order2, addon: purchased2 });
    assert.equal(refunded.status, 'refunded');
    assert.equal(refunded.refund_pending, true);
    assert.equal(await getEarningsFor(purchased2.id), null, 'refunded addons should have no earnings row');
  }

  // The SLA addon block was removed in migration 019b — urgency tiers
  // on main-service pricing replaced the sla_24hr addon entirely.

  console.log('\n✓ all addon lifecycle assertions passed');
}

run()
  .catch((err) => {
    console.error('\n✗ integration test failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await cleanupAll(); }
    catch (e) { console.error('cleanup error', e); }
    await closePool();
  });
