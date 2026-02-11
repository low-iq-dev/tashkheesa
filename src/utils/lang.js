/**
 * Centralized language handling utilities.
 * Single source of truth for language normalization across the application.
 * Supports: English ('en'), Arabic ('ar')
 */

const SUPPORTED_LANGS = new Set(['en', 'ar']);
const DEFAULT_LANG = 'en';

function normalizeLang(raw) {
  const v = String(raw || '').toLowerCase().trim();
  return SUPPORTED_LANGS.has(v) ? v : DEFAULT_LANG;
}

function getDir(lang) {
  const normalized = normalizeLang(lang);
  return normalized === 'ar' ? 'rtl' : 'ltr';
}

function isArabic(lang) {
  return normalizeLang(lang) === 'ar';
}

function isEnglish(lang) {
  return normalizeLang(lang) === 'en';
}

module.exports = {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  normalizeLang,
  getDir,
  isArabic,
  isEnglish
};
