'use strict';
// Guard: literal /superadmin/doctors/* paths must be registered BEFORE the
// /superadmin/doctors/:id param routes.
//
// 2026-08-25 — /superadmin/doctors/bulk-welcome was registered below
// /superadmin/doctors/:id. Express matches in registration order, so it bound
// :id='bulk-welcome', found no such doctor and redirected to the list. The
// "Email all" button appeared to do nothing, and 23 invites did not go out on
// the day they were meant to. /superadmin/doctors/new had always been above
// the param routes for exactly this reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js'), 'utf8');

function lineOf(re) {
  const lines = SRC.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
}

test('literal doctor sub-paths are registered before the :id param routes', () => {
  const paramRoutes = [
    /router\.(get|post)\('\/superadmin\/doctors\/:id'/,
    /router\.(get|post)\('\/superadmin\/doctors\/:id\/edit'/,
  ].map(lineOf).filter((n) => n > 0);
  assert.ok(paramRoutes.length, 'expected at least one /superadmin/doctors/:id route');
  const firstParam = Math.min(...paramRoutes);

  // Every literal segment that could be mistaken for an id.
  const literals = ['new', 'bulk-welcome'];
  for (const seg of literals) {
    const at = lineOf(new RegExp("router\\.get\\('/superadmin/doctors/" + seg + "'"));
    assert.ok(at > 0, `/superadmin/doctors/${seg} is not registered at all`);
    assert.ok(
      at < firstParam,
      `/superadmin/doctors/${seg} is registered at line ${at}, AFTER the first ` +
      `:id route at line ${firstParam}. Express matches in registration order, so ` +
      `it will bind :id='${seg}' and never run. Move it above the param routes.`
    );
  }
});
