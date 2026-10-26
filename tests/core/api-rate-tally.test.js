// tests/core/api-rate-tally.test.js
//
// 2026-10-26 — the per-user request tally (src/middleware/api_rate_tally.js).
// The owner's phone exhausted its own 600 / 15 min bucket and nothing said
// which requests it was sending. Pins: counting per user per route pattern per
// minute; ONE info row when a user passes 60 in a minute, at most one per five
// minutes; ids, query strings, tokens and bodies never recorded; refused and
// exempt requests counted; a failing writer never affects the request.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🧮 API rate tally — which requests a signed-in device sends\n');

const { buildRateTally, routePattern } = require('../../src/middleware/api_rate_tally');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-token-value.signature';
const UUID = '3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

function harness(opts = {}) {
  let clock = Date.UTC(2026, 9, 26, 9, 40, 0);
  const rows = [];
  const tally = buildRateTally(Object.assign({
    userIdOf: (req) => req._uid || '',
    isExempt: (req) => /^\/health$|^\/cases\/[^/]+\/payment$/.test(req.path),
    writer: async (row) => { rows.push(row); },
    now: () => clock,
  }, opts));
  const send = (uid, p, extra = {}, res = {}) => {
    let passed = false;
    const req = Object.assign({
      _uid: uid,
      method: 'GET',
      path: p,
      headers: { authorization: 'Bearer ' + TOKEN, 'user-agent': 'Tashkheesa/15 CFNetwork/1568 Darwin/24.0.0' },
      body: { clinicalQuestion: 'private medical text' },
    }, extra);
    tally(req, res, () => { passed = true; });
    return passed;
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return { send, rows, flush, advance: (ms) => { clock += ms; }, tally };
}

async function test(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async () => {
  await test('routePattern turns ids into :id and drops the query string', () => {
    assert.strictEqual(routePattern('/conversations/' + UUID + '/messages'), '/conversations/:id/messages');
    assert.strictEqual(routePattern('/cases/12345/files'), '/cases/:id/files');
    assert.strictEqual(routePattern('/cases/TK-20261026-0042'), '/cases/:id');
    assert.strictEqual(routePattern('/conversations/' + UUID + '/messages?after=2026-10-26T09:40:00Z'), '/conversations/:id/messages');
    assert.strictEqual(routePattern('/notifications/unread-count'), '/notifications/unread-count');
    assert.strictEqual(routePattern('/auth/me'), '/auth/me');
  });

  await test('60 requests in a minute: no row; the 61st: exactly one row with the top paths', async () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.send('pat-1', '/notifications/unread-count');
    for (let i = 0; i < 20; i++) h.send('pat-1', '/conversations/' + UUID + '/messages');
    await h.flush();
    assert.strictEqual(h.rows.length, 0, 'not over 60 yet');
    h.send('pat-1', '/cases');
    await h.flush();
    assert.strictEqual(h.rows.length, 1);
    const row = h.rows[0];
    assert.strictEqual(row.userId, 'pat-1');
    assert.strictEqual(row.context.source, 'api_rate_tally');
    assert.strictEqual(row.context.trigger, 'over_60_per_minute');
    assert.strictEqual(row.context.requestsThisMinute, 61);
    assert.deepStrictEqual(row.context.top.slice(0, 3), [
      { path: 'GET /notifications/unread-count', count: 40 },
      { path: 'GET /conversations/:id/messages', count: 20 },
      { path: 'GET /cases', count: 1 },
    ]);
    assert.strictEqual(row.context.userAgent, 'Tashkheesa/15 CFNetwork/1568 Darwin/24.0.0');
    assert.strictEqual(row.context.appVersion, null);
  });

  await test('no token, no body, no ids, no query string in the row', async () => {
    const h = harness();
    for (let i = 0; i < 61; i++) h.send('pat-1', '/conversations/' + UUID + '/messages?after=2026-10-26');
    await h.flush();
    const text = JSON.stringify(h.rows);
    assert.ok(!text.includes(TOKEN), 'token leaked');
    assert.ok(!text.includes('private medical text'), 'body leaked');
    assert.ok(!text.includes(UUID), 'id leaked');
    assert.ok(!text.includes('after='), 'query leaked');
  });

  await test('one row per user per five minutes; another after five minutes', async () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.send('pat-1', '/cases');
    h.advance(60_000);
    for (let i = 0; i < 200; i++) h.send('pat-1', '/cases');
    await h.flush();
    assert.strictEqual(h.rows.length, 1, 'second minute inside five minutes stays quiet');
    h.advance(4 * 60_000);
    for (let i = 0; i < 61; i++) h.send('pat-1', '/cases');
    await h.flush();
    assert.strictEqual(h.rows.length, 2);
  });

  await test('counts reset every minute: 50 + 50 across a minute boundary is no row', async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.send('pat-1', '/cases');
    h.advance(60_000);
    for (let i = 0; i < 50; i++) h.send('pat-1', '/cases');
    await h.flush();
    assert.strictEqual(h.rows.length, 0);
  });

  await test('per user: two users at 40 each is no row; anonymous is not counted', async () => {
    const h = harness();
    for (let i = 0; i < 40; i++) { h.send('pat-1', '/cases'); h.send('pat-2', '/cases'); }
    for (let i = 0; i < 500; i++) h.send('', '/services');
    await h.flush();
    assert.strictEqual(h.rows.length, 0);
    assert.strictEqual(h.tally._state.users.size, 2);
  });

  await test('exempt paths are counted and marked; X-App-Version is recorded when sent', async () => {
    const h = harness();
    for (let i = 0; i < 61; i++) {
      h.send('pat-1', '/cases/' + UUID + '/payment', { headers: { 'user-agent': 'ua', 'x-app-version': '1.0.0 (15)' } });
    }
    await h.flush();
    assert.strictEqual(h.rows[0].context.top[0].path, 'GET /cases/:id/payment (exempt)');
    assert.strictEqual(h.rows[0].context.appVersion, '1.0.0 (15)');
  });

  await test('a steady 45 a minute: no threshold row, but the first 429 writes one with the 15-minute picture', async () => {
    const { EventEmitter } = require('events');
    const h = harness();
    for (let m = 0; m < 13; m++) {
      for (let i = 0; i < 30; i++) h.send('pat-1', '/notifications/unread-count');
      for (let i = 0; i < 15; i++) h.send('pat-1', '/cases');
      h.advance(60_000);
    }
    await h.flush();
    assert.strictEqual(h.rows.length, 0, 'never over 60 in a minute');
    const res = new EventEmitter();
    h.send('pat-1', '/conversations', {}, res);
    res.statusCode = 429;
    res.emit('finish');
    // A second refusal inside five minutes writes nothing more.
    const res2 = new EventEmitter();
    h.send('pat-1', '/conversations', {}, res2);
    res2.statusCode = 429;
    res2.emit('finish');
    await h.flush();
    assert.strictEqual(h.rows.length, 1);
    const c = h.rows[0].context;
    assert.strictEqual(c.trigger, 'refused');
    assert.strictEqual(c.requestsLast15Min, 13 * 45 + 1); // written at the first refusal
    assert.deepStrictEqual(c.top15Min[0], { path: 'GET /notifications/unread-count', count: 390 });
    assert.deepStrictEqual(c.top15Min[1], { path: 'GET /cases', count: 195 });
  });

  await test('a 200 never triggers the refusal row', async () => {
    const { EventEmitter } = require('events');
    const h = harness();
    const res = new EventEmitter();
    h.send('pat-1', '/cases', {}, res);
    res.statusCode = 200;
    res.emit('finish');
    await h.flush();
    assert.strictEqual(h.rows.length, 0);
  });

  await test('a failing writer never affects the request', async () => {
    const h = harness({ writer: async () => { throw new Error('db down'); } });
    let allPassed = true;
    for (let i = 0; i < 70; i++) allPassed = h.send('pat-1', '/cases') && allPassed;
    await h.flush();
    assert.ok(allPassed);
  });

  await test('api_v1.js mounts the tally before the limiters, keyed on the verified user', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src/routes/api_v1.js'), 'utf8');
    const tallyAt = src.indexOf('router.use(buildRateTally(');
    const limiterAt = src.indexOf('return apiLimiter(req, res, next);');
    assert.ok(tallyAt > 0 && limiterAt > tallyAt, 'the tally must run before the limiter (so 429s are counted)');
    assert.ok(/userIdOf: verifiedUserId/.test(src.slice(tallyAt, tallyAt + 200)));
  });
})();
