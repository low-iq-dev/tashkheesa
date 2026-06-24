'use strict';

// Server-side validation + normalization for the PUBLIC doctor-application form
// (GET/POST /apply). Uses express-validator — the repo pattern for public form
// POSTs (see routes/static-pages.js /contact + /api/pre-launch-interest).
//
// Field rules:
//  - full_name (req), email (req, valid), phone (req) — minimum to triage + later promote.
//  - specialty_id (req) MUST be a taxonomy id OR the literal 'other'.
//  - specialty_other is REQUIRED-IF specialty_id === 'other' (per-field message; not a DB constraint).
//  - sub_specialties: optional array, <= 20 items (anti-spam ceiling), each a
//    string <= 100 chars. NEVER validated against the taxonomy — the taxonomy is
//    suggestions only and doctors may free-add. Empties/dupes are dropped at
//    normalization, never used to reject.
//  - everything else optional with sane length caps.

const { body } = require('express-validator');
const taxonomy = require('../services/specialties_taxonomy');

const MAX_SUB = 20;
const MAX_SUB_LEN = 100;

// Clean a sub_specialties array: keep strings, trim, drop empties, de-dupe
// (case-insensitive), preserve the surviving values VERBATIM. Membership in the
// taxonomy is intentionally never consulted.
function normalizeSubSpecialties(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const rawItem of input) {
    if (typeof rawItem !== 'string') continue;
    const v = rawItem.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const applyValidators = [
  body('full_name').trim().notEmpty().withMessage('full_name_required')
    .bail().isLength({ min: 2, max: 120 }).withMessage('full_name_length'),

  body('full_name_ar').optional({ checkFalsy: true }).trim().isLength({ max: 120 }).withMessage('full_name_ar_length'),

  body('email').trim().notEmpty().withMessage('email_required')
    .bail().isEmail().withMessage('email_invalid').isLength({ max: 254 }).withMessage('email_length'),

  body('phone').trim().notEmpty().withMessage('phone_required')
    .bail().isLength({ max: 32 }).withMessage('phone_length'),

  body('specialty_id').trim().notEmpty().withMessage('specialty_required')
    .bail().custom((v) => {
      if (v === 'other') return true;
      if (!taxonomy.isValidSpecialtyId(v)) throw new Error('specialty_invalid');
      return true;
    }),

  body('specialty_other').custom((value, { req }) => {
    // Only validated when it will actually be stored (specialty_id === 'other').
    // Otherwise the value is discarded by buildApplicationRecord, so a stale
    // value left in the hidden field must never reject an otherwise-valid form.
    const isOther = String(req.body && req.body.specialty_id) === 'other';
    if (!isOther) return true;
    const v = value == null ? '' : String(value).trim();
    if (!v) throw new Error('specialty_other_required');
    if (v.length > 160) throw new Error('specialty_other_length');
    return true;
  }),

  body('sub_specialties').optional().custom((v) => {
    if (!Array.isArray(v)) throw new Error('sub_specialties_must_be_array');
    if (v.length > MAX_SUB) throw new Error('sub_specialties_too_many');
    for (const item of v) {
      if (typeof item !== 'string') throw new Error('sub_specialties_must_be_strings');
      if (item.trim().length > MAX_SUB_LEN) throw new Error('sub_specialties_item_too_long');
    }
    return true;
  }),

  body('medical_license_number').optional({ checkFalsy: true }).trim().isLength({ max: 60 }).withMessage('license_length'),
  body('license_country').optional({ checkFalsy: true }).trim().isLength({ max: 60 }).withMessage('license_country_length'),
  body('current_affiliation').optional({ checkFalsy: true }).trim().isLength({ max: 160 }).withMessage('affiliation_length'),
  body('cv_url').optional({ checkFalsy: true }).trim().isURL().withMessage('cv_url_invalid').bail().isLength({ max: 500 }).withMessage('cv_url_length'),
  body('bio').optional({ checkFalsy: true }).trim().isLength({ max: 4000 }).withMessage('bio_length'),
  body('bio_ar').optional({ checkFalsy: true }).trim().isLength({ max: 4000 }).withMessage('bio_ar_length'),
  body('years_experience').optional({ checkFalsy: true }).isInt({ min: 0, max: 80 }).withMessage('years_invalid'),
];

// Trim → null-if-empty → length cap.
function s(v, max) {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  return max ? t.slice(0, max) : t;
}

// Merge the no-JS textarea fallback (`sub_specialties_text`, comma/newline
// separated) and the JS-enhanced `sub_specialties[]` hidden inputs into a single
// `req.body.sub_specialties` array, IN PLACE, BEFORE the validator chains run —
// so both submission paths validate identically. Items are kept raw (including
// non-strings) so the chain can still reject malformed input.
function coerceSubSpecialties(req, res, next) {
  let arr = [];
  const a = req.body ? req.body.sub_specialties : undefined;
  if (Array.isArray(a)) arr = a.slice();
  else if (a !== undefined && a !== null && a !== '') arr = [a];
  const txt = req.body ? req.body.sub_specialties_text : undefined;
  if (typeof txt === 'string' && txt.trim()) arr = arr.concat(txt.split(/[\n,]/));
  if (!req.body) req.body = {};
  req.body.sub_specialties = arr;
  next();
}

// Build the normalized record to INSERT. Assumes validation has passed.
function buildApplicationRecord(req) {
  const b = req.body || {};
  const specialtyId = s(b.specialty_id, 100);
  const isOther = specialtyId === 'other';
  let years = null;
  if (b.years_experience != null && String(b.years_experience).trim() !== '') {
    const n = parseInt(String(b.years_experience).trim(), 10);
    if (Number.isInteger(n)) years = n;
  }
  const email = s(b.email, 254);
  return {
    full_name: s(b.full_name, 120),
    full_name_ar: s(b.full_name_ar, 120),
    email: email ? email.toLowerCase() : null,
    phone: s(b.phone, 32),
    specialty_id: specialtyId,
    specialty_other: isOther ? s(b.specialty_other, 160) : null,
    sub_specialties: normalizeSubSpecialties(b.sub_specialties),
    medical_license_number: s(b.medical_license_number, 60),
    license_country: s(b.license_country, 60),
    bio: s(b.bio, 4000),
    bio_ar: s(b.bio_ar, 4000),
    cv_url: s(b.cv_url, 500),
    current_affiliation: s(b.current_affiliation, 160),
    years_experience: years,
    source: 'web_apply',
    submitter_ip: s(req.ip || (req.connection && req.connection.remoteAddress) || '', 64),
    user_agent: s(req.get ? req.get('user-agent') : '', 500),
  };
}

module.exports = { applyValidators, coerceSubSpecialties, normalizeSubSpecialties, buildApplicationRecord };
