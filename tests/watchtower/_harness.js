'use strict';
// tests/watchtower/_harness.js — shared by the watchtower tests (6 Oct 2026).
//
// Stubs src/pg (and optionally other modules) in require.cache for the length
// of one test file and puts back EXACTLY what was there, so a later test file
// that requires the real module is unaffected. Not a *.test.js file, so the
// runner does not load it on its own.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const CHILD = process.env.WATCHTOWER_TEST_CHILD === '1';
const MARK = '@@WT ';

// ── Process isolation ───────────────────────────────────────────────────────
//
// tests/run.js require()s every test file in one process and lets their async
// bodies interleave. These tests swap entries in require.cache (src/pg,
// src/logger) and replace global.fetch for the length of an awaited call — in
// a shared process that leaks both ways: another file's request lands in our
// fake Expo, and another file's lazy require('src/pg') gets our stub.
//
// So each watchtower test file re-runs ITSELF in a child process,
// synchronously, and relays the child's results to the runner. Nothing these
// tests stub is ever visible to another test file.
const runnerT = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

const t = CHILD ? {
  pass: (n) => process.stdout.write(MARK + JSON.stringify({ ok: true, name: n }) + '\n'),
  fail: (n, e) => process.stdout.write(MARK + JSON.stringify({ ok: false, name: n, err: String((e && e.message) || e) }) + '\n'),
  skip: (n, r) => process.stdout.write(MARK + JSON.stringify({ skip: true, name: n, err: r }) + '\n'),
} : runnerT;

/**
 * Call first thing in a test file: `if (runIsolated(__filename)) return;`
 * In the parent it runs the file in a child, relays every result, and returns
 * true. In the child it returns false and the file's own tests run.
 */
function runIsolated(file) {
  if (CHILD) return false;
  const { spawnSync } = require('child_process');
  const label = path.basename(file, '.test.js');
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { WATCHTOWER_TEST_CHILD: '1' }),
  });
  let seen = 0;
  String(r.stdout || '').split('\n').forEach((line) => {
    if (line.indexOf(MARK) !== 0) return;
    let m; try { m = JSON.parse(line.slice(MARK.length)); } catch (_) { return; }
    seen++;
    if (m.skip) runnerT.skip(m.name, m.err);
    else if (m.ok) runnerT.pass(m.name);
    else runnerT.fail(m.name, new Error(m.err));
  });
  // A child that died, or reported nothing, must not read as "all passed".
  if (r.error || r.status !== 0 || seen === 0) {
    runnerT.fail(label + ': test process', new Error(
      (r.error && r.error.message) || ('exit ' + r.status + ', ' + seen + ' result(s): ' + String(r.stderr || '').trim().split('\n').slice(-3).join(' | '))));
  }
  return true;
}

/** Call at the end of a test file's async body (child only): exit cleanly, whatever is still open. */
function finish() { if (CHILD) setImmediate(() => process.exit(0)); }

async function check(name, fn) {
  try { const err = await fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

function resolve(rel) { return require.resolve(path.join(ROOT, rel)); }

/**
 * Install stubs: { 'src/pg.js': exportsObject, ... }. Also evicts `reload`
 * modules so they bind to the stubs. Returns restore().
 */
function withStubs(stubs, reload) {
  const saved = new Map();
  const touch = (rel) => { const id = resolve(rel); if (!saved.has(id)) saved.set(id, require.cache[id]); return id; };
  Object.keys(stubs).forEach((rel) => {
    const id = touch(rel);
    require.cache[id] = { id: id, filename: id, loaded: true, exports: stubs[rel], children: [], paths: [] };
  });
  (reload || []).forEach((rel) => { const id = touch(rel); delete require.cache[id]; });
  return function restore() {
    saved.forEach((mod, id) => { if (mod) require.cache[id] = mod; else delete require.cache[id]; });
  };
}

/** A pg-module fake driven by one handler(sql, params) -> rows[]. Records every call. */
function fakePg(handler) {
  const calls = [];
  const run = async (sql, params) => {
    calls.push({ sql: String(sql), params: params || [] });
    const rows = (await handler(String(sql), params || [])) || [];
    return { rows: rows, rowCount: rows.length };
  };
  const api = {
    calls,
    pool: { query: run },
    execute: run,
    queryAll: async (sql, params) => (await run(sql, params)).rows,
    queryOne: async (sql, params) => (await run(sql, params)).rows[0] || null,
  };
  return api;
}

/** Replace global.fetch; returns { calls, restore }. responder(url, message) -> ticket. */
function fakeExpo(responder) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    let msg = null;
    try { msg = JSON.parse(opts.body)[0]; } catch (_) { msg = null; }
    calls.push({ url: String(url), message: msg });
    const ticket = responder ? await responder(String(url), msg) : { status: 'ok' };
    return { json: async () => ({ data: [ticket] }) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

function withEnv(vars) {
  const saved = {};
  Object.keys(vars).forEach((k) => {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  });
  return () => Object.keys(saved).forEach((k) => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = { t, check, withStubs, fakePg, fakeExpo, withEnv, tick, ROOT, runIsolated, finish, CHILD };
