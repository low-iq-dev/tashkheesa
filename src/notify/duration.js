// src/notify/duration.js
//
// Bilingual "time remaining" formatting for deadline notifications.
//
// ── Why this exists (regression F13) ────────────────────────────────────────
//
// The SLA-reminder path floored the remaining time to whole hours and rendered
// `{{hoursRemaining}} hours`. Two things were wrong with that:
//
//   1. The 1h tier fires at any point inside the final hour, so 3000 seconds
//      floored to the STRING "0" — which is truthy, so `{{#if hoursRemaining}}`
//      passed and the patient's and doctor's email both read
//      "Time Left: 0 hours" fifty minutes before a medical deadline.
//
//   2. Arabic has four number-agreement forms and the template hardcoded one
//      of them ("ساعة"), which is correct for 1 and for 11+ and WRONG for the
//      6h tier — the most common non-trivial value — where it must be "ساعات".
//
// Handlebars has neither arithmetic nor plural rules, so this belongs in code.
// Shared between the email path (notification_worker.processEmail) and the
// WhatsApp path (notify/openclawTemplates) so the two surfaces cannot drift:
// the 6h OpenClaw body had the same "1 ساعات" defect independently.
//
// Arabic forms follow the same Cairene, gender-neutral register as
// openclawTemplates.js: dual is the colloquial "ساعتين" / "دقيقتين", not the
// MSA nominative "ساعتان".

/**
 * Arabic number agreement.
 *   1      → singular   ("ساعة واحدة")
 *   2      → dual       ("ساعتين")
 *   3–10   → plural     ("5 ساعات")
 *   11+    → singular accusative after the numeral ("24 ساعة")
 */
function arabicCount(n, { one, two, few, many }) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return n + ' ' + few;
  return n + ' ' + many;
}

function englishCount(n, unit) {
  return n + ' ' + unit + (n === 1 ? '' : 's');
}

/**
 * Render a remaining-time countdown for display.
 *
 * Under one hour it switches to minutes rather than rendering a floored "0",
 * which is the whole point: a reminder whose entire purpose is urgency must
 * not print the least urgent possible number.
 *
 * @param {number|string} seconds - Seconds remaining. Non-finite or <= 0
 *   returns '' so the caller's `{{#if}}` suppresses the row entirely rather
 *   than showing a zero or a negative to a patient.
 * @param {string} [lang='en'] - 'ar' | 'en'
 * @returns {string} e.g. "6 hours" / "6 ساعات" / "50 minutes" / "50 دقيقة"
 */
function formatTimeRemaining(seconds, lang) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';

  const isAr = String(lang || 'en').toLowerCase() === 'ar';
  const totalMinutes = Math.floor(s / 60);
  if (totalMinutes <= 0) return '';

  if (totalMinutes < 60) {
    return isAr
      ? arabicCount(totalMinutes, { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' })
      : englishCount(totalMinutes, 'minute');
  }

  const hours = Math.floor(totalMinutes / 60);
  return isAr
    ? arabicCount(hours, { one: 'ساعة واحدة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' })
    : englishCount(hours, 'hour');
}

module.exports = { formatTimeRemaining };
