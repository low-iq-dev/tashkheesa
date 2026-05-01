// src/validators/doctor_signup.js
// Pure validation for the multi-step doctor signup form.
//
// Returns { ok, errors, normalized }:
//   - ok        boolean — false if any required field failed shape validation
//   - errors    Array<string> — localized error messages, in submission order
//   - normalized object — sanitized payload ready for INSERT (strings trimmed,
//                         arrays coerced from form-encoded scalars, ints parsed,
//                         consents coerced to booleans). Even on validation
//                         failure the partial normalized object is returned so
//                         the form can be re-rendered with the user's typed
//                         values intact.
//
// This module is pure: no DB calls, no env lookups, no side effects. The
// handler in src/routes/auth.js is responsible for the async checks
// (email-uniqueness, FK existence, services-belong-to-picked-specialty)
// after this synchronous validator returns ok=true.

'use strict';

// Allowlists. Mirror the patient-side ALLOWED_COUNTRY_CODES set in
// src/routes/auth.js — keep the two in sync if either is widened.
var ALLOWED_COUNTRY_CODES = ['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM'];
var ALLOWED_LANGUAGES = ['en', 'ar', 'fr', 'de', 'es', 'it', 'tr'];
var ALLOWED_SLA_TIERS = ['standard', 'vip', 'urgent'];
var ALLOWED_GENDERS = ['m', 'f', 'other', 'prefer_not_to_say'];

// Small helpers — scoped local so the module exports stay clean.
function _str(v, max) {
  if (v == null) return '';
  var s = String(v).trim();
  if (typeof max === 'number' && s.length > max) s = s.slice(0, max);
  return s;
}
function _int(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return (Number.isFinite(n) && Math.floor(n) === n) ? n : NaN;
}
function _arr(v) {
  if (Array.isArray(v)) return v.filter(function(x) { return x != null && x !== ''; });
  if (v == null || v === '') return [];
  return [v];
}
function _bool(v) {
  if (v === true) return true;
  if (v === 'on' || v === 'true' || v === '1' || v === 1) return true;
  return false;
}

// Localized error message helper. Picks AR if lang='ar', else EN.
function _e(lang) {
  var ar = lang === 'ar';
  return {
    name_required:                 ar ? 'الاسم الكامل مطلوب.' : 'Full name is required.',
    name_too_long:                 ar ? 'الاسم طويل جداً (الحد الأقصى 200 حرفاً).' : 'Name is too long (max 200 chars).',
    name_ar_too_long:              ar ? 'الاسم بالعربية طويل جداً (الحد الأقصى 200 حرفاً).' : 'Arabic name is too long (max 200 chars).',
    email_required:                ar ? 'البريد الإلكتروني مطلوب.' : 'Email is required.',
    email_invalid:                 ar ? 'صيغة البريد الإلكتروني غير صحيحة.' : 'Invalid email format.',
    password_required:             ar ? 'كلمة المرور مطلوبة.' : 'Password is required.',
    password_too_short:            ar ? 'يجب أن تكون كلمة المرور 8 أحرف على الأقل.' : 'Password must be at least 8 characters.',
    phone_required:                ar ? 'رقم الهاتف مطلوب.' : 'Phone is required.',
    phone_too_long:                ar ? 'رقم الهاتف طويل جداً.' : 'Phone is too long.',
    country_invalid:               ar ? 'يرجى اختيار دولة صحيحة.' : 'Please select a valid country.',
    dob_invalid:                   ar ? 'تاريخ الميلاد غير صالح.' : 'Invalid date of birth.',
    age_out_of_range:              ar ? 'يجب أن يكون العمر بين 22 و 80 سنة.' : 'Age must be between 22 and 80.',
    gender_invalid:                ar ? 'الجنس غير صالح.' : 'Invalid gender.',
    national_id_required:          ar ? 'الرقم القومي مطلوب.' : 'National ID is required.',
    national_id_too_long:          ar ? 'الرقم القومي طويل جداً.' : 'National ID is too long.',
    primary_specialty_required:    ar ? 'يرجى اختيار التخصص الرئيسي.' : 'Primary specialty is required.',
    secondary_specialties_too_many: ar ? 'الحد الأقصى 4 تخصصات إضافية.' : 'Maximum 4 secondary specialties.',
    sub_specialty_too_long:        ar ? 'كل تخصص فرعي يجب أن يكون أقل من 100 حرف.' : 'Each sub-specialty must be under 100 chars.',
    sub_specialties_too_many:      ar ? 'الحد الأقصى 8 تخصصات فرعية.' : 'Maximum 8 sub-specialties.',
    license_number_required:       ar ? 'رقم الترخيص مطلوب.' : 'Medical license number is required.',
    license_number_too_long:       ar ? 'رقم الترخيص طويل جداً.' : 'License number is too long.',
    license_country_invalid:       ar ? 'دولة الترخيص غير صالحة.' : 'Invalid license country.',
    medical_school_required:       ar ? 'الكلية الطبية مطلوبة.' : 'Medical school is required.',
    medical_school_too_long:       ar ? 'اسم الكلية طويل جداً.' : 'Medical school name is too long.',
    graduation_year_invalid:       ar ? 'سنة التخرج يجب أن تكون بين 1950 والسنة الحالية.' : 'Graduation year must be between 1950 and the current year.',
    years_experience_invalid:      ar ? 'سنوات الخبرة يجب أن تكون بين 0 و 60.' : 'Years of experience must be between 0 and 60.',
    certifications_too_many:       ar ? 'الحد الأقصى 10 شهادات.' : 'Maximum 10 certifications.',
    affiliations_too_many:         ar ? 'الحد الأقصى 10 جهات.' : 'Maximum 10 affiliations.',
    spoken_languages_invalid:      ar ? 'لغة غير مدعومة.' : 'Unsupported language.',
    spoken_languages_too_many:     ar ? 'الحد الأقصى 7 لغات.' : 'Maximum 7 languages.',
    sla_tier_invalid:              ar ? 'مستوى SLA غير صالح.' : 'Invalid SLA tier.',
    bio_too_long:                  ar ? 'السيرة طويلة جداً (الحد الأقصى 2000 حرف).' : 'Bio is too long (max 2000 chars).',
    consent_required:              ar ? 'يجب الموافقة على جميع البنود قبل المتابعة.' : 'All consents must be checked to continue.'
  };
}

// Email regex — pragmatic, not RFC-perfect. Same shape used elsewhere
// in the codebase (api/auth.js relies on express-validator's isEmail
// which accepts the same set; this regex matches that practical set).
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the multi-step doctor signup payload.
 *
 * @param {Object} body  — raw req.body
 * @param {string} lang  — 'ar' or 'en' for error message localization
 * @returns {{ ok: boolean, errors: string[], normalized: Object }}
 */
function validateDoctorSignup(body, lang) {
  var b = body || {};
  var msg = _e(lang === 'ar' ? 'ar' : 'en');
  var errors = [];
  var n = {};

  // ─── Step 1 — identity & contact ──────────────────────────────────

  n.name = _str(b.name, 200);
  if (!n.name) errors.push(msg.name_required);
  else if (n.name.length > 200) errors.push(msg.name_too_long);

  n.name_ar = _str(b.name_ar, 200);
  if (n.name_ar.length > 200) errors.push(msg.name_ar_too_long);

  n.email = _str(b.email, 320).toLowerCase();
  if (!n.email) errors.push(msg.email_required);
  else if (!EMAIL_RE.test(n.email)) errors.push(msg.email_invalid);

  n.password = b.password == null ? '' : String(b.password);
  if (!n.password) errors.push(msg.password_required);
  else if (n.password.length < 8) errors.push(msg.password_too_short);

  n.phone = _str(b.phone, 30);
  if (!n.phone) errors.push(msg.phone_required);
  else if (n.phone.length > 30) errors.push(msg.phone_too_long);

  n.country_code = _str(b.country_code, 2).toUpperCase();
  if (!n.country_code || ALLOWED_COUNTRY_CODES.indexOf(n.country_code) === -1) {
    errors.push(msg.country_invalid);
  }

  n.date_of_birth = _str(b.date_of_birth, 10);
  if (n.date_of_birth) {
    if (!ISO_DATE_RE.test(n.date_of_birth)) {
      errors.push(msg.dob_invalid);
    } else {
      var dob = new Date(n.date_of_birth + 'T00:00:00Z');
      if (isNaN(dob.getTime())) {
        errors.push(msg.dob_invalid);
      } else {
        var ageMs = Date.now() - dob.getTime();
        var ageYrs = ageMs / (365.25 * 24 * 60 * 60 * 1000);
        if (ageYrs < 22 || ageYrs > 80) errors.push(msg.age_out_of_range);
      }
    }
  }

  n.gender = _str(b.gender, 32);
  if (n.gender && ALLOWED_GENDERS.indexOf(n.gender) === -1) {
    errors.push(msg.gender_invalid);
  }

  n.national_id = _str(b.national_id, 30);
  if (!n.national_id) errors.push(msg.national_id_required);
  else if (n.national_id.length > 30) errors.push(msg.national_id_too_long);

  // ─── Step 2 — credentials & experience ────────────────────────────

  n.specialty_id = _str(b.specialty_id, 100);
  if (!n.specialty_id) errors.push(msg.primary_specialty_required);

  n.secondary_specialty_ids = _arr(b['secondary_specialty_ids[]'] || b.secondary_specialty_ids)
    .map(function(s) { return _str(s, 100); })
    .filter(function(s) { return s && s !== n.specialty_id; });
  if (n.secondary_specialty_ids.length > 4) {
    errors.push(msg.secondary_specialties_too_many);
    n.secondary_specialty_ids = n.secondary_specialty_ids.slice(0, 4);
  }

  n.sub_specialties = _arr(b['sub_specialties[]'] || b.sub_specialties)
    .map(function(s) { return _str(s, 100); })
    .filter(Boolean);
  if (n.sub_specialties.length > 8) {
    errors.push(msg.sub_specialties_too_many);
    n.sub_specialties = n.sub_specialties.slice(0, 8);
  }
  n.sub_specialties.forEach(function(s) {
    if (s.length > 100) errors.push(msg.sub_specialty_too_long);
  });

  n.medical_license_number = _str(b.medical_license_number, 100);
  if (!n.medical_license_number) errors.push(msg.license_number_required);
  else if (n.medical_license_number.length > 100) errors.push(msg.license_number_too_long);

  n.license_country = _str(b.license_country, 2).toUpperCase();
  if (!n.license_country || ALLOWED_COUNTRY_CODES.indexOf(n.license_country) === -1) {
    errors.push(msg.license_country_invalid);
  }

  n.medical_school = _str(b.medical_school, 200);
  if (!n.medical_school) errors.push(msg.medical_school_required);
  else if (n.medical_school.length > 200) errors.push(msg.medical_school_too_long);

  var thisYear = new Date().getUTCFullYear();
  var gy = _int(b.graduation_year);
  if (gy === null || isNaN(gy) || gy < 1950 || gy > thisYear) {
    errors.push(msg.graduation_year_invalid);
    n.graduation_year = null;
  } else {
    n.graduation_year = gy;
  }

  var ye = _int(b.years_of_experience);
  if (ye === null || isNaN(ye) || ye < 0 || ye > 60) {
    errors.push(msg.years_experience_invalid);
    n.years_of_experience = null;
  } else {
    n.years_of_experience = ye;
  }

  // Repeater fields. Express body-parser hands these in as either an
  // array of objects (when the form uses certifications[0][name]) or
  // as parallel arrays (certifications_name[], certifications_year[]).
  // We accept the array-of-objects shape and tolerate the parallel
  // shape too, normalizing each entry to {name, body, year}.
  n.certifications = _normalizeRepeater(b.certifications, ['name', 'body', 'year']);
  if (n.certifications.length > 10) {
    errors.push(msg.certifications_too_many);
    n.certifications = n.certifications.slice(0, 10);
  }

  n.affiliations = _normalizeRepeater(b.affiliations, ['name', 'role', 'year']);
  if (n.affiliations.length > 10) {
    errors.push(msg.affiliations_too_many);
    n.affiliations = n.affiliations.slice(0, 10);
  }

  n.spoken_languages = _arr(b['spoken_languages[]'] || b.spoken_languages)
    .map(function(s) { return _str(s, 8).toLowerCase(); })
    .filter(Boolean);
  if (n.spoken_languages.length > 7) {
    errors.push(msg.spoken_languages_too_many);
    n.spoken_languages = n.spoken_languages.slice(0, 7);
  }
  for (var i = 0; i < n.spoken_languages.length; i++) {
    if (ALLOWED_LANGUAGES.indexOf(n.spoken_languages[i]) === -1) {
      errors.push(msg.spoken_languages_invalid);
      break;
    }
  }

  // ─── Step 3 — service preferences & consent ───────────────────────

  n.service_ids = _arr(b['service_ids[]'] || b.service_ids)
    .map(function(s) { return _str(s, 100); })
    .filter(Boolean);

  n.sla_tiers_supported = _arr(b['sla_tiers_supported[]'] || b.sla_tiers_supported)
    .map(function(s) { return _str(s, 16).toLowerCase(); })
    .filter(Boolean);
  for (var j = 0; j < n.sla_tiers_supported.length; j++) {
    if (ALLOWED_SLA_TIERS.indexOf(n.sla_tiers_supported[j]) === -1) {
      errors.push(msg.sla_tier_invalid);
      break;
    }
  }
  // If the doctor unchecked everything, default to ['standard'] so the
  // jsonb column never lands empty (the column default is the same).
  if (n.sla_tiers_supported.length === 0) n.sla_tiers_supported = ['standard'];

  n.bio = _str(b.bio, 2000);
  if (n.bio.length > 2000) errors.push(msg.bio_too_long);

  n.bio_ar = _str(b.bio_ar, 2000);
  if (n.bio_ar.length > 2000) errors.push(msg.bio_too_long);

  // Consents — all four required. The `required` HTML attribute is a
  // first line; this is the second.
  n.consent_accuracy = _bool(b.consent_accuracy);
  n.consent_terms = _bool(b.consent_terms);
  n.consent_audit_log = _bool(b.consent_audit_log);
  n.consent_pii = _bool(b.consent_pii);
  if (!(n.consent_accuracy && n.consent_terms && n.consent_audit_log && n.consent_pii)) {
    errors.push(msg.consent_required);
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    normalized: n
  };
}

// Normalize a repeater field. Body-parser shape varies:
//
//   1. Array of objects (preferred form encoding):
//      certifications[0][name]=… → req.body.certifications = [{name:…, …}]
//   2. A single object when only one entry: { name:'', year:'' }
//   3. Parallel arrays (less common, e.g. certifications_name[]).
//
// We accept (1) and (2). For (3), the EJS form is responsible for using
// the [n][field] notation so we always end up with shape (1) or (2).
function _normalizeRepeater(raw, fieldNames) {
  if (!raw) return [];
  var rows;
  if (Array.isArray(raw)) rows = raw;
  else if (typeof raw === 'object') rows = [raw];
  else return [];

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var entry = {};
    var hasAny = false;
    for (var k = 0; k < fieldNames.length; k++) {
      var fn = fieldNames[k];
      var v = r[fn];
      if (v != null && String(v).trim() !== '') {
        entry[fn] = String(v).trim().slice(0, 200);
        hasAny = true;
      } else {
        entry[fn] = null;
      }
    }
    if (hasAny) out.push(entry);
  }
  return out;
}

module.exports = {
  validateDoctorSignup: validateDoctorSignup,
  ALLOWED_COUNTRY_CODES: ALLOWED_COUNTRY_CODES,
  ALLOWED_LANGUAGES: ALLOWED_LANGUAGES,
  ALLOWED_SLA_TIERS: ALLOWED_SLA_TIERS,
  ALLOWED_GENDERS: ALLOWED_GENDERS
};
