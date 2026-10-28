'use strict';
// tests/lint/orders-active-view-keeps-hardening.test.js
//
// 2026-10-27 — every migration from 072 on that (re)creates public.orders_active
// must do it as `WITH (security_invoker = true) AS SELECT * FROM orders …`.
//
// 110 (22 Sep) broke both halves:
//   - an explicit column list in PRODUCTION's orders column order. A database
//     built from the migrations orders those columns differently, so CREATE OR
//     REPLACE VIEW refused (42P16) and no fresh database could migrate past 109;
//   - no WITH clause. A bare CREATE OR REPLACE VIEW resets the view's options,
//     so it silently dropped 072's security_invoker hardening.
// `SELECT *` is safe on every history: it keeps the view's own column order
// and appends whatever the migration just added.
//
// Runner-harness style (global._testRunner), not node:test: counted by every
// version of tests/run.js.

const fs   = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

const DIR = path.join(__dirname, '..', '..', 'src', 'migrations');
const FIRST_HARDENED = 72; // 072_harden_orders_active_view.sql; 045 / 069 predate it

console.log('\n🛡️  orders_active: every re-creation keeps security_invoker and SELECT *\n');

// Executable SQL only, with `'…' || '…'` string concatenations joined so an
// EXECUTE'd definition reads as one statement.
function normalise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/'\s*\|\|\s*'/g, '')
    .replace(/\s+/g, ' ');
}

const DEF = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?orders_active\b(.*?)\bAS\s+(SELECT\b.*?)(?:\bWHERE\b|;|$)/gi;

const files = fs.readdirSync(DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f) && parseInt(f, 10) >= FIRST_HARDENED)
  .sort();

let definitions = 0;
for (const f of files) {
  const sql = normalise(fs.readFileSync(path.join(DIR, f), 'utf8'));
  let m;
  let inFile = 0;
  DEF.lastIndex = 0;
  while ((m = DEF.exec(sql))) {
    definitions++;
    inFile++;
    const opts = m[1];
    const body = m[2];
    const name = f + ': orders_active definition #' + inFile;
    const problems = [];
    if (!/security_invoker\s*=\s*true/i.test(opts)) problems.push('no WITH (security_invoker = true) — a bare CREATE OR REPLACE VIEW drops the 072 hardening');
    if (!/^SELECT\s+\*\s+FROM\s+(?:public\.)?orders\b/i.test(body)) problems.push('not `SELECT * FROM orders` — an explicit column list breaks on any database whose orders columns are in another order: ' + body.slice(0, 80) + '…');
    if (problems.length) t.fail(name, new Error(problems.join('; ')));
    else t.pass(name + ' keeps security_invoker and SELECT *');
  }
}

if (definitions === 0) t.fail('orders_active definitions found', new Error('none from ' + FIRST_HARDENED + ' on — the pattern no longer matches the migrations'));
