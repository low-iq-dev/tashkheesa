'use strict';
// 29 Sep 2026 — loud / quiet / off for Command pushes (migration 123,
// services/ops_push_prefs.js, middleware/push.js notifySuperadmins `kind`).
// The Expo send is mocked at global.fetch and the db is a pg-style fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const push = require('../../src/middleware/push');
const prefs = require('../../src/services/ops_push_prefs');

const realFetch = global.fetch;
function installFetch() {
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)[0]); return { json: async () => ({ data: [{ status: 'ok' }] }) }; };
  return calls;
}
function db(superadmins, stored) {
  return { query: async (sql, params) => {
    if (/admin_notification_prefs/.test(sql)) {
      return { rows: Object.keys(stored || {}).filter((u) => params[1].includes(u)).map((u) => ({ user_id: u, mode: stored[u] })) };
    }
    if (/role = 'superadmin'/.test(sql)) return { rows: superadmins };
    return { rows: [] };
  } };
}
const SA = [{ id: 'sa-1', push_token: 'ExponentPushToken[aaa]' }];

test('no kind (legacy caller): exactly the old message — sound, high, no new keys', async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(db(SA), { title: 'T', body: 'B', data: { type: 'worker_down' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sound, 'default');
    assert.equal(calls[0].priority, 'high');
    assert.equal(calls[0].channelId, undefined);
    assert.equal(calls[0].interruptionLevel, undefined);
    assert.deepEqual(calls[0].data, { type: 'worker_down' });
  } finally { global.fetch = realFetch; }
});

test('a loud-default kind is loud and time-sensitive, and tells the app its mode', async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(db(SA), { title: 'T', body: 'B', data: { kind: 'payment_claim' }, kind: 'payment_claim' });
    assert.equal(calls[0].sound, 'default');
    assert.equal(calls[0].priority, 'high');
    assert.equal(calls[0].interruptionLevel, 'time-sensitive');
    assert.equal(calls[0].data.mode, 'loud');
  } finally { global.fetch = realFetch; }
});

test('a quiet-default kind arrives with no sound key at all, passive, on the activity channel', async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(db(SA), { title: 'T', body: 'B', data: { kind: 'patient_signup' }, kind: 'patient_signup' });
    assert.equal('sound' in calls[0], false);
    assert.equal(calls[0].priority, 'normal');
    assert.equal(calls[0].channelId, 'activity');
    assert.equal(calls[0].interruptionLevel, 'passive');
    assert.equal(calls[0].data.mode, 'quiet');
  } finally { global.fetch = realFetch; }
});

test("a stored 'off' is not pushed", async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(db(SA, { 'sa-1': 'off' }), { title: 'T', body: 'B', kind: 'case_paid' });
    assert.equal(calls.length, 0);
  } finally { global.fetch = realFetch; }
});

test("a stored 'off' on a locked kind is ignored — a waiting transfer still reaches the founder", async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(db(SA, { 'sa-1': 'off' }), { title: 'T', body: 'B', kind: 'payment_claim' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sound, 'default');
  } finally { global.fetch = realFetch; }
});

test('each superadmin gets their own mode', async () => {
  const calls = installFetch();
  try {
    const two = [{ id: 'sa-1', push_token: 'ExponentPushToken[aaa]' }, { id: 'sa-2', push_token: 'ExponentPushToken[bbb]' }];
    await push.notifySuperadmins(db(two, { 'sa-2': 'loud' }), { title: 'T', body: 'B', kind: 'case_paid' });
    const byTo = Object.fromEntries(calls.map((c) => [c.to, c]));
    assert.equal(byTo['ExponentPushToken[aaa]'].data.mode, 'quiet');
    assert.equal(byTo['ExponentPushToken[bbb]'].data.mode, 'loud');
  } finally { global.fetch = realFetch; }
});

test('the prefs table being absent (pre-123) falls back to defaults, never throws', async () => {
  const calls = installFetch();
  try {
    const broken = { query: async (sql) => {
      if (/admin_notification_prefs/.test(sql)) throw new Error('relation does not exist');
      if (/role = 'superadmin'/.test(sql)) return { rows: SA };
      return { rows: [] };
    } };
    await push.notifySuperadmins(broken, { title: 'T', body: 'B', kind: 'patient_signup' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.mode, 'quiet');
  } finally { global.fetch = realFetch; }
});

test('catalogue: every kind has labels in both languages and a valid default; locked kinds default loud', () => {
  const seen = new Set();
  for (const k of prefs.KIND_CATALOGUE) {
    assert.ok(!seen.has(k.kind), 'duplicate ' + k.kind); seen.add(k.kind);
    assert.ok(k.en && k.ar, 'labels for ' + k.kind);
    assert.ok(prefs.MODES.includes(k.def), 'default for ' + k.kind);
    if (k.lockOn) assert.equal(k.def, 'loud', k.kind + ' is locked on, so it must default loud');
  }
  assert.equal(prefs.defaultModeFor('some_future_kind'), 'loud');
});
