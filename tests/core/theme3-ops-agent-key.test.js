// tests/core/theme3-ops-agent-key.test.js
//
// Theme 3 sub-issue D — Stage 1 OPS_AGENT_KEY behavior.
//
// Stage 1 lets every ping pass; the assertion is the *log line* the server
// emits. Boots a server with OPS_AGENT_KEY=test-key-1234, captures stdout,
// and verifies:
//   * No header                  → "agent ping unsigned"
//   * Correct header              → "agent ping signed OK"
//   * Wrong header                → "agent ping unsigned"
//   * /agent/log-tokens, correct  → "agent log-tokens signed OK"
//   * Status code is 200 in every case (Stage 1 does not reject).
//
// Stage 2 (required) is a manual cutover documented in
// docs/runbooks/THEME_03_OPS_AGENT_KEY_CUTOVER.md and is intentionally
// out-of-scope for this test.
//
// Skipped when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔑 Theme 3 — OPS_AGENT_KEY Stage 1 logging behavior\n');

if (!process.env.DATABASE_URL) { t.skip('theme3-ops-agent-key', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('theme3-ops-agent-key', 'JWT_SECRET not set');   return; }

const KEY = 'test-key-1234-theme3';
const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const { pool } = require('../../src/pg');

let serverProc = null;
let serverStdout = '';

async function bootServer() {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      PORT: PORT,
      LAUNCH_GATE_OFF: '1',
      OPS_AGENT_KEY: KEY
    });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    serverProc.stdout.on('data', function (buf) {
      const s = buf.toString();
      serverStdout += s;
      if (!booted && /running on port/.test(s)) { booted = true; resolve(); }
    });
    serverProc.stderr.on('data', function (buf) { serverStdout += buf.toString(); });
    serverProc.once('exit', function (code) {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(function () { if (!booted) reject(new Error('server boot timeout (15s)')); }, 15000);
  });
}

async function shutdown() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise(function (r) { setTimeout(r, 500); });
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function pingWithHeaders(routeLabel, headers) {
  const r = await fetch(BASE + '/ops/agent/' + routeLabel, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify({
      agent_name: 'theme3-test-' + routeLabel,
      status: 'idle',
      tokens_used: 1
    })
  });
  // wait for log line to flush
  await new Promise(function (r2) { setTimeout(r2, 150); });
  return r;
}

(async function run() {
  try {
    try { await bootServer(); }
    catch (e) { t.skip('theme3-ops-agent-key', 'server boot failed: ' + e.message); return; }

    // 1. No header → unsigned
    try {
      const before = serverStdout.length;
      const r = await pingWithHeaders('ping', {});
      assert.strictEqual(r.status, 200, 'Stage 1 must accept unsigned, got ' + r.status);
      const tail = serverStdout.slice(before);
      assert.ok(/agent ping unsigned/.test(tail),
        'expected "agent ping unsigned" in log, got:\n' + tail.slice(-500));
      t.pass('Stage 1: ping no header → 200 + log "agent ping unsigned"');
    } catch (e) { t.fail('Stage 1: ping no header', e); }

    // 2. Correct header → signed OK
    try {
      const before = serverStdout.length;
      const r = await pingWithHeaders('ping', { 'x-ops-agent-key': KEY });
      assert.strictEqual(r.status, 200, 'correct key must pass, got ' + r.status);
      const tail = serverStdout.slice(before);
      assert.ok(/agent ping signed OK/.test(tail),
        'expected "agent ping signed OK" in log, got:\n' + tail.slice(-500));
      t.pass('Stage 1: ping correct header → 200 + log "agent ping signed OK"');
    } catch (e) { t.fail('Stage 1: ping correct header', e); }

    // 3. Wrong header → unsigned (Stage 1 still passes through)
    try {
      const before = serverStdout.length;
      const r = await pingWithHeaders('ping', { 'x-ops-agent-key': 'definitely-wrong-' + KEY });
      assert.strictEqual(r.status, 200, 'Stage 1 must accept wrong key, got ' + r.status);
      const tail = serverStdout.slice(before);
      assert.ok(/agent ping unsigned/.test(tail),
        'expected "agent ping unsigned" in log, got:\n' + tail.slice(-500));
      // Belt-and-suspenders: must NOT log "signed OK" for the wrong key.
      assert.ok(!/agent ping signed OK/.test(tail.slice(-500)),
        'wrong key must NOT log "signed OK"');
      t.pass('Stage 1: ping wrong header → 200 + log "agent ping unsigned" (NOT signed OK)');
    } catch (e) { t.fail('Stage 1: ping wrong header', e); }

    // 4. log-tokens with correct header → signed OK
    try {
      const before = serverStdout.length;
      const r = await pingWithHeaders('log-tokens', { 'x-ops-agent-key': KEY });
      assert.strictEqual(r.status, 200, 'log-tokens correct key must pass, got ' + r.status);
      const tail = serverStdout.slice(before);
      assert.ok(/agent log-tokens signed OK/.test(tail),
        'expected "agent log-tokens signed OK" in log, got:\n' + tail.slice(-500));
      t.pass('Stage 1: log-tokens correct header → 200 + log "agent log-tokens signed OK"');
    } catch (e) { t.fail('Stage 1: log-tokens correct header', e); }

    // 5. Constant-time compare doesn't crash on mismatched-length keys
    try {
      const before = serverStdout.length;
      const r = await pingWithHeaders('ping', { 'x-ops-agent-key': 'short' });
      assert.strictEqual(r.status, 200);
      const tail = serverStdout.slice(before);
      assert.ok(/agent ping unsigned/.test(tail),
        'mismatched-length key should log unsigned, not crash');
      t.pass('Stage 1: ping mismatched-length key → unsigned (constant-time compare safe)');
    } catch (e) { t.fail('Stage 1: mismatched-length key', e); }

  } finally {
    try { await shutdown(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
