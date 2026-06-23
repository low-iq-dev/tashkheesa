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

// 7-day magic-login validity. Mirrors superadmin.js WELCOME_EXPIRY_HOURS.
const WELCOME_EXPIRY_HOURS = 168;

/**
 * Build the welcome-notification payload. Pure: no side effects.
 * @param {{ doctor: { name?: string|null, lang?: string|null }, token: string|null, baseUrl: string|null }} args
 * @returns {{ doctorName: string, firstName: string, magicLinkUrl: string|null,
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
  const rawName = String(d.name || '').trim();
  const stripped = rawName.replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim();
  const firstName = stripped.split(/\s+/)[0] || (lang === 'ar' ? 'الطبيب' : 'Doctor');

  return {
    doctorName: d.name || (lang === 'ar' ? 'الطبيب' : 'Doctor'),
    firstName,
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
