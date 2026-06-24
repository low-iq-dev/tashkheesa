'use strict';

// Loads the canonical specialty taxonomy (src/data/tashkheesa_specialties.json)
// ONCE at module init and exposes the lookups used by BOTH the /apply form
// render and the server-side validator — a single source of truth so the form
// options and the specialty_id allowlist can never drift apart.
//
// IMPORTANT: each specialty's `sub_specialties` are SUGGESTIONS / autocomplete
// only. They are NEVER used to validate a submitted sub-specialty — doctors may
// free-add anything. See validators/apply.js.

const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(__dirname, '..', 'data', 'tashkheesa_specialties.json');

let raw;
try {
  raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
} catch (err) {
  // Fail loud at boot — a missing/broken taxonomy is a deploy-blocking error,
  // not something to silently degrade.
  throw new Error('[specialties_taxonomy] failed to load ' + DATA_PATH + ': ' + err.message);
}

const SPECIALTIES = Array.isArray(raw && raw.specialties) ? raw.specialties : [];
const BY_ID = new Map(SPECIALTIES.map((sp) => [sp.id, sp]));

// Defensive copy so callers (views, validators) cannot mutate the cached data.
function getSpecialties() {
  return SPECIALTIES.map((sp) => ({
    id: sp.id,
    label_en: sp.label_en,
    label_ar: sp.label_ar,
    sub_specialties: Array.isArray(sp.sub_specialties) ? sp.sub_specialties.slice() : [],
  }));
}

function isValidSpecialtyId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

function subSpecialtiesFor(id) {
  const sp = BY_ID.get(id);
  return sp && Array.isArray(sp.sub_specialties) ? sp.sub_specialties.slice() : [];
}

function labelFor(id, lang) {
  const sp = BY_ID.get(id);
  if (!sp) return null;
  return (String(lang).toLowerCase() === 'ar' && sp.label_ar) ? sp.label_ar : sp.label_en;
}

module.exports = { getSpecialties, isValidSpecialtyId, subSpecialtiesFor, labelFor };
