// src/utils/formatNumber.js
//
// Theme 10b Sub-issue C — locale-aware number + date rendering.
//
// Policy (OQ-2 hybrid, approved 2026-05-12):
//   - formatMoney    → ALWAYS Western digits, EGP-label-style. AR users see
//                      "EGP 1,500" not "EGP ١٬٥٠٠". Egyptian SaaS-Arabic
//                      convention (matches Talabat, Vodafone Cash). Lang
//                      argument is accepted but ignored for the digit
//                      rendering — kept for signature symmetry.
//   - formatNumber   → respects lang. AR → Arabic-Indic numerals via 'ar-EG'.
//                      Use for non-money counts (durations, item counts).
//   - formatDate     → respects lang. AR → Arabic-Indic dates via 'ar-EG'.
//   - formatDateTime → respects lang. Same.
//
// All helpers are null-safe: invalid / empty / NaN inputs return '' so
// templates can `<%= formatMoney(x, 'EGP') %>` without try/catch.

'use strict';

const AR_LOCALE = 'ar-EG';
const EN_LOCALE = 'en-GB'; // en-GB chosen to match the codebase's existing
                           // doctor_appointments.ejs convention; produces
                           // DD MMM YYYY (e.g. "12 May 2026").

function pickLocale(lang) {
  return (String(lang || '').toLowerCase() === 'ar') ? AR_LOCALE : EN_LOCALE;
}

function formatNumber(n, lang, opts) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString(pickLocale(lang), opts || {});
}

// Money is intentionally lang-agnostic per OQ-2. EN_LOCALE forces Western
// digits regardless of UI language. Currency label is concatenated as-is
// (no Intl.NumberFormat style:'currency' — we want the raw "EGP 1,500"
// shape, not "E£1,500" or the AR-locale variant).
function formatMoney(amount, currency, _lang) {
  if (amount == null || amount === '') return '';
  const num = Number(amount);
  if (!Number.isFinite(num)) return '';
  const formatted = num.toLocaleString(EN_LOCALE, { maximumFractionDigits: 0 });
  return (currency || 'EGP') + ' ' + formatted;
}

function formatDate(iso, lang, opts) {
  if (!iso) return '';
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(pickLocale(lang),
    opts || { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso, lang, opts) {
  if (!iso) return '';
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(pickLocale(lang),
    opts || { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  AR_LOCALE: AR_LOCALE,
  EN_LOCALE: EN_LOCALE,
  pickLocale: pickLocale,
  formatNumber: formatNumber,
  formatMoney: formatMoney,
  formatDate: formatDate,
  formatDateTime: formatDateTime
};
