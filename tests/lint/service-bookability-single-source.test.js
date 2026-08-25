'use strict';
// Guard: every surface that decides "can a patient order this service" must
// use services/service_bookable.js, not its own hand-rolled predicate.
//
// WHY THIS FILE EXISTS
//
// 2026-08-25. The rule was three conditions — services.is_visible, NOT
// services.coming_soon, and the SPECIALTY's is_visible — but only the first two
// lived in a shared helper. The third was a JOIN each call site remembered on
// its own, and exactly one of seven did. Result: 24 services under
// deliberately-hidden specialties stayed orderable through the mobile API,
// eight of them Nephrology, which was hidden precisely BECAUSE it has no
// doctor. A patient could pay for a case that could never reach anyone.
//
// The rule now lives in one module. Nothing in the unit suite noticed the
// drift, because a unit test on the helper passes happily while a caller
// ignores the helper — so this is a source-text check, not a behaviour one.
//
// Source-text linting is crude and it earns its place here: the defect was
// invisible to every other kind of test we had.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Every file that gates a patient-facing service choice. Adding a new one
// without adding it here is the drift this guards; adding it here without
// wiring the module fails immediately.
const GATED = [
  'src/routes/patient.js',              // web wizard, all steps
  'src/routes/api/services.js',         // mobile catalogue + price quote
  'src/routes/api/../ai_assistant.js',  // help-me-choose (UNAUTHENTICATED)
  'src/services/case_intake_pricing.js',// POST /api/v1/cases + draft submit
  'src/services/classify_job.js',       // AI pick the wizard can LOCK to
  'src/routes/public_orders.js',        // partner integration
];

test('every patient-facing service gate imports the shared rule', () => {
  for (const rel of GATED) {
    const src = read(rel);
    assert.ok(
      /require\(['"][^'"]*service_bookable['"]\)/.test(src),
      `${rel} does not import services/service_bookable — if it decides what a ` +
      `patient can order, it must use the shared rule; if it no longer does, ` +
      `remove it from GATED in this file and say why in the commit.`
    );
  }
});

test('no gated file hand-rolls the visibility predicate', () => {
  // The exact shapes that were in the codebase before the fix. Matching one
  // again means someone rebuilt the predicate locally instead of importing it.
  const HAND_ROLLED = [
    /\bis_visible\s*=\s*true\b/,                       // bare equality, no COALESCE
    /COALESCE\(\s*\w*\.?is_visible\s*,\s*true\s*\)\s*=\s*true\s*AND\s*COALESCE\(\s*\w*\.?coming_soon/,
  ];
  for (const rel of GATED) {
    const src = read(rel);
    // Strip comments: these files legitimately DESCRIBE the old predicate when
    // explaining why it was wrong, and a lint that forbids saying the words
    // makes the history unwritable.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|--|\*)/.test(l))
      .join('\n');
    for (const re of HAND_ROLLED) {
      assert.ok(
        !re.test(code),
        `${rel} contains a hand-rolled visibility predicate matching ${re}. ` +
        `Use serviceBookableClause() / isServiceBookable() instead.`
      );
    }
  }
});

test('the shared rule actually carries all three conditions', () => {
  const { serviceBookableClause } = require('../../src/services/service_bookable');
  const c = serviceBookableClause('sv');
  assert.ok(/is_visible/.test(c), 'service visibility');
  assert.ok(/coming_soon/.test(c), 'coming_soon');
  assert.ok(/FROM specialties/.test(c), 'SPECIALTY visibility — the one that went missing');
});

test('the clause is parenthesised so an OR cannot strand it', () => {
  const { serviceBookableClause } = require('../../src/services/service_bookable');
  const c = serviceBookableClause('sv');
  assert.ok(c.startsWith('(') && c.endsWith(')'), 'must be wrapped as a single term');
});

test('isServiceBookable refuses to skip the specialty rule', () => {
  const { isServiceBookable } = require('../../src/services/service_bookable');
  assert.throws(
    () => isServiceBookable({ is_visible: true, coming_soon: false }),
    /specialtyIsVisible is required/,
    'a one-argument call must throw, not silently pass the service'
  );
});
