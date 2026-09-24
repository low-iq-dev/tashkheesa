'use strict';

// src/services/intake_language.js
//
// Launch eve 2026-09-24 (T2). The language a website-intake case is written
// in. routes/api/cases_intake.js wrote orders.language = 'en' and
// cases.language = 'en' unconditionally, so every lead — most of them Arabic
// speakers — was stamped English, and everything downstream that reads the
// column (the doctor's report language guard, notification copy) followed it.
//
// Order of evidence, strongest first:
//   1. the form's own field (`language`, or `lang`) — the patient's choice;
//   2. the request's language: ?lang=, the lang cookie, or an /ar/ page in the
//      Referer (the intake form is cross-origin, so the cookie is usually
//      absent; the Referer path is what survives);
//   3. the account's users.lang, when the email matches an existing patient;
//   4. 'ar' — Arabic is the patient's language. Never a bare 'en' default.
//
// Deliberately NOT Accept-Language: routes/auth.js getReqLang falls back to
// 'en' for every non-Arabic browser header, which is exactly the bare-English
// default this exists to remove.

function _norm(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'ar' || s.startsWith('ar-') || s === 'arabic' || s === 'عربي' || s === 'العربية') return 'ar';
  if (s === 'en' || s.startsWith('en-') || s === 'english') return 'en';
  return null;
}

function _refererLang(referer) {
  if (!referer) return null;
  try {
    const p = new URL(String(referer)).pathname || '';
    return (p === '/ar' || p.startsWith('/ar/')) ? 'ar' : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} req  express request (body, query, cookies, get)
 * @param {string|null} [accountLang]  users.lang of the matched existing patient
 * @returns {{ lang: 'ar'|'en', source: 'form'|'query'|'cookie'|'referer'|'account'|'default' }}
 */
function resolveIntakeLanguage(req, accountLang) {
  const body = (req && req.body) || {};
  const fromForm = _norm(body.language) || _norm(body.lang);
  if (fromForm) return { lang: fromForm, source: 'form' };

  const fromQuery = _norm(req && req.query && req.query.lang);
  if (fromQuery) return { lang: fromQuery, source: 'query' };

  const fromCookie = _norm(req && req.cookies && req.cookies.lang);
  if (fromCookie) return { lang: fromCookie, source: 'cookie' };

  const referer = req && typeof req.get === 'function' ? (req.get('referer') || req.get('referrer')) : null;
  const fromReferer = _refererLang(referer);
  if (fromReferer) return { lang: fromReferer, source: 'referer' };

  const fromAccount = _norm(accountLang);
  if (fromAccount) return { lang: fromAccount, source: 'account' };

  return { lang: 'ar', source: 'default' };
}

module.exports = { resolveIntakeLanguage };
