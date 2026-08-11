'use strict';

// Pure unit tests for buildDoctorWelcomePayload (no DB, no req). The extracted
// builder mirrors superadmin.js _issueDoctorWelcomePayload verbatim, so these
// pin its full branch matrix — the degraded/secondary paths the live invite
// service exercises only sometimes: null/empty baseUrl, Arabic lang + 'د.'
// strip, empty-name fallback, null token, trailing-slash normalization, and the
// password_setup_link alias. Run: node --test tests/admin/doctor_welcome_payload.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDoctorWelcomePayload, WELCOME_EXPIRY_HOURS } = require('../../src/services/doctor_welcome_payload');

test('constants: 7-day expiry', () => {
  assert.equal(WELCOME_EXPIRY_HOURS, 168);
});

test('English happy: Dr. stripped, links built, alias + expiryDays', () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: 'Dr. Sarah Test', lang: 'en' }, token: 'tok-1', baseUrl: 'https://portal.test' });
  assert.equal(p.firstName, 'Sarah');
  assert.equal(p.doctorName, 'Dr. Sarah Test');
  assert.equal(p.lang, 'en');
  assert.equal(p.magicLinkUrl, 'https://portal.test/magic-login/tok-1?lang=en');
  assert.equal(p.password_setup_link, p.magicLinkUrl, 'alias equals magicLinkUrl');
  assert.equal(p.portalUrl, 'https://portal.test/portal/doctor/today');
  assert.equal(p.expiryDays, 7);
});

test("Arabic: 'د.' stripped, lang=ar carried into the link", () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: 'د. هبة سامي', lang: 'ar' }, token: 'tok-2', baseUrl: 'https://portal.test' });
  assert.equal(p.lang, 'ar');
  assert.equal(p.firstName, 'هبة');
  assert.equal(p.magicLinkUrl, 'https://portal.test/magic-login/tok-2?lang=ar');
});

test('lang defaults to en when missing/unknown', () => {
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: 'X' }, token: 't', baseUrl: 'https://p.test' }).lang, 'en');
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: 'X', lang: 'fr' }, token: 't', baseUrl: 'https://p.test' }).lang, 'en');
});

test('empty / missing name → localized Doctor fallback', () => {
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: '', lang: 'en' }, token: 't', baseUrl: 'https://p.test' }).firstName, 'Doctor');
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: '', lang: 'en' }, token: 't', baseUrl: 'https://p.test' }).doctorName, 'Doctor');
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: null, lang: 'ar' }, token: 't', baseUrl: 'https://p.test' }).firstName, 'الطبيب');
  assert.equal(buildDoctorWelcomePayload({ doctor: { name: null, lang: 'ar' }, token: 't', baseUrl: 'https://p.test' }).doctorName, 'الطبيب');
});

test('null/empty baseUrl → all links null (email gates CTA on it)', () => {
  for (const baseUrl of [null, '', undefined]) {
    const p = buildDoctorWelcomePayload({ doctor: { name: 'Dr. A', lang: 'en' }, token: 'tok', baseUrl });
    assert.equal(p.magicLinkUrl, null, `magicLinkUrl null for baseUrl=${JSON.stringify(baseUrl)}`);
    assert.equal(p.password_setup_link, null);
    assert.equal(p.portalUrl, null);
    assert.equal(p.firstName, 'A', 'firstName still derived');
  }
});

test('null token → magicLinkUrl null but portalUrl still built', () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: 'Dr. A', lang: 'en' }, token: null, baseUrl: 'https://portal.test' });
  assert.equal(p.magicLinkUrl, null);
  assert.equal(p.password_setup_link, null);
  assert.equal(p.portalUrl, 'https://portal.test/portal/doctor/today');
});

test('baseUrl trailing slashes normalized', () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: 'Dr. A', lang: 'en' }, token: 'tok', baseUrl: 'https://portal.test///' });
  assert.equal(p.magicLinkUrl, 'https://portal.test/magic-login/tok?lang=en');
  assert.equal(p.portalUrl, 'https://portal.test/portal/doctor/today');
});

test('no-arg / empty-arg call does not throw (degrades to en Doctor, null links)', () => {
  const p = buildDoctorWelcomePayload();
  assert.equal(p.firstName, 'Doctor');
  assert.equal(p.magicLinkUrl, null);
  assert.equal(p.expiryDays, 7);
});

// ── v5 template additions: nameAr / specialtyAr / specialtyEn ────────────────
// The v5 doctor-welcome body greets with "د. {{nameAr}}،" and names the
// specialty in both languages, so these pin the two gaps that actually exist
// in prod: one active doctor with no users.name_ar, and a doctor row with no
// users.specialty_id.

const BASE = 'https://portal.test';

test('nameAr: uses users.name_ar (full name, not first token)', () => {
  const p = buildDoctorWelcomePayload({
    doctor: { name: 'Heba Samy', name_ar: 'هبة سامي', lang: 'en' },
    token: 't', baseUrl: BASE
  });
  assert.equal(p.nameAr, 'هبة سامي');
  assert.equal(p.firstName, 'Heba', 'firstName stays first-token only');
});

test("nameAr: strips a stored 'د.' prefix so the greeting can't double up", () => {
  const p = buildDoctorWelcomePayload({
    doctor: { name: 'Heba Samy', name_ar: 'د. هبة سامي', lang: 'ar' },
    token: 't', baseUrl: BASE
  });
  assert.equal(p.nameAr, 'هبة سامي', 'template renders "د. " itself');
});

test('nameAr: falls back to users.name when name_ar is null/blank', () => {
  for (const name_ar of [null, '', '   ', undefined]) {
    const p = buildDoctorWelcomePayload({
      doctor: { name: 'Taher Ahmed Abulaban', name_ar, lang: 'en' },
      token: 't', baseUrl: BASE
    });
    assert.equal(p.nameAr, 'Taher Ahmed Abulaban', `fallback for name_ar=${JSON.stringify(name_ar)}`);
  }
});

test("nameAr fallback also strips 'Dr.' from users.name", () => {
  // The real inactive prod row: name='Dr. Ahmed Hassan', name_ar=NULL.
  // Without the strip the greeting renders "د. Dr. Ahmed Hassan،".
  const p = buildDoctorWelcomePayload({
    doctor: { name: 'Dr. Ahmed Hassan', name_ar: null, lang: 'en' },
    token: 't', baseUrl: BASE
  });
  assert.equal(p.nameAr, 'Ahmed Hassan');
});

test('nameAr: both name and name_ar empty → Arabic Doctor label, never blank', () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: '', name_ar: null, lang: 'en' }, token: 't', baseUrl: BASE });
  assert.equal(p.nameAr, 'الطبيب');
});

test('specialty: both languages carried through', () => {
  const p = buildDoctorWelcomePayload({
    doctor: { name: 'Dr. A', lang: 'en', specialty_name: 'Cardiology', specialty_name_ar: 'أمراض القلب' },
    token: 't', baseUrl: BASE
  });
  assert.equal(p.specialtyEn, 'Cardiology');
  assert.equal(p.specialtyAr, 'أمراض القلب');
});

test('specialty: no specialty → empty strings so {{#if}} hides the clause', () => {
  const p = buildDoctorWelcomePayload({ doctor: { name: 'Dr. A', lang: 'en' }, token: 't', baseUrl: BASE });
  assert.equal(p.specialtyAr, '', 'falsy for {{#if specialtyAr}}');
  assert.equal(p.specialtyEn, '', 'falsy for {{#if specialtyEn}}');
});

test('specialty: half-seeded row falls back across languages, never blank on one side', () => {
  const arOnly = buildDoctorWelcomePayload({
    doctor: { name: 'Dr. A', lang: 'en', specialty_name: null, specialty_name_ar: 'أمراض القلب' },
    token: 't', baseUrl: BASE
  });
  assert.equal(arOnly.specialtyAr, 'أمراض القلب');
  assert.equal(arOnly.specialtyEn, 'أمراض القلب');

  const enOnly = buildDoctorWelcomePayload({
    doctor: { name: 'Dr. A', lang: 'en', specialty_name: 'Cardiology', specialty_name_ar: '' },
    token: 't', baseUrl: BASE
  });
  assert.equal(enOnly.specialtyEn, 'Cardiology');
  assert.equal(enOnly.specialtyAr, 'Cardiology');
});
