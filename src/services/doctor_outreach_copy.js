// src/services/doctor_outreach_copy.js
//
// Finished noun phrases for the tier-confirmation email, built in code rather
// than in Handlebars.
//
// "We have already ticked all 1 of the services in your specialty for you"
// reached a real inbox on 2026-08-29. Handlebars has no pluralisation, and the
// usual workaround — a {{#if}} on the count — only solves English.
//
// Arabic needs four forms, not two:
//   1        singular          الخدمة الوحيدة
//   2        DUAL              الخدمتين
//   3-10     plural of paucity الخدمات الثلاث / العشر
//   11+      singular after the numeral   ١١ خدمة
// A plural 's' transplanted onto Arabic is wrong in three of those four cases,
// so the phrase is assembled here where the rules can actually be expressed.

// Feminine forms — خدمة (service) is a feminine noun.
const AR_3_TO_10 = {
  3: 'الثلاث', 4: 'الأربع', 5: 'الخمس', 6: 'الست',
  7: 'السبع', 8: 'الثماني', 9: 'التسع', 10: 'العشر',
};

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
function toArabicNumerals(n) {
  return String(n).split('').map((c) => (/[0-9]/.test(c) ? AR_DIGITS[Number(c)] : c)).join('');
}

/** e.g. "all 9 services in your specialty" / "the single service in your specialty" */
function servicesPhraseEn(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 'the services in your specialty';
  if (n === 1) return 'the one service in your specialty';
  return `all ${n} services in your specialty`;
}

/** The Arabic counterpart, with the dual and the paucal handled properly. */
function servicesPhraseAr(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 'الخدمات في تخصصك';
  if (n === 1) return 'الخدمة الوحيدة في تخصصك';
  if (n === 2) return 'الخدمتين في تخصصك';
  if (n >= 3 && n <= 10) return `الخدمات ${AR_3_TO_10[n]} في تخصصك`;
  // 11 and above: numeral, then the noun in the singular.
  return `الـ ${toArabicNumerals(n)} خدمة في تخصصك`;
}

/** "Dr. Ali" from "Dr. Ali Khaled Mohamed" — same strip as doctor-welcome. */
function firstNameOf(name, lang) {
  const stripped = String(name || '').trim().replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim();
  const first = stripped.split(/\s+/)[0];
  if (first) return first;
  return lang === 'ar' ? 'الطبيب' : 'Doctor';
}

/**
 * The Arabic greeting used to print the full Latin name mid-sentence
 * ("عزيزي د. Test Doctor Ortho،") because it fell back to `name` when name_ar
 * was empty. Prefer the Arabic name, then the Arabic FIRST name, then the
 * Latin first name — never the whole Latin string.
 */
function firstNameArOf(nameAr, name) {
  const ar = firstNameOf(nameAr, 'ar');
  if (ar && ar !== 'الطبيب') return ar;
  return firstNameOf(name, 'ar');
}

// Overridable so the date is a setting, not a template edit. Empty string
// switches the launch-date paragraph off entirely (the template guards on it).
function launchDates() {
  const en = process.env.LAUNCH_DATE_EN;
  const ar = process.env.LAUNCH_DATE_AR;
  return {
    launchDate: en === undefined ? '3 September' : String(en),
    launchDateAr: ar === undefined ? '٣ سبتمبر' : String(ar),
  };
}

module.exports = {
  servicesPhraseEn, servicesPhraseAr,
  firstNameOf, firstNameArOf, launchDates, toArabicNumerals,
};
