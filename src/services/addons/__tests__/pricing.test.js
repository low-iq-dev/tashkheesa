'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAddonPrice, resolveCataloguePrices } = require('../pricing');

test('resolveAddonPrice returns EGP price for known addon', async () => {
  const p = await resolveAddonPrice('prescription', 'EGP');
  assert.ok(p, 'should resolve');
  assert.equal(p.addonServiceId, 'prescription');
  assert.equal(p.currency, 'EGP');
  assert.equal(p.amount, 400);
  assert.equal(p.baseEgp, 400);
  assert.equal(p.commissionPct, 80);
});

test('resolveAddonPrice honours per-currency override when present', async () => {
  const p = await resolveAddonPrice('prescription', 'SAR');
  assert.ok(p);
  assert.equal(p.currency, 'SAR');
  assert.equal(p.amount, 100);          // seeded in migration 019
  assert.equal(p.baseEgp, 400);         // base does not change
});

test('resolveAddonPrice falls back to EGP for unknown currency', async () => {
  const origWarn = console.warn;
  let warned = false;
  console.warn = function() { warned = true; };
  try {
    const p = await resolveAddonPrice('prescription', 'XYZ');
    assert.ok(p);
    assert.equal(p.currency, 'EGP');
    assert.equal(p.amount, 400);
    assert.ok(warned, 'should emit a warn on unknown currency');
  } finally {
    console.warn = origWarn;
  }
});

test('resolveAddonPrice returns null for unknown addon id', async () => {
  const p = await resolveAddonPrice('not-a-real-addon', 'EGP');
  assert.equal(p, null);
});

test('resolveCataloguePrices returns all 2 active addons in sort order', async () => {
  const all = await resolveCataloguePrices('EGP');
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.addonServiceId), ['video_consult', 'prescription']);
  assert.equal(all.find(r => r.addonServiceId === 'video_consult').amount, 200);
  assert.equal(all.find(r => r.addonServiceId === 'prescription').amount, 400);
});

test.after(async () => {
  const { closePool } = require('./_helpers');
  await closePool();
});
