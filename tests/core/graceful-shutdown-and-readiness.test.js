// tests/core/graceful-shutdown-and-readiness.test.js
//
// 2026-10-11 — downtime on deploy (Part E).
//
//   1. /healthz answers 200 only when the app is ready and not draining, and
//      NEVER waits on the database: a saturated pool (every deploy, when two
//      instances share a connection ceiling budgeted for one) used to hold the
//      health check past Render's 5-second limit on a process that was alive.
//   2. drainHttpServer(): on SIGTERM an in-flight request finishes, an idle
//      keep-alive socket does not hold the shutdown open, and new connections
//      are refused.
//   3. src/server.js wires both: lifecycle flags, `Connection: close` while
//      draining, one shutdown per process, pool closed AFTER the drain, and a
//      hard deadline inside the host's kill delay.
//
// No database: /healthz is exercised against a stub pool.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};

console.log('\n🩺 Graceful shutdown + readiness (deploy downtime)\n');

const ROOT = path.join(__dirname, '..', '..');
const { drainHttpServer } = require('../../src/http_drain');
const { WORKER_SPECS } = require('../../src/services/admin_health');

async function test(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, urlPath, agent) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, ms: Date.now() - started });
      });
    });
    req.on('error', reject);
  });
}

// A fresh health router per case (the module keeps one router instance, so the
// module is re-required each time).
function healthApp(pool, lifecycle, healthDbTimeoutMs) {
  delete require.cache[require.resolve('../../src/routes/health')];
  const { setupHealthRoutes } = require('../../src/routes/health');
  const app = express();
  app.use('/', setupHealthRoutes({
    MODE: 'test', CONFIG: { SLA_MODE: 'passive' }, pool, pkg: { name: 'x', version: '0' },
    GIT_SHA: 'test', SERVER_STARTED_AT: Date.now(), SERVER_STARTED_AT_ISO: new Date().toISOString(),
    lifecycle, healthDbTimeoutMs,
  }));
  return app;
}
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

// Every worker fresh, clock UTC.
function healthyPool() {
  const calls = { n: 0 };
  return {
    calls, totalCount: 2, idleCount: 1, waitingCount: 0,
    query: async (sql) => {
      calls.n += 1;
      if (/SHOW TimeZone/i.test(sql)) return { rows: [{ TimeZone: 'UTC' }] };
      return { rows: WORKER_SPECS.map((s) => ({ agent_name: s.key, last_run: new Date() })) };
    },
  };
}
// A pool with no free connection: every query waits forever.
function saturatedPool() {
  const calls = { n: 0 };
  return {
    calls, totalCount: 8, idleCount: 0, waitingCount: 5,
    query: () => { calls.n += 1; return new Promise(() => {}); },
  };
}

(async function main() {
  // ── 1. Readiness ────────────────────────────────────────────────────────
  await test('/healthz is 503 until the app is ready, without touching the database', async () => {
    const pool = healthyPool();
    const lifecycle = { ready: false, draining: false };
    const server = await listen(healthApp(pool, lifecycle));
    try {
      const r = await get(server.address().port, '/healthz');
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.ok, false);
      assert.strictEqual(r.json.ready, false);
      assert.strictEqual(pool.calls.n, 0, 'a not-ready check must not query the database');

      lifecycle.ready = true;
      const ok = await get(server.address().port, '/healthz');
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.ok, true);
      assert.strictEqual(ok.json.ready, true);
    } finally { server.close(); }
  });

  await test('/healthz is 503 while draining (SIGTERM received)', async () => {
    const lifecycle = { ready: true, draining: false };
    const server = await listen(healthApp(healthyPool(), lifecycle));
    try {
      assert.strictEqual((await get(server.address().port, '/healthz')).status, 200);
      lifecycle.draining = true;
      const r = await get(server.address().port, '/healthz');
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.draining, true);
    } finally { server.close(); }
  });

  await test('a healthy /healthz keeps the body monitors read (workers, workersOk, clock, clockOk, pool)', async () => {
    const server = await listen(healthApp(healthyPool(), { ready: true, draining: false }));
    try {
      const r = await get(server.address().port, '/healthz');
      assert.strictEqual(r.status, 200);
      for (const k of ['ok', 'mode', 'timestamp', 'uptimeSec', 'pool', 'workers', 'workersOk', 'clock', 'clockOk']) {
        assert.ok(k in r.json, 'missing field: ' + k);
      }
      assert.strictEqual(r.json.workers.length, WORKER_SPECS.length);
      assert.strictEqual(r.json.workersOk, true);
      assert.strictEqual(r.json.clock.db, 'UTC');
      assert.strictEqual(r.json.dbTimedOut, false);
    } finally { server.close(); }
  });

  // ── 2. The health check cannot be starved by the pool ───────────────────
  await test('a saturated pool does NOT hold /healthz: it answers 200 inside Render\'s 5s limit', async () => {
    const pool = saturatedPool();
    const server = await listen(healthApp(pool, { ready: true, draining: false }, 300));
    try {
      const r = await get(server.address().port, '/healthz');
      assert.strictEqual(r.status, 200, 'the web process is alive: the plain health check must pass');
      // The bar is Render's own: a health check unanswered for 5s fails. (The
      // stub pool above never answers, so without the bounded read this would
      // hang for good; 2s was too tight when the whole suite runs at once.)
      assert.ok(r.ms < 4500, 'answered in ' + r.ms + 'ms');
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.dbTimedOut, true);
      assert.strictEqual(r.json.clockOk, false, 'an unread clock is reported unknown, never ok');
    } finally { server.close(); }
  });

  await test('…and repeated checks do not pile more queries onto the full pool', async () => {
    const pool = saturatedPool();
    const server = await listen(healthApp(pool, { ready: true, draining: false }, 150));
    try {
      for (let i = 0; i < 6; i++) await get(server.address().port, '/healthz');
      assert.strictEqual(pool.calls.n, 2, 'one pair of reads in flight, reused: got ' + pool.calls.n + ' queries');
    } finally { server.close(); }
  });

  await test('the default database budget for a health check is 1.5s', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/health.js'), 'utf8');
    assert.ok(/HEALTH_DB_TIMEOUT_MS = .*: 1500;/.test(src));
  });

  await test('?strict=1 still answers 503 on a broken contract and 200 when healthy', async () => {
    const healthy = await listen(healthApp(healthyPool(), { ready: true, draining: false }));
    const starved = await listen(healthApp(saturatedPool(), { ready: true, draining: false }, 150));
    // clockOk needs the NODE clock to be UTC as well (src/server.js forces it
    // in production); pin it for this case only and put it back afterwards.
    const prevTz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      assert.strictEqual((await get(healthy.address().port, '/healthz?strict=1')).status, 200);
      const s = await get(starved.address().port, '/healthz?strict=1');
      assert.strictEqual(s.status, 503, 'strict: an unreadable clock is not a pass');
      assert.strictEqual(s.json.ok, true);
      assert.strictEqual((await get(starved.address().port, '/healthz')).status, 200, 'the plain URL stays 200');
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
      healthy.close(); starved.close();
    }
  });

  // ── 3. Draining ─────────────────────────────────────────────────────────
  await test('drain: an in-flight request finishes, an idle keep-alive socket does not block, new connections are refused', async () => {
    const app = express();
    app.get('/slow', (req, res) => setTimeout(() => res.json({ done: true }), 400));
    app.get('/fast', (req, res) => res.json({ ok: true }));
    const server = await listen(app);
    const port = server.address().port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    try {
      // An idle keep-alive socket: exactly what Render's proxy holds open.
      assert.strictEqual((await get(port, '/fast', agent)).status, 200);
      // A request still in flight when the signal arrives.
      const slow = get(port, '/slow', agent);
      await sleep(60);

      const started = Date.now();
      const drained = drainHttpServer(server, { sweepMs: 50 });
      const inFlight = await slow;
      assert.strictEqual(inFlight.status, 200, 'the in-flight request was cut off');
      assert.deepStrictEqual(inFlight.json, { done: true });

      assert.strictEqual(await drained, true);
      const took = Date.now() - started;
      assert.ok(took < 3000, 'drain took ' + took + 'ms — the idle keep-alive socket held it open');

      let refused = false;
      try { await get(port, '/fast'); } catch (_) { refused = true; }
      assert.ok(refused, 'a drained server must not accept new connections');
    } finally { agent.destroy(); }
  });

  await test('drain on a server that never started listening resolves instead of hanging', async () => {
    const server = http.createServer(() => {});
    const out = await Promise.race([drainHttpServer(server), sleep(1500).then(() => 'hung')]);
    assert.notStrictEqual(out, 'hung');
  });

  // ── 4. server.js wiring ─────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const shutdown = src.slice(src.indexOf('function gracefulShutdown(signal)'));

  await test('server.js: ready flips in the listen callback, which runs after migrations', () => {
    assert.ok(/var lifecycle = \{ ready: false, draining: false \};/.test(src));
    const listenAt = src.indexOf('var server = app.listen(PORT');
    const readyAt = src.indexOf('lifecycle.ready = true;');
    assert.ok(listenAt > 0 && readyAt > listenAt && readyAt - listenAt < 600, 'lifecycle.ready must be set inside the listen callback');
    assert.ok(src.indexOf('await migrate();') < listenAt, 'the server must not listen before migrations have run');
    assert.ok(/lifecycle: lifecycle/.test(src), '/healthz must be given the lifecycle flags');
  });

  await test('server.js: SIGTERM and SIGINT both run the shutdown, and it runs once', () => {
    assert.ok(/process\.on\('SIGTERM', function\(\) \{ gracefulShutdown\('SIGTERM'\); \}\);/.test(src));
    assert.ok(/process\.on\('SIGINT', function\(\) \{ gracefulShutdown\('SIGINT'\); \}\);/.test(src));
    const guardAt = shutdown.indexOf('if (lifecycle.draining) {');
    const setAt = shutdown.indexOf('lifecycle.draining = true;');
    assert.ok(guardAt > 0 && setAt > guardAt, 'the already-draining guard must come before the flag is set');
  });

  await test('server.js: responses carry Connection: close while draining', () => {
    assert.ok(/if \(lifecycle\.draining\) res\.setHeader\('Connection', 'close'\);/.test(src));
  });

  await test('server.js: the pool is closed only AFTER the HTTP server has drained', () => {
    const drainAt = shutdown.indexOf("require('./http_drain').drainHttpServer(server).then(");
    const poolAt = shutdown.indexOf('await pool.end()');
    assert.ok(drainAt > 0, 'gracefulShutdown must drain through http_drain');
    assert.ok(poolAt > drainAt, 'pool.end() must run inside the drain continuation');
    assert.ok(shutdown.indexOf('process.exit(0)') > poolAt, 'exit(0) comes last');
  });

  await test('server.js: the hard deadline defaults to 25s — inside Render\'s 30s kill delay', () => {
    const m = /SHUTDOWN_TIMEOUT_MS = Number\(process\.env\.SHUTDOWN_TIMEOUT_MS\) > 0\s*\?\s*Number\(process\.env\.SHUTDOWN_TIMEOUT_MS\)\s*:\s*(\d+);/.exec(src);
    assert.ok(m, 'SHUTDOWN_TIMEOUT_MS default not found');
    assert.ok(Number(m[1]) >= 15000 && Number(m[1]) < 30000, 'default is ' + m[1]);
    assert.ok(/\}, SHUTDOWN_TIMEOUT_MS\);/.test(shutdown), 'the force-exit timer must use it');
    assert.ok(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').includes('SHUTDOWN_TIMEOUT_MS'));
  });
})();
