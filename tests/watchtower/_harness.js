'use strict';
// tests/watchtower/_harness.js — shared by the watchtower tests (6 Oct 2026).
//
// Stubs src/pg (and optionally other modules) in require.cache for the length
// of one test file and puts back EXACTLY what was there, so a later test file
// that requires the real module is unaffected. Not a *.test.js file, so the
// runner does not load it on its own.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

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

module.exports = { t, check, withStubs, fakePg, fakeExpo, withEnv, tick, ROOT };
