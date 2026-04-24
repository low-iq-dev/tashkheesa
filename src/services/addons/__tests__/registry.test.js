'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../registry');
const AddonService = require('../base');

test('registry exposes three addons by id', () => {
  assert.ok(reg.getAddon('video_consult'));
  assert.ok(reg.getAddon('sla_24hr'));
  assert.ok(reg.getAddon('prescription'));
});

test('registry returns null for unknown id', () => {
  assert.equal(reg.getAddon('not-real'), null);
});

test('registry.all() returns three instances extending AddonService', () => {
  const all = reg.all();
  assert.equal(all.length, 3);
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
  const sla    = reg.getAddon('sla_24hr');
  const presc  = reg.getAddon('prescription');

  assert.equal(video.constructor.id, 'video_consult');
  assert.equal(video.constructor.type, 'video_consult');
  assert.equal(video.constructor.hasLifecycle, true);

  assert.equal(sla.constructor.id, 'sla_24hr');
  assert.equal(sla.constructor.type, 'sla_upgrade');
  assert.equal(sla.constructor.hasLifecycle, false);

  assert.equal(presc.constructor.id, 'prescription');
  assert.equal(presc.constructor.type, 'prescription');
  assert.equal(presc.constructor.hasLifecycle, true);
});
