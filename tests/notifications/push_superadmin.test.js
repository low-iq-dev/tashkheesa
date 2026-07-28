'use strict';
// Unit tests for middleware/push:
//   - notifySuperadmins (new): fans out to every role='superadmin' push_token,
//     swallow-and-logs at both the per-recipient and lookup levels.
//   - sendPushNotification (refactored): byte-compatible behaviour is preserved
//     after the _sendExpoPush core extraction (lookup → send → DeviceNotRegistered
//     cleanup).
// The raw Expo send is mocked at global.fetch — no network.

const test = require('node:test');
const assert = require('node:assert/strict');

const push = require('../../src/middleware/push');

// ── fetch mock harness ─────────────────────────────────────────────────────
const realFetch = global.fetch;
function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const messages = JSON.parse(opts.body);
    calls.push({ url, messages });
    return handler ? handler(messages, calls.length) : { json: async () => ({ data: [{ status: 'ok' }] }) };
  };
  return calls;
}
function restoreFetch() { global.fetch = realFetch; }

// A pg-style fake db. `superadmins` are the rows the superadmin lookup returns;
// `tokenById` backs the single-user lookup for sendPushNotification. Records
// `UPDATE ... push_token = NULL` cleanups in `nulled`.
function pgDb({ superadmins = [], tokenById = {} } = {}) {
  const nulled = [];
  return {
    nulled,
    query: async (sql, params) => {
      if (/role = 'superadmin'/.test(sql)) return { rows: superadmins };
      if (/SELECT push_token FROM users WHERE id/.test(sql)) return { rows: [{ push_token: tokenById[params[0]] || null }] };
      if (/UPDATE users SET push_token = NULL/.test(sql)) { nulled.push(params[0]); return { rowCount: 1 }; }
      return { rows: [] };
    },
  };
}

// ── notifySuperadmins ───────────────────────────────────────────────────────

test('notifySuperadmins: sends to every superadmin token via exp.host', async () => {
  const calls = installFetch();
  try {
    const db = pgDb({ superadmins: [
      { id: 'sa-1', push_token: 'ExponentPushToken[aaa]' },
      { id: 'sa-2', push_token: 'ExpoPushToken[bbb]' },
    ] });
    await push.notifySuperadmins(db, { title: 'T', body: 'B', data: { type: 'worker_down', worker: 'w' } });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /exp\.host/);
    assert.equal(calls[0].messages[0].to, 'ExponentPushToken[aaa]');
    assert.equal(calls[0].messages[0].title, 'T');
    assert.equal(calls[0].messages[0].body, 'B');
    assert.deepEqual(calls[0].messages[0].data, { type: 'worker_down', worker: 'w' });
    assert.equal(calls[1].messages[0].to, 'ExpoPushToken[bbb]');
  } finally { restoreFetch(); }
});

test('notifySuperadmins: no superadmin tokens → no send, no throw', async () => {
  const calls = installFetch();
  try {
    await push.notifySuperadmins(pgDb({ superadmins: [] }), { title: 'T', body: 'B' });
    assert.equal(calls.length, 0);
  } finally { restoreFetch(); }
});

test('notifySuperadmins: a bad-format token is skipped, valid ones still sent', async () => {
  const calls = installFetch();
  try {
    const db = pgDb({ superadmins: [
      { id: 'sa-1', push_token: 'not-a-real-token' },
      { id: 'sa-2', push_token: 'ExponentPushToken[ok]' },
    ] });
    await push.notifySuperadmins(db, { title: 'T', body: 'B' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].to, 'ExponentPushToken[ok]');
  } finally { restoreFetch(); }
});

test('notifySuperadmins: one send throwing does not stop the rest and never rejects', async () => {
  let n = 0;
  installFetch(() => { n++; if (n === 1) throw new Error('network'); return { json: async () => ({ data: [{ status: 'ok' }] }) }; });
  try {
    const db = pgDb({ superadmins: [
      { id: 'sa-1', push_token: 'ExponentPushToken[aaa]' },
      { id: 'sa-2', push_token: 'ExponentPushToken[bbb]' },
    ] });
    await assert.doesNotReject(push.notifySuperadmins(db, { title: 'T', body: 'B' }));
    assert.equal(n, 2); // second recipient still attempted
  } finally { restoreFetch(); }
});

test('notifySuperadmins: lookup failure is swallowed (never rejects)', async () => {
  installFetch();
  try {
    const db = { query: async () => { throw new Error('db down'); } };
    await assert.doesNotReject(push.notifySuperadmins(db, { title: 'T', body: 'B' }));
  } finally { restoreFetch(); }
});

// ── sendPushNotification byte-compat ────────────────────────────────────────

test('sendPushNotification: unchanged — resolves token then sends', async () => {
  const calls = installFetch();
  try {
    const db = pgDb({ tokenById: { 'u-1': 'ExponentPushToken[u1]' } });
    await push.sendPushNotification(db, 'u-1', { title: 'Hi', body: 'there', data: { screen: 'x' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].to, 'ExponentPushToken[u1]');
    assert.deepEqual(calls[0].messages[0].data, { screen: 'x' });
  } finally { restoreFetch(); }
});

test('sendPushNotification: no token → no send', async () => {
  const calls = installFetch();
  try {
    await push.sendPushNotification(pgDb({ tokenById: {} }), 'u-none', { title: 'Hi', body: 'there' });
    assert.equal(calls.length, 0);
  } finally { restoreFetch(); }
});

test('sendPushNotification: DeviceNotRegistered → token nulled for that user', async () => {
  installFetch(() => ({ json: async () => ({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }) }));
  const db = pgDb({ tokenById: { 'u-1': 'ExponentPushToken[u1]' } });
  try {
    await push.sendPushNotification(db, 'u-1', { title: 'Hi', body: 'there' });
    assert.deepEqual(db.nulled, ['u-1']);
  } finally { restoreFetch(); }
});
