// src/services/doctor_welcome_payload.js
//
// PURE builder for the doctor "welcome" notification payload (the object passed
// as queueMultiChannelNotification.response for template 'doctor_approved').
// No DB, no req — given a doctor row, a token, and a baseUrl, it returns the
// same payload shape the web superadmin flow produces.
//
// Extracted into its own module (rather than importing from the live
// superadmin.js route file) so the Command-side invite service can reuse the
// EXACT magic-link/payload construction with ZERO risk to the web approve /
// resend-welcome flow. superadmin.js is intentionally left untouched — its
// _issueDoctorWelcomePayload (src/routes/superadmin.js:3132) remains the source
// of truth this mirrors verbatim (link shape, Dr./د. strip, expiry, copy alias).

'use strict';

// 7-day magic-login validity. SINGLE SOURCE (Task 25): superadmin.js and
// admin_doctor_invite.js import this constant — do not redeclare it elsewhere.
const WELCOME_EXPIRY_HOURS = 168;

// Strip an English "Dr." or Arabic "د." prefix. Mirrors superadmin.js:3181 and
// openclawTemplates.js stripDr(). Doctor names are frequently stored
// already-prefixed ("Dr. Ahmed Hassan"), and the template hardcodes both
// "د. {{nameAr}}" and "Dr. {{firstName}}" — without this the greeting doubles
// up ("د. Dr. Ahmed Hassan"). Idempotent on an unprefixed name.
const DR_PREFIX_RE = /^\s*(?:Dr\.?|د\.?)\s+/i;
function stripDrPrefix(raw) {
  return String(raw == null ? '' : raw).trim().replace(DR_PREFIX_RE, '').trim();
}

/**
 * Build the welcome-notification payload. Pure: no side effects.
 * @param {{ doctor: { name?: string|null, name_ar?: string|null, lang?: string|null,
 *   specialty_name?: string|null, specialty_name_ar?: string|null },
 *   token: string|null, baseUrl: string|null }} args
 * @returns {{ doctorName: string, firstName: string, nameAr: string,
 *   specialtyAr: string, specialtyEn: string, magicLinkUrl: string|null,
 *   password_setup_link: string|null, portalUrl: string|null, expiryDays: number, lang: string }}
 */
function buildDoctorWelcomePayload({ doctor, token, baseUrl } = {}) {
  const d = doctor || {};
  const lang = (d.lang === 'ar') ? 'ar' : 'en';

  // Normalize baseUrl the same way the web helper does (trim, drop trailing
  // slashes). A null/empty baseUrl yields null links — the email gates its CTA
  // on magicLinkUrl, so this degrades gracefully rather than throwing.
  const base = baseUrl ? String(baseUrl).trim().replace(/\/+$/, '') : '';
  const magicLinkUrl = base && token ? `${base}/magic-login/${token}?lang=${lang}` : null;
  const portalUrl = base ? `${base}/portal/doctor/today` : null;

  // Strip an English "Dr." or Arabic "د." prefix, take the first whitespace
  // token; fall back to the localized "Doctor" label. Mirrors
  // superadmin.js:3175-3178 (and openclawTemplates.js stripDr()).
  const stripped = stripDrPrefix(d.name);
  const firstName = stripped.split(/\s+/)[0] || (lang === 'ar' ? 'الطبيب' : 'Doctor');

  // FULL (not first-token) Arabic name for the template's "د. {{nameAr}}،"
  // greeting. users.name_ar is nullable — 1 of the 29 active doctors has none —
  // so fall back to users.name rather than leaving a gap in the salutation.
  // The fallback is a Latin-script name inside an Arabic line; that is
  // deliberate and still reads correctly next to the "د." title. Both sources
  // get the same Dr./د. strip so a stored prefix can't double up. The final
  // 'الطبيب' fallback is unreachable today (0 active doctors lack `name`).
  const nameAr = stripDrPrefix(d.name_ar) || stripped || 'الطبيب';

  // Specialty labels, gated in the template by {{#if specialtyAr/specialtyEn}}
  // so a doctor with no specialty simply loses the clause instead of rendering
  // "as a  consultant". Empty string (not null) keeps the {{#if}} falsy and the
  // {{...}} output blank if the guard were ever removed. Cross-language
  // fallback: specialties.name / name_ar are both nullable, so a half-seeded
  // row still labels both blocks rather than dropping one silently.
  const specName = String(d.specialty_name || '').trim();
  const specNameAr = String(d.specialty_name_ar || '').trim();
  const specialtyAr = specNameAr || specName;
  const specialtyEn = specName || specNameAr;

  return {
    doctorName: d.name || (lang === 'ar' ? 'الطبيب' : 'Doctor'),
    firstName,
    nameAr,
    specialtyAr,
    specialtyEn,
    magicLinkUrl,
    // Ziad-locked bilingual welcome copy references {{password_setup_link}};
    // expose it as an alias of magicLinkUrl so the template renders with no
    // template-side fallback logic (matches superadmin.js:3187).
    password_setup_link: magicLinkUrl,
    portalUrl,
    expiryDays: Math.round(WELCOME_EXPIRY_HOURS / 24),
    lang,
  };
}

module.exports = { buildDoctorWelcomePayload, WELCOME_EXPIRY_HOURS };
