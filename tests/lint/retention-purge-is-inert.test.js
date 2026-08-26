'use strict';
// Guard: the retention purge must stay off, and must stay unschedulable, until
// someone deliberately turns it on.
//
// Context, 2026-08-26. The two retention rules select 21 rows and 0 rows in
// production. Rule B — completed cases past their 12-month retention — cannot
// match anything before roughly February 2027, because the oldest order in the
// database was created 2026-04-17. So the job's entire near-term behaviour is
// "delete 21 abandoned unpaid drafts", against a schema with zero foreign keys
// onto users.id and a restore path that has never been rehearsed.
//
// The predecessor script needed only --apply. This one needs --apply AND
// RETENTION_PURGE_ENABLED=true, and nothing may schedule it. These assertions
// exist so that turning it on is a commit somebody has to write, review and
// explain — not a default that drifts in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SERVICE = path.join(ROOT, 'src', 'services', 'retention_purge.js');
const SRC = fs.readFileSync(SERVICE, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('the purge refuses to write without both locks', () => {
  assert.ok(
    /RETENTION_PURGE_ENABLED/.test(CODE),
    'the purge must consult RETENTION_PURGE_ENABLED'
  );
  assert.ok(
    /apply\s*=\s*false/.test(CODE),
    'apply must default to false, so a bare call is a dry run'
  );
  assert.ok(
    /if\s*\(!apply\s*\|\|\s*!enabled\)/.test(CODE),
    'the guard must require BOTH apply and the env flag; an || of two negatives is the shape that does that'
  );
});

test('the purge is not wired into any scheduler or boot path', () => {
  // A cron entry, a worker registration or a server.js require would make the
  // env flag the only thing standing between a deploy and a destructive pass.
  const SEARCH_DIRS = ['src', 'scripts'].map((d) => path.join(ROOT, d));
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, p);
      // The service and its own CLI are allowed to reference themselves.
      if (rel === 'src/services/retention_purge.js' || rel === 'scripts/retention_purge.js') continue;
      // The retired predecessor is an inert stub whose whole body is a message
      // pointing at the replacement. Test 4 below is what keeps it inert.
      if (rel === 'scripts/purge_old_deleted_orders.js') continue;
      const body = fs.readFileSync(p, 'utf8');
      if (/retention_purge|runRetentionPurge/.test(body)) offenders.push(rel);
    }
  };
  for (const d of SEARCH_DIRS) walk(d);
  assert.deepEqual(
    offenders, [],
    'the retention purge is referenced outside its own module and CLI:\n  ' + offenders.join('\n  ') +
    '\nIf it is being scheduled, that is a decision that needs to be made explicitly.'
  );
});

test('render.yaml does not schedule the purge', () => {
  const yml = path.join(ROOT, 'render.yaml');
  if (!fs.existsSync(yml)) return;
  const body = fs.readFileSync(yml, 'utf8');
  assert.ok(
    !/retention_purge/.test(body),
    'render.yaml references retention_purge — the job must not be scheduled yet'
  );
  assert.ok(
    !/RETENTION_PURGE_ENABLED\s*:?\s*(true|"true"|'true')/i.test(body),
    'render.yaml sets RETENTION_PURGE_ENABLED=true'
  );
});

test('the removed predecessor cannot run', () => {
  const old = path.join(ROOT, 'scripts', 'purge_old_deleted_orders.js');
  if (!fs.existsSync(old)) return; // deleted outright is also fine
  const body = fs.readFileSync(old, 'utf8');
  assert.ok(/process\.exit\(1\)/.test(body), 'the stub must exit non-zero');
  // Look for the ability to execute SQL at all, not for the WORD "delete" —
  // the stub's message explains what the old script did, and prose is not
  // behaviour. If it cannot reach a connection pool it cannot delete anything.
  assert.ok(
    !/\b(pool|client|db)\.query\s*\(/.test(body),
    'scripts/purge_old_deleted_orders.js can still execute SQL'
  );
  assert.ok(
    !/require\(['"][^'"]*\/(db|pg)['"]\)/.test(body),
    'scripts/purge_old_deleted_orders.js still opens a database connection'
  );
});
