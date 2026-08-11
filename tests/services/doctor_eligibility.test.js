'use strict';
// Pure unit tests for eligibleDoctorClause — no DB. Pins the exact SQL fragment
// shape all 9 assignment sites depend on (spec §4.6). Run:
//   node --test tests/services/doctor_eligibility.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibleDoctorClause } = require('../../src/services/doctor_eligibility');

test('emits the five required predicates with the given alias + param', () => {
  const sql = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$3' });
  assert.match(sql, /u\.role = 'doctor'/);
  assert.match(sql, /COALESCE\(u\.is_active, true\) = true/);
  assert.match(sql, /COALESCE\(u\.is_paused, false\) = false/);
  assert.match(sql, /COALESCE\(u\.onboarding_complete, false\) = true/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM doctor_services ds WHERE ds\.doctor_id = u\.id AND ds\.service_id = \$3\)/);
});

test('does not wrap in outer parens or lead/trail with AND', () => {
  const sql = eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' }).trim();
  assert.ok(!/^AND\b/.test(sql), 'no leading AND');
  assert.ok(!/\bAND$/.test(sql), 'no trailing AND');
  assert.ok(!(sql.startsWith('(') && sql.endsWith(')')), 'not wrapped in a single outer paren');
});

test('interpolates a different alias verbatim', () => {
  const sql = eligibleDoctorClause({ alias: 'd', serviceIdParam: '$7' });
  assert.match(sql, /d\.role = 'doctor'/);
  assert.match(sql, /ds\.doctor_id = d\.id AND ds\.service_id = \$7/);
});
