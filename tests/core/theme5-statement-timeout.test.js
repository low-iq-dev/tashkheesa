// tests/core/theme5-statement-timeout.test.js
//
// Theme 5 sub-issue B regression guard.
//
// Asserts:
//   1. Source: src/pg.js wires PG_STATEMENT_TIMEOUT_MS via the
//      pool.on('connect', ...) hook with a 30000ms default.
//   2. Live behavior (env override): spawn a child Node process
//      with PG_STATEMENT_TIMEOUT_MS=2000, run pg_sleep(5), assert
//      it errors at ~2s with a "statement timeout" message.
//
// The 2-second override avoids waiting 30s for the default to fire.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n⏱  Theme 5 — statement_timeout enforcement\n');

const PG = path.join(__dirname, '..', '..', 'src', 'pg.js');
const src = fs.readFileSync(PG, 'utf8');

// Source assertions
try {
  if (!/PG_STATEMENT_TIMEOUT_MS\s*=\s*parseInt\(process\.env\.PG_STATEMENT_TIMEOUT_MS,\s*10\)\s*\|\|\s*30000/.test(src)) {
    throw new Error('PG_STATEMENT_TIMEOUT_MS env parsing with 30000 default not found in src/pg.js');
  }
  t.pass('PG_STATEMENT_TIMEOUT_MS env wired with 30000ms default');
} catch (e) { t.fail('env wiring', e); }

try {
  if (!/pool\.on\('connect',\s*function\s*\(client\)/.test(src) ||
      !/SET statement_timeout/.test(src)) {
    throw new Error('pool.on(\'connect\') hook with SET statement_timeout not found');
  }
  t.pass('pool.on("connect") hook issues SET statement_timeout');
} catch (e) { t.fail('connect hook', e); }

// Live behavior — only if DB is reachable.
if (!process.env.DATABASE_URL) {
  t.skip('live timeout', 'DATABASE_URL not set');
  return;
}

(async function liveCheck() {
  const child = spawn(process.execPath, ['-e', `
    require('dotenv').config();
    process.env.PG_STATEMENT_TIMEOUT_MS = '2000';
    const { pool } = require('${PG.replace(/'/g, "\\'")}');
    const start = Date.now();
    pool.query('SELECT pg_sleep(5)').then(() => {
      console.log('UNEXPECTED_OK');
      process.exit(2);
    }).catch(e => {
      const elapsed = Date.now() - start;
      console.log('ELAPSED=' + elapsed);
      console.log('MSG=' + e.message);
      pool.end().then(() => process.exit(0));
    });
  `], { env: process.env });

  let out = '';
  child.stdout.on('data', b => { out += b.toString(); });
  child.stderr.on('data', b => { out += b.toString(); });

  const exit = await new Promise(res => child.on('exit', code => res(code)));

  try {
    if (exit !== 0) throw new Error('child exited ' + exit + '\nout:\n' + out);
    const elapsedMatch = out.match(/ELAPSED=(\d+)/);
    const msgMatch = out.match(/MSG=(.*)/);
    if (!elapsedMatch || !msgMatch) throw new Error('child did not print expected markers\nout:\n' + out);
    const elapsed = parseInt(elapsedMatch[1], 10);
    if (!/statement timeout|canceling statement/i.test(msgMatch[1])) {
      throw new Error('error was not a statement timeout: ' + msgMatch[1]);
    }
    if (elapsed > 4500) throw new Error('timeout fired too late (' + elapsed + 'ms; expected ~2000)');
    if (elapsed < 1500) throw new Error('timeout fired too early (' + elapsed + 'ms; expected ~2000)');
    t.pass('live: pg_sleep(5) under PG_STATEMENT_TIMEOUT_MS=2000 killed at ' + elapsed + 'ms');
  } catch (e) { t.fail('live timeout', e); }
})();
