'use strict';
// Guard: every view passed to assertRenderableView() must exist in
// views/registry.js AND on disk.
//
// 2026-08-25 — src/views/superadmin_bulk_welcome.ejs was created and rendered
// but never registered. assertRenderableView throws on an unregistered view;
// Express 4 does not catch a rejection from an async handler; server.js turns
// unhandledRejection into process.exit(1). So one click on a superadmin button
// took production down, and every retry took it down again — 502, restart,
// 502. The registry exists to catch a missing view at render time, and instead
// it was the thing that killed the process.
//
// This is a static check because the failure only reproduces by hitting the
// route in a live process, which is exactly when it is most expensive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const registry = require(path.join(ROOT, 'src', 'views', 'registry.js'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every assertRenderableView() target is registered and on disk', () => {
  const missing = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    // Only literal single-argument calls; a computed name cannot be checked here.
    for (const m of src.matchAll(/assertRenderableView\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const view = m[1];
      const rel = path.relative(ROOT, file);
      if (registry[view] !== true) {
        missing.push(`${rel}: assertRenderableView('${view}') — NOT in views/registry.js`);
      }
      if (!fs.existsSync(path.join(ROOT, 'src', 'views', view + '.ejs'))) {
        missing.push(`${rel}: assertRenderableView('${view}') — src/views/${view}.ejs does not exist`);
      }
    }
  }
  assert.deepEqual(
    missing, [],
    'assertRenderableView throws on an unregistered view, and in an async ' +
    'Express handler that becomes an unhandledRejection -> process.exit(1). ' +
    'Register the view (or create the file):\n  ' + missing.join('\n  ')
  );
});

// Two entries in registry.js name views that have never existed as .ejs files
// and that nothing renders — grep for render('admin_dashboard') returns
// nothing. They are stale, they are harmless (the registry is only consulted
// BY assertRenderableView, which nothing calls for them), and deleting them is
// somebody's cleanup, not this test's. Allowlisted so the check still catches
// a NEW orphan, which would mean a view was renamed or deleted while a route
// still expects it.
const KNOWN_ORPHANS = new Set(['admin_dashboard', 'superadmin_dashboard']);

test('no NEW registry entry names a view that does not exist', () => {
  const orphans = Object.keys(registry)
    .filter((v) => registry[v] === true)
    .filter((v) => !KNOWN_ORPHANS.has(v))
    .filter((v) => !fs.existsSync(path.join(ROOT, 'src', 'views', v + '.ejs')));
  assert.deepEqual(
    orphans, [],
    'registry.js names views with no .ejs file — a rename or delete left a ' +
    'route expecting something that is not there: ' + orphans.join(', ')
  );
});
