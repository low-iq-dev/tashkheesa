'use strict';
// tests/auth/uploadcare-erasure.test.js
//
// PRIV-1 (2026-09-22)
//
// Account erasure deleted the R2 objects and left the legacy Uploadcare ones
// addressable forever, while telling the patient their data was gone. The
// code collected the UUIDs and logged that it had not deleted them, on the
// stated grounds that "zero rows match today" — a comment that had gone
// stale: production held nine such rows when this was written.
//
// These pin the delete path itself, not the wording of a log line: one DELETE
// per UUID, Uploadcare's Simple auth header, 404 treated as already-gone, and
// a hard degrade to no-deletes when the secret key is not configured. That
// last one matters because UPLOADCARE_SECRET_KEY is deliberately absent from
// .env (server.js:113) — this must never throw on an instance without it.

try { require('dotenv').config(); } catch (_) {}

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🧹 account erasure deletes legacy Uploadcare objects\n');

const { purgeUploadcareUuids } = require('../../src/services/account_deletion');

const UUID_A = '746576f9-45e0-4200-9fad-008ad83e1c52';
const UUID_B = '2b7d2688-909c-4819-bffc-b99ffd03d751';

const realFetch = global.fetch;
const realPub = process.env.UPLOADCARE_PUBLIC_KEY;
const realSecret = process.env.UPLOADCARE_SECRET_KEY;

function withStub(responder, fn) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return responder(String(url), opts || {});
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = realFetch; });
}

function restoreEnv() {
  if (realPub === undefined) delete process.env.UPLOADCARE_PUBLIC_KEY;
  else process.env.UPLOADCARE_PUBLIC_KEY = realPub;
  if (realSecret === undefined) delete process.env.UPLOADCARE_SECRET_KEY;
  else process.env.UPLOADCARE_SECRET_KEY = realSecret;
}

function configured() {
  process.env.UPLOADCARE_PUBLIC_KEY = 'testpublickey';
  process.env.UPLOADCARE_SECRET_KEY = 'testsecretkey';
}

async function check(name, fn) {
  try { const err = await fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
  finally { restoreEnv(); global.fetch = realFetch; }
}

(async function run() {

  await check('no secret key: nothing is called, nothing is claimed deleted', async () => {
    delete process.env.UPLOADCARE_SECRET_KEY;
    process.env.UPLOADCARE_PUBLIC_KEY = 'testpublickey';
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      const r = await purgeUploadcareUuids([UUID_A, UUID_B], { userId: 'u1' });
      if (calls.length !== 0) return 'the API was called without a secret key';
      if (r.configured !== false) return 'configured should be false';
      if (r.deleted !== 0) return 'claimed ' + r.deleted + ' deleted with no credentials';
      if (r.failed.length !== 2) return 'both UUIDs should be reported unhandled';
      return null;
    });
  });

  await check('one DELETE per UUID, at Uploadcare\'s files endpoint', async () => {
    configured();
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      const r = await purgeUploadcareUuids([UUID_A, UUID_B], {});
      if (calls.length !== 2) return 'expected 2 calls, got ' + calls.length;
      if (calls.some((c) => (c.opts.method || '').toUpperCase() !== 'DELETE')) return 'not a DELETE';
      if (!calls[0].url.startsWith('https://api.uploadcare.com/files/')) return 'wrong endpoint: ' + calls[0].url;
      if (!calls[0].url.endsWith('/')) return 'Uploadcare requires the trailing slash';
      if (r.deleted !== 2) return 'expected 2 deleted, got ' + r.deleted;
      return null;
    });
  });

  await check('the Simple auth header carries both keys, in the right order', async () => {
    configured();
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      await purgeUploadcareUuids([UUID_A], {});
      const auth = (calls[0].opts.headers || {}).Authorization || '';
      if (auth !== 'Uploadcare.Simple testpublickey:testsecretkey') return 'bad header: ' + auth;
      const accept = (calls[0].opts.headers || {}).Accept || '';
      if (!/uploadcare-v0\.7/.test(accept)) return 'missing versioned Accept header: ' + accept;
      return null;
    });
  });

  await check('404 counts as deleted — the object is already gone', async () => {
    configured();
    return withStub(async () => ({ ok: false, status: 404 }), async () => {
      const r = await purgeUploadcareUuids([UUID_A], {});
      if (r.deleted !== 1) return '404 was treated as a failure';
      if (r.failed.length !== 0) return '404 should not be reported as unreferenced';
      return null;
    });
  });

  await check('a 500 is a failure, and is reported rather than swallowed', async () => {
    configured();
    return withStub(async () => ({ ok: false, status: 500 }), async () => {
      const r = await purgeUploadcareUuids([UUID_A], {});
      if (r.deleted !== 0) return 'a 500 was counted as deleted';
      if (r.failed[0] !== UUID_A) return 'the failure was not reported';
      return null;
    });
  });

  await check('a thrown request does not stop the remaining UUIDs', async () => {
    configured();
    return withStub(async (url) => {
      if (url.indexOf(UUID_A) !== -1) throw new Error('socket hang up');
      return { ok: true, status: 200 };
    }, async () => {
      const r = await purgeUploadcareUuids([UUID_A, UUID_B], {});
      if (r.deleted !== 1) return 'the second UUID was not attempted';
      if (r.failed[0] !== UUID_A) return 'the thrown one was not reported';
      return null;
    });
  });

  await check('placeholder ids are not sent to the API, and not claimed deleted', async () => {
    configured();
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      const r = await purgeUploadcareUuids(['prod-test-001', 'cancel-test-001', UUID_A], {});
      if (calls.length !== 1) return 'a non-UUID was sent to the API (' + calls.length + ' calls)';
      if (r.deleted !== 1) return 'expected only the real UUID deleted';
      if (r.failed.length !== 2) return 'the two placeholders should be reported';
      return null;
    });
  });

  await check('an empty list is a no-op, not a call', async () => {
    configured();
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      const r = await purgeUploadcareUuids([], {});
      if (calls.length !== 0) return 'called the API with nothing to delete';
      if (r.deleted !== 0 || r.failed.length !== 0) return 'unexpected result shape';
      return null;
    });
  });

  await check('duplicate UUIDs are deleted once', async () => {
    configured();
    return withStub(async () => ({ ok: true, status: 200 }), async (calls) => {
      await purgeUploadcareUuids([UUID_A, UUID_A, ' ' + UUID_A + ' '], {});
      if (calls.length !== 1) return 'expected 1 call, got ' + calls.length;
      return null;
    });
  });

})();
