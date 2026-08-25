'use strict';
// Pure unit suite: the bookable SQL fragment. No DB, no boot.
// Run: node --test tests/unit/services-bookable-clause.test.js
//
// 2026-08-25 — these assertions used to pin the fragment to exactly two
// predicates, which is precisely why the third one went missing for so long:
// specialty visibility was a JOIN each call site remembered separately, and
// only the web wizard's step-3 POST did. 24 services sat under a hidden
// specialty and stayed orderable through the mobile API. The rule now lives in
// services/service_bookable.js and the fragment carries it as a correlated
// EXISTS, so it travels with the WHERE clause instead of relying on a caller's
// FROM clause.
const test = require('node:test');
const assert = require('node:assert/strict');

const { servicesBookableClause } = require('../../src/routes/patient');
const { serviceBookableClause, isServiceBookable } =
  require('../../src/services/service_bookable');

test('exports servicesBookableClause as a function', () => {
  assert.equal(typeof servicesBookableClause, 'function');
});

test('patient.js delegates to the shared builder rather than keeping a copy', () => {
  assert.equal(servicesBookableClause('sv'), serviceBookableClause('sv'));
  assert.equal(servicesBookableClause(), serviceBookableClause());
});

test('with an alias, guards is_visible, coming_soon AND specialty visibility', () => {
  const c = serviceBookableClause('sv');
  assert.ok(/COALESCE\(sv\.is_visible,true\)=true/.test(c), 'keeps the is_visible predicate');
  assert.ok(/COALESCE\(sv\.coming_soon,false\)=false/.test(c), 'keeps the coming_soon predicate');
  assert.ok(/EXISTS \(SELECT 1 FROM specialties/.test(c), 'adds the specialty predicate');
  assert.ok(/sp_bookable_\.id = sv\.specialty_id/.test(c), 'correlates on the service alias');
  assert.ok(/COALESCE\(sp_bookable_\.is_visible, true\) = true/.test(c), 'treats an unset specialty flag as visible');
});

test('without an alias, uses bare column names', () => {
  const c = serviceBookableClause();
  assert.ok(/COALESCE\(is_visible,true\)=true/.test(c));
  assert.ok(/COALESCE\(coming_soon,false\)=false/.test(c));
  assert.ok(/sp_bookable_\.id = specialty_id/.test(c));
});

test('needs no JOIN — the specialty test is self-contained', () => {
  // The whole point: a caller can paste this into a WHERE clause without
  // touching its FROM. If this ever becomes a bare column reference again,
  // every call site silently loses the specialty rule.
  assert.ok(/EXISTS \(SELECT 1 FROM specialties sp_bookable_/.test(serviceBookableClause('sv')));
});

test('the specialty alias cannot collide with a caller that already joins sp', () => {
  const c = serviceBookableClause('sv');
  assert.ok(!/\bAS sp\b|\bspecialties sp\b(?!_)/.test(c), 'does not claim the bare alias "sp"');
});

test('isServiceBookable agrees with the SQL, including the reason', () => {
  assert.deepEqual(isServiceBookable({ is_visible: true, coming_soon: false }, true),
    { bookable: true, reason: null });
  assert.deepEqual(isServiceBookable({ is_visible: false, coming_soon: false }, true),
    { bookable: false, reason: 'service_hidden' });
  assert.deepEqual(isServiceBookable({ is_visible: true, coming_soon: true }, true),
    { bookable: false, reason: 'coming_soon' });
  assert.deepEqual(isServiceBookable({ is_visible: true, coming_soon: false }, false),
    { bookable: false, reason: 'specialty_hidden' });
  assert.deepEqual(isServiceBookable(null, true), { bookable: false, reason: 'missing' });
});

test('isServiceBookable treats unset flags as permissive, matching COALESCE', () => {
  // Older rows predate these columns; an unset flag means "visible", which is
  // what the SQL COALESCEs do. Only an explicit false withdraws a service.
  assert.equal(isServiceBookable({}, null).bookable, true);
  assert.equal(isServiceBookable({ is_visible: null, coming_soon: null }, undefined).bookable, true);
});
