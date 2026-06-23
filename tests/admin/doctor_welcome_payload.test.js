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
