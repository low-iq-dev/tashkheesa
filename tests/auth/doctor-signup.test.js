// tests/auth/doctor-signup.test.js
//
// Unit tests for src/validators/doctor_signup.js.
//
// Covers the B10 validation matrix from the pre-launch audit's signup-v2
// plan — required fields, optional fields, allowlists (countries / SLA
// tiers / spoken languages), repeater normalization (certifications,
// affiliations), age range, password length bump 6→8, and the consent
// gate. No DB calls — the validator is pure.

'use strict';

var t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧪 doctor-signup validator\n');

var validator;
try {
  validator = require('../../src/validators/doctor_signup');
} catch (e) {
  t.fail('require validator', e);
  return;
}
var validateDoctorSignup = validator.validateDoctorSignup;

// ── Helpers ───────────────────────────────────────────────────────────
function validBody(overrides) {
  var base = {
    name: 'Dr. Mona Hosny',
    name_ar: 'د. منى حسني',
    email: 'mona.hosny@example.com',
    password: 'longenough8',
    phone: '+201012345678',
    country_code: 'EG',
    date_of_birth: '1985-06-12',
    gender: 'f',
    national_id: '28506121234567',
    specialty_id: 'spec-cardiology',
    secondary_specialty_ids: [],
    sub_specialties: ['Echocardiography'],
    medical_license_number: 'EG-12345',
    license_country: 'EG',
    medical_school: 'Cairo University',
    graduation_year: 2010,
    years_of_experience: 12,
    certifications: [{ name: 'Board Cardiology', body: 'EG Cardiac Society', year: 2015 }],
    affiliations: [{ name: 'Cairo Heart Hospital', role: 'Consultant', year: 2018 }],
    spoken_languages: ['en', 'ar'],
    service_ids: [],
    sla_tiers_supported: ['standard', 'vip'],
    bio: 'Cardiologist with a focus on imaging.',
    bio_ar: 'استشارية قلب متخصصة في التصوير.',
    consent_accuracy: 'on',
    consent_terms: 'on',
    consent_audit_log: 'on',
    consent_pii: 'on'
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  }
  return base;
}

function expect(name, actual, predicate, predicateDesc) {
  try {
    if (predicate(actual)) t.pass(name);
    else t.fail(name, new Error(predicateDesc + ' — got: ' + JSON.stringify(actual)));
  } catch (e) {
    t.fail(name, e);
  }
}

// ── Happy path ────────────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody(), 'en');
  expect(
    'happy path: ok=true on a fully-filled valid body',
    r.ok,
    function (v) { return v === true; },
    'expected ok=true'
  );
  expect(
    'happy path: zero errors',
    r.errors.length,
    function (v) { return v === 0; },
    'expected errors.length=0'
  );
  expect(
    'happy path: email is lower-cased & trimmed',
    r.normalized.email,
    function (v) { return v === 'mona.hosny@example.com'; },
    'expected normalized.email=mona.hosny@example.com'
  );
  expect(
    'happy path: arrays preserved',
    r.normalized.spoken_languages,
    function (v) { return Array.isArray(v) && v.length === 2 && v[0] === 'en' && v[1] === 'ar'; },
    'expected ["en","ar"]'
  );
  expect(
    'happy path: consents coerced to booleans',
    r.normalized.consent_accuracy === true && r.normalized.consent_terms === true && r.normalized.consent_audit_log === true && r.normalized.consent_pii === true,
    function (v) { return v === true; },
    'all four consents should be true'
  );
})();

// ── Required field omissions ──────────────────────────────────────────
[
  { field: 'name', expectMsgFragment: /name|الاسم/i },
  { field: 'email', expectMsgFragment: /email|البريد/i },
  { field: 'password', expectMsgFragment: /password|كلمة/i },
  { field: 'phone', expectMsgFragment: /phone|الهاتف/i },
  { field: 'country_code', expectMsgFragment: /country|الدولة/i },
  { field: 'national_id', expectMsgFragment: /national|قومي/i },
  { field: 'specialty_id', expectMsgFragment: /specialty|التخصص/i },
  { field: 'medical_license_number', expectMsgFragment: /license|الترخيص/i },
  { field: 'medical_school', expectMsgFragment: /school|الكلية/i }
].forEach(function (tc) {
  (function () {
    var body = validBody();
    body[tc.field] = '';
    var r = validateDoctorSignup(body, 'en');
    expect(
      'missing required field "' + tc.field + '" → ok=false',
      r.ok,
      function (v) { return v === false; },
      'expected ok=false'
    );
    expect(
      'missing "' + tc.field + '" surfaces a relevant error message',
      r.errors,
      function (errs) { return errs.some(function (m) { return tc.expectMsgFragment.test(m); }); },
      'expected an error matching ' + tc.expectMsgFragment
    );
  })();
});

// ── Password length: 6 should fail (bumped from 6 to 8) ──────────────
(function () {
  var r = validateDoctorSignup(validBody({ password: 'abc123' }), 'en');
  expect(
    'password=6 chars → fails (min 8)',
    r.ok === false && r.errors.some(function (m) { return /at least 8|٨ أحرف/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false with "at least 8" error'
  );
})();
(function () {
  var r = validateDoctorSignup(validBody({ password: 'eightch8' }), 'en');
  expect('password=8 chars → passes', r.ok, function (v) { return v === true; }, 'expected ok=true');
})();

// ── Email format ──────────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ email: 'not-an-email' }), 'en');
  expect(
    'email without @ → fails',
    r.ok === false && r.errors.some(function (m) { return /Invalid email|صيغة/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false with invalid-email error'
  );
})();

// ── Country allowlist ─────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ country_code: 'US' }), 'en');
  expect(
    'country_code outside allowlist → fails',
    r.ok === false && r.errors.some(function (m) { return /valid country|دولة/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false; "US" is not in {EG,SA,AE,KW,QA,BH,OM}'
  );
})();

// ── Age range (DOB) ───────────────────────────────────────────────────
(function () {
  // 16-year-old → too young
  var dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - 16);
  var iso = dob.toISOString().slice(0, 10);
  var r = validateDoctorSignup(validBody({ date_of_birth: iso }), 'en');
  expect(
    'DOB → 16 years old → fails age range',
    r.ok === false && r.errors.some(function (m) { return /Age|22|80|العمر/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false with age-range error'
  );
})();
(function () {
  // 90-year-old → too old
  var r = validateDoctorSignup(validBody({ date_of_birth: '1930-01-01' }), 'en');
  expect(
    'DOB → 96 years old → fails age range',
    r.ok === false && r.errors.some(function (m) { return /Age|22|80|العمر/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false'
  );
})();
(function () {
  // 30-year-old → ok
  var dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - 30);
  var iso = dob.toISOString().slice(0, 10);
  var r = validateDoctorSignup(validBody({ date_of_birth: iso }), 'en');
  expect('DOB → 30 years old → passes', r.ok, function (v) { return v === true; }, 'expected ok=true');
})();

// ── Graduation year bounds ────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ graduation_year: 1900 }), 'en');
  expect('graduation_year=1900 → fails', r.ok, function (v) { return v === false; }, 'expected ok=false');
})();
(function () {
  var nextYear = new Date().getUTCFullYear() + 1;
  var r = validateDoctorSignup(validBody({ graduation_year: nextYear }), 'en');
  expect('graduation_year=next-year → fails', r.ok, function (v) { return v === false; }, 'expected ok=false');
})();

// ── Years of experience bounds ────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ years_of_experience: 100 }), 'en');
  expect('years_of_experience=100 → fails', r.ok, function (v) { return v === false; }, 'expected ok=false');
})();
(function () {
  var r = validateDoctorSignup(validBody({ years_of_experience: -1 }), 'en');
  expect('years_of_experience=-1 → fails', r.ok, function (v) { return v === false; }, 'expected ok=false');
})();
(function () {
  var r = validateDoctorSignup(validBody({ years_of_experience: 0 }), 'en');
  expect('years_of_experience=0 (fresh grad) → passes', r.ok, function (v) { return v === true; }, 'expected ok=true');
})();

// ── SLA tier allowlist ────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ sla_tiers_supported: ['standard', 'gold'] }), 'en');
  expect(
    'sla_tiers_supported with "gold" → fails',
    r.ok === false && r.errors.some(function (m) { return /SLA tier|SLA/i.test(m); }),
    function (v) { return v === true; },
    'expected ok=false with SLA tier error'
  );
})();
(function () {
  // No tiers selected → defaults to ['standard']
  var r = validateDoctorSignup(validBody({ sla_tiers_supported: [] }), 'en');
  expect(
    'sla_tiers_supported=[] → defaults to ["standard"]',
    r.normalized.sla_tiers_supported,
    function (v) { return Array.isArray(v) && v.length === 1 && v[0] === 'standard'; },
    'expected ["standard"]'
  );
})();

// ── Spoken languages allowlist ────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({ spoken_languages: ['en', 'ar', 'klingon'] }), 'en');
  expect(
    'spoken_languages with "klingon" → fails',
    r.ok,
    function (v) { return v === false; },
    'expected ok=false'
  );
})();

// ── Cap enforcement ───────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup(validBody({
    secondary_specialty_ids: ['a', 'b', 'c', 'd', 'e']
  }), 'en');
  expect(
    'secondary_specialty_ids cap → 5 → fails (max 4)',
    r.ok,
    function (v) { return v === false; },
    'expected ok=false'
  );
})();
(function () {
  var many = [];
  for (var i = 0; i < 9; i++) many.push('Sub' + i);
  var r = validateDoctorSignup(validBody({ sub_specialties: many }), 'en');
  expect(
    'sub_specialties cap → 9 entries → fails (max 8)',
    r.ok,
    function (v) { return v === false; },
    'expected ok=false'
  );
})();

// ── Repeater normalization ────────────────────────────────────────────
(function () {
  // Mix of valid + empty rows — empties should be dropped, not counted.
  var r = validateDoctorSignup(validBody({
    certifications: [
      { name: 'Board Cardiology', body: 'Egypt', year: '2015' },
      { name: '', body: '', year: '' },
      { name: 'Echo Fellowship', body: 'ASE', year: '2018' }
    ]
  }), 'en');
  expect(
    'certifications: empty row dropped, others kept',
    r.normalized.certifications,
    function (v) { return Array.isArray(v) && v.length === 2 && v[0].name === 'Board Cardiology'; },
    'expected 2 entries'
  );
})();

// ── Consent gate ──────────────────────────────────────────────────────
['consent_accuracy', 'consent_terms', 'consent_audit_log', 'consent_pii'].forEach(function (key) {
  (function () {
    var body = validBody();
    delete body[key];
    var r = validateDoctorSignup(body, 'en');
    expect(
      'missing consent "' + key + '" → fails',
      r.ok === false && r.errors.some(function (m) { return /consent|الموافقة/i.test(m); }),
      function (v) { return v === true; },
      'expected ok=false with consent error'
    );
  })();
});

// ── AR localization ──────────────────────────────────────────────────
(function () {
  var r = validateDoctorSignup({ name: '', email: '', password: '' }, 'ar');
  expect(
    'AR localization: error messages contain Arabic characters',
    r.errors,
    function (errs) { return errs.length > 0 && /[؀-ۿ]/.test(errs[0]); },
    'expected first error to contain Arabic'
  );
})();

// ── Bracketed-key body shape (form-encoded arrays) ───────────────────
(function () {
  // Simulate what some body-parsers send: keys with literal "[]" suffixes.
  var body = validBody();
  delete body.spoken_languages;
  body['spoken_languages[]'] = ['en', 'ar'];
  delete body.sla_tiers_supported;
  body['sla_tiers_supported[]'] = ['standard'];
  var r = validateDoctorSignup(body, 'en');
  expect(
    'bracketed-key shape (spoken_languages[], sla_tiers_supported[]) is accepted',
    r.ok,
    function (v) { return v === true; },
    'expected ok=true with bracketed array keys'
  );
})();
