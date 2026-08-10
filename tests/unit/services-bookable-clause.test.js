'use strict';
// Pure unit suite: servicesBookableClause() builds the exact bookable SQL
// fragment per the shared contract. No DB, no boot.
// Run: node --test tests/unit/services-bookable-clause.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { servicesBookableClause } = require('../../src/routes/patient');

test('exports servicesBookableClause as a function', () => {
  assert.equal(typeof servicesBookableClause, 'function');
});

test('with an alias, emits COALESCE guards on both is_visible and coming_soon', () => {
  assert.equal(
    servicesBookableClause('sv'),
    'COALESCE(sv.is_visible,true)=true AND COALESCE(sv.coming_soon,false)=false'
  );
});

test('without an alias, uses bare column names', () => {
  assert.equal(
    servicesBookableClause(),
    'COALESCE(is_visible,true)=true AND COALESCE(coming_soon,false)=false'
  );
});

test('is a superset of the visibility rule (contains the is_visible guard) and adds the coming_soon guard', () => {
  const c = servicesBookableClause('sv');
  assert.ok(/COALESCE\(sv\.is_visible,true\)=true/.test(c), 'keeps the is_visible predicate');
  assert.ok(/COALESCE\(sv\.coming_soon,false\)=false/.test(c), 'adds the coming_soon predicate');
});
