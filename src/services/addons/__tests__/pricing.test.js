'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAddonPrice, resolveCataloguePrices } = require('../pricing');
const { queryOne } = require('../../../pg');

// 2026-08-24 — these assertions used to hardcode the catalogue's numbers
// (400 EGP, SAR 100, 80% commission). Two problems with that: the commission
// literal was already wrong before anyone touched pricing (the row says 50,
// the test said 80, so the file was red), and migration 088 reprices the
// prescription add-on to 300 across nine currencies — which would have turned
// one stale literal into five.
//
// A pricing RESOLVER should be tested against the catalogue it resolves from,
// not against a copy of it. Reading the row makes these tests survive the next
// repricing, and — more usefully — makes them fail when the resolver stops
// agreeing with the registry, which is the actual thing worth catching.
async function catalogue(id) {
  const row = await queryOne(
    'SELECT base_price_egp, prices_json, doctor_commission_pct FROM addon_services WHERE id = $1',
    [id]
  );
  assert.ok(row, 'addon_services row for ' + id + ' must exist — seeded by migration 019');
  return {
    baseEgp: Math.round(Number(row.base_price_egp)),
    prices: row.prices_json || {},
    commissionPct: Math.round(Number(row.doctor_commission_pct))
  };
}

test('resolveAddonPrice returns EGP price for known addon', async () => {
  const cat = await catalogue('prescription');
  const p = await resolveAddonPrice('prescription', 'EGP');
  assert.ok(p, 'should resolve');
  assert.equal(p.addonServiceId, 'prescription');
  assert.equal(p.currency, 'EGP');
  assert.equal(p.amount, cat.baseEgp);
  assert.equal(p.baseEgp, cat.baseEgp);
  assert.equal(p.commissionPct, cat.commissionPct);
});

test('resolveAddonPrice honours per-currency override when present', async () => {
  const cat = await catalogue('prescription');
  assert.ok(cat.prices.SAR, 'SAR override must be seeded (migration 088)');
  const p = await resolveAddonPrice('prescription', 'SAR');
  assert.ok(p);
  assert.equal(p.currency, 'SAR');
  assert.equal(p.amount, Math.round(Number(cat.prices.SAR)));
  assert.equal(p.baseEgp, cat.baseEgp);   // base does not change with currency
});

test('every currency the platform sells in has a prescription price', async () => {
  // Migration 088. Before it, five of the nine had none and resolveAddonPrice
  // silently fell back to the EGP figure — which the pay page then labelled
  // with the local currency.
  const cat = await catalogue('prescription');
  for (const c of ['EGP', 'USD', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR']) {
    const v = Number(cat.prices[c]);
    assert.ok(Number.isFinite(v) && v > 0, 'missing or non-positive price for ' + c);
    const p = await resolveAddonPrice('prescription', c);
    assert.equal(p.currency, c, c + ' should resolve in its own currency, not fall back to EGP');
    assert.equal(p.amount, Math.round(v));
  }
});

test('AED, SAR and QAR are priced identically, as every service is', async () => {
  const cat = await catalogue('prescription');
  assert.equal(Number(cat.prices.AED), Number(cat.prices.SAR));
  assert.equal(Number(cat.prices.SAR), Number(cat.prices.QAR));
});

test('resolveAddonPrice falls back to EGP for unknown currency', async () => {
  const origWarn = console.warn;
  let warned = false;
  console.warn = function() { warned = true; };
  try {
    const cat = await catalogue('prescription');
    const p = await resolveAddonPrice('prescription', 'XYZ');
    assert.ok(p);
    assert.equal(p.currency, 'EGP');
    assert.equal(p.amount, cat.baseEgp);
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
  const video = await catalogue('video_consult');
  const rx = await catalogue('prescription');
  assert.equal(all.find(r => r.addonServiceId === 'video_consult').amount, video.baseEgp);
  assert.equal(all.find(r => r.addonServiceId === 'prescription').amount, rx.baseEgp);
});

test.after(async () => {
  const { closePool } = require('./_helpers');
  await closePool();
});
