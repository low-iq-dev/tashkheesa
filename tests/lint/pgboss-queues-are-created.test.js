'use strict';
// tests/lint/pgboss-queues-are-created.test.js
//
// 2026-09-22
//
// pg-boss 10 throws "Queue <name> does not exist" from work() and schedule()
// against a queue nothing ever created. server.js catches those throws and
// logs them rather than crashing — correct, because one broken scheduler must
// not take the web service down with it, but it means the failure is SILENT.
//
// It has now happened twice. classifier-learning shipped this way and carries
// a note about it. The attention sweep then shipped the same way on 22 Sep:
// the deploy was clean, /healthz reported the worker as 'starting' forever,
// pgboss.schedule had no row, and nothing was watching the intake doors —
// which is precisely what that sweep exists to prevent.
//
// A comment did not stop the second one. This does.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🧵 every pg-boss queue is created before it is used\n');

const src = fs.readFileSync(path.join(__dirname, '../../src/job_queue.js'), 'utf8');
const names = (re) => {
  const out = new Set();
  let m;
  const r = new RegExp(re, 'g');
  while ((m = r.exec(src)) !== null) out.add(m[1]);
  return out;
};

const created   = names("boss\\.createQueue\\('([^']+)'\\)");
const worked    = names("boss\\.work\\('([^']+)'");
const scheduled = names("boss\\.schedule\\('([^']+)'");

function check(name, fn) {
  try { const err = fn(); if (err) t.fail(name, new Error(err)); else t.pass(name); }
  catch (e) { t.fail(name, e); }
}

check('at least one queue is created (the regexes still match this file)', () => (
  created.size > 0 ? null : 'found no createQueue calls — this test has gone blind'
));

check('every queue passed to boss.work() was created', () => {
  const missing = [...worked].filter((n) => !created.has(n));
  return missing.length
    ? 'work() without createQueue(): ' + missing.join(', ') + ' — will throw and be swallowed at boot'
    : null;
});

check('every queue passed to boss.schedule() was created', () => {
  const missing = [...scheduled].filter((n) => !created.has(n));
  return missing.length
    ? 'schedule() without createQueue(): ' + missing.join(', ') + ' — the cron will never fire'
    : null;
});

check('the attention sweep specifically is created, worked and scheduled', () => {
  for (const [label, set] of [['createQueue', created], ['work', worked], ['schedule', scheduled]]) {
    if (!set.has('attention-sweep')) return 'attention-sweep is missing from ' + label + '()';
  }
  return null;
});
