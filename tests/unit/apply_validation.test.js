'use strict';

// Public doctor-application form — server-side validation (express-validator).
// Pure unit suite: runs the validator chains against mock reqs, no DB, no network.
// Run: node --test tests/unit/apply_validation.test.js
//
// CORE PRODUCT RULE under test: sub_specialties are SUGGESTIONS only — the
// taxonomy must NOT gate them. A free-text sub-specialty that is not in the
// taxonomy MUST be accepted and stored verbatim. specialty_id, by contrast,
// MUST be a valid taxonomy id OR the literal 'other' (with specialty_other).

const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');

const {
  applyValidators,
  normalizeSubSpecialties,
  buildApplicationRecord,
} = require('../../src/validators/apply');

// Run every validator chain against a fresh mock req, return the result handle.
async function validate(body) {
  const req = { body: Object.assign({}, body) };
  for (const chain of applyValidators) {
    await chain.run(req);
  }
  return { req, result: validationResult(req) };
}

const VALID = {
  full_name: 'Dr. Sara Ali',
  email: 'sara@example.com',
  phone: '+201001234567',
  specialty_id: 'spec-cardiology',
  sub_specialties: ['Interventional Cardiology'],
};

// ───────────────────────── required fields ─────────────────────────

test('rejects an empty submission — full_name, email, phone, specialty_id all error', async () => {
  const { result } = await validate({});
  const e = result.mapped();
  assert.ok(e.full_name, 'full_name required');
  assert.ok(e.email, 'email required');
  assert.ok(e.phone, 'phone required');
  assert.ok(e.specialty_id, 'specialty_id required');
});

test('rejects a malformed email', async () => {
  const { result } = await validate({ ...VALID, email: 'not-an-email' });
  assert.ok(result.mapped().email, 'email must be flagged invalid');
});

// ───────────────────────── specialty_id ─────────────────────────

test('rejects a specialty_id that is neither a taxonomy id nor "other"', async () => {
  const { result } = await validate({ ...VALID, specialty_id: 'spec-bogus' });
  assert.ok(result.mapped().specialty_id, 'unknown specialty_id must be flagged');
});

test('accepts a real taxonomy specialty_id (spec-cardiology)', async () => {
  const { result } = await validate({ ...VALID, specialty_id: 'spec-cardiology' });
  assert.ok(!result.mapped().specialty_id, 'a real specialty_id must pass');
});

test('rejects specialty_id="other" when specialty_other is missing', async () => {
  const { result } = await validate({ ...VALID, specialty_id: 'other', specialty_other: '' });
  assert.ok(result.mapped().specialty_other, 'specialty_other required when "other"');
});

test('accepts specialty_id="other" with a specialty_other value', async () => {
  const { result } = await validate({ ...VALID, specialty_id: 'other', specialty_other: 'Sports Medicine' });
  assert.ok(result.isEmpty(), 'other + specialty_other should be valid: ' + JSON.stringify(result.mapped()));
});

test('accepts a valid real specialty_id even with a stale long specialty_other (field is ignored unless "other")', async () => {
  // Regression: the view hides #specialty_other_group but keeps its value, so a
  // stale >160-char value can be submitted after switching away from "other".
  // It is discarded by buildApplicationRecord, so it must NOT reject the form.
  const { result } = await validate({ ...VALID, specialty_id: 'spec-cardiology', specialty_other: 'x'.repeat(200) });
  assert.ok(result.isEmpty(), 'stale specialty_other must not reject a valid non-other submission: ' + JSON.stringify(result.mapped()));
});

test('rejects specialty_id="other" with a specialty_other over 160 chars', async () => {
  const { result } = await validate({ ...VALID, specialty_id: 'other', specialty_other: 'x'.repeat(200) });
  assert.ok(result.mapped().specialty_other, 'over-long specialty_other must be rejected when "other"');
});

// ───────────────────────── sub_specialties ─────────────────────────

test('rejects more than 20 sub_specialties (anti-spam ceiling)', async () => {
  const many = Array.from({ length: 21 }, (_, i) => 'Sub ' + i);
  const { result } = await validate({ ...VALID, sub_specialties: many });
  assert.ok(result.mapped().sub_specialties, '>20 sub_specialties must be rejected');
});

test('rejects a non-string sub_specialty', async () => {
  const { result } = await validate({ ...VALID, sub_specialties: ['ok', 123] });
  assert.ok(result.mapped().sub_specialties, 'a non-string sub_specialty must be rejected');
});

test('REGRESSION: accepts a free-text sub-specialty that is NOT in the taxonomy', async () => {
  // Core product requirement: doctors may free-add sub-specialties. The taxonomy
  // is suggestions only and MUST NOT gate this field.
  const { result } = await validate({
    ...VALID,
    specialty_id: 'spec-cardiology',
    sub_specialties: ['Underwater Basket Weaving', 'Totally Invented Subspecialty'],
  });
  assert.ok(result.isEmpty(), 'free-text sub-specialties must pass: ' + JSON.stringify(result.mapped()));
});

test('accepts a fully valid payload', async () => {
  const { result } = await validate(VALID);
  assert.ok(result.isEmpty(), 'valid payload should produce no errors: ' + JSON.stringify(result.mapped()));
});

// ───────────────────────── normalizeSubSpecialties ─────────────────────────

test('normalizeSubSpecialties trims, drops empties, and de-dupes — verbatim otherwise', () => {
  const out = normalizeSubSpecialties(['  Interventional Cardiology ', 'Interventional Cardiology', '', '   ', 'Heart Failure']);
  assert.deepEqual(out, ['Interventional Cardiology', 'Heart Failure']);
});

test('normalizeSubSpecialties preserves an unlisted free-text value verbatim', () => {
  const out = normalizeSubSpecialties(['Underwater Basket Weaving']);
  assert.deepEqual(out, ['Underwater Basket Weaving']);
});

test('normalizeSubSpecialties returns [] for undefined / non-array', () => {
  assert.deepEqual(normalizeSubSpecialties(undefined), []);
  assert.deepEqual(normalizeSubSpecialties(null), []);
  assert.deepEqual(normalizeSubSpecialties('x'), []);
});

// ───────────────────────── buildApplicationRecord ─────────────────────────

test('buildApplicationRecord nulls specialty_other unless specialty_id="other", coerces years, captures ip/ua', () => {
  const req = {
    body: { ...VALID, specialty_other: 'should be dropped', years_experience: '12' },
    ip: '203.0.113.7',
    get: (h) => (h.toLowerCase() === 'user-agent' ? 'jest-UA' : ''),
  };
  const rec = buildApplicationRecord(req);
  assert.equal(rec.specialty_id, 'spec-cardiology');
  assert.equal(rec.specialty_other, null, 'specialty_other dropped when not "other"');
  assert.equal(rec.years_experience, 12);
  assert.equal(rec.submitter_ip, '203.0.113.7');
  assert.equal(rec.user_agent, 'jest-UA');
  assert.equal(rec.source, 'web_apply');
  assert.deepEqual(rec.sub_specialties, ['Interventional Cardiology']);
});

test('buildApplicationRecord keeps specialty_other when specialty_id="other"', () => {
  const req = {
    body: { ...VALID, specialty_id: 'other', specialty_other: '  Sports Medicine  ' },
    ip: '203.0.113.7',
    get: () => '',
  };
  const rec = buildApplicationRecord(req);
  assert.equal(rec.specialty_id, 'other');
  assert.equal(rec.specialty_other, 'Sports Medicine');
});
