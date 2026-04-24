'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../registry');
const AddonService = require('../base');

test('registry exposes two addons by id', () => {
  assert.ok(reg.getAddon('video_consult'));
  assert.ok(reg.getAddon('prescription'));
});

test('registry does not expose the removed sla_24hr addon', () => {
  assert.equal(reg.getAddon('sla_24hr'), null);
});

test('registry returns null for unknown id', () => {
  assert.equal(reg.getAddon('not-real'), null);
});

test('registry.all() returns two instances extending AddonService', () => {
  const all = reg.all();
  assert.equal(all.length, 2);
  for (const inst of all) {
    assert.ok(inst instanceof AddonService, inst.constructor.name + ' should extend AddonService');
  }
});

test('isEnabled is false by default (Phase 2 dormant)', () => {
  const prev = process.env.ADDON_SYSTEM_V2;
  delete process.env.ADDON_SYSTEM_V2;
  try {
    assert.equal(reg.isEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.ADDON_SYSTEM_V2 = prev;
  }
});

test('isEnabled is true when ADDON_SYSTEM_V2=true', () => {
  const prev = process.env.ADDON_SYSTEM_V2;
  process.env.ADDON_SYSTEM_V2 = 'true';
  try {
    assert.equal(reg.isEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.ADDON_SYSTEM_V2;
    else process.env.ADDON_SYSTEM_V2 = prev;
  }
});

test('concrete classes declare the expected static metadata', () => {
  const video  = reg.getAddon('video_consult');
  const presc  = reg.getAddon('prescription');

  assert.equal(video.constructor.id, 'video_consult');
  assert.equal(video.constructor.type, 'video_consult');
  assert.equal(video.constructor.hasLifecycle, true);

  assert.equal(presc.constructor.id, 'prescription');
  assert.equal(presc.constructor.type, 'prescription');
  assert.equal(presc.constructor.hasLifecycle, true);
});
