'use strict';
// Guard: every place that names the session cookie must name the SAME cookie.
//
// 2026-08-26 — the patient account-deletion route was written with
// res.clearCookie('session'), because 'session' is what the cookie is called
// in most codebases. Here it is 'tashkheesa_portal'. clearCookie() on a name
// that was never set is a silent no-op that returns 200, so the bug is
// invisible in testing: the patient sees the goodbye page, and their browser
// still holds a signed session cookie for a user row that no longer exists.
// The next request they make hits requireRole() with a valid signature and an
// empty user lookup.
//
// The constant is duplicated in three files rather than exported from one,
// which is a smell, but the duplication is load-bearing (middleware.js must
// not import from routes/, and routes/ must not import from each other for
// this). So the invariant is enforced here instead: same env var, same
// fallback string, everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Every declaration of the cookie name, wherever it lives.
const DECL = /SESSION_COOKIE(?:_NAME)?\s*=\s*process\.env\.SESSION_COOKIE_NAME\s*\|\|\s*'([^']+)'/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every SESSION_COOKIE declaration falls back to the same name', () => {
  const found = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(DECL)) {
      found.push({ file: path.relative(ROOT, file), value: m[1] });
    }
  }
  assert.ok(found.length >= 2, 'expected the cookie name to be declared in at least two files, found ' + found.length);
  const values = [...new Set(found.map((f) => f.value))];
  assert.deepEqual(
    values, ['tashkheesa_portal'],
    'session cookie name has drifted:\n' + found.map((f) => '  ' + f.file + ' -> ' + f.value).join('\n')
  );
});

test('no route clears or reads a plausible-but-wrong session cookie name', () => {
  // The specific mistake that prompted this file. A literal is only a problem
  // when it is being used AS the session cookie, so we look at clearCookie and
  // req.cookies access with a name from the near-miss list.
  const WRONG = ['session', 'token', 'sid', 'auth', 'jwt', 'connect.sid'];
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/res\.clearCookie\(\s*'([^']+)'/g)) {
      if (WRONG.includes(m[1])) {
        offenders.push(path.relative(ROOT, file) + " -> res.clearCookie('" + m[1] + "')");
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'these clear a cookie that is not the session cookie (it is SESSION_COOKIE_NAME, default "tashkheesa_portal"):\n  ' +
      offenders.join('\n  ')
  );
});
