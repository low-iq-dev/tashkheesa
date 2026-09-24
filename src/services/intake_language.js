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
//   3. the account's users.lang — but only a language the person CHOSE
//      (accountLangIfChosen: lang_chosen_at set, migration 119, or a
//      non-default value). A bare 'en' with no timestamp is the column
//      DEFAULT, not a choice, and is skipped;
//   4. 'ar' — Arabic is the patient's language. Never a bare 'en' default.
//
// Launch-eve follow-up (2026-09-25): the same rule now covers the two paths
// that create most real cases — the app (resolveAppCaseLanguage: POST
// /api/v1/cases and the /cases/draft API) and the web wizard
// (resolveWebCaseLanguage: routes/patient.js). Both used to store 'en'.
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
 * users.lang if the person chose it, else null.
 * @param {{ lang?: string, lang_chosen_at?: any }|null} account  a users row
 */
function accountLangIfChosen(account) {
  if (!account || typeof account !== 'object') return null;
  const lang = _norm(account.lang);
  if (!lang) return null;
  if (account.lang_chosen_at) return lang;
  // No timestamp: only a NON-default value is evidence of a choice. The
  // column default is 'en' (migration 001), so a bare 'en' says nothing.
  return lang === 'en' ? null : lang;
}

/**
 * @param {object} req  express request (body, query, cookies, get)
 * @param {{ lang?: string, lang_chosen_at?: any }|null} [account]  the matched existing patient's users row
 * @returns {{ lang: 'ar'|'en', source: 'form'|'query'|'cookie'|'referer'|'account'|'default' }}
 */
function resolveIntakeLanguage(req, account) {
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

  const fromAccount = accountLangIfChosen(account);
  if (fromAccount) return { lang: fromAccount, source: 'account' };

  return { lang: 'ar', source: 'default' };
}

function _header(req, name) {
  return (req && typeof req.get === 'function') ? req.get(name) : (req && req.headers && req.headers[name.toLowerCase()]);
}

/**
 * The patient APP (POST /api/v1/cases, /api/v1/cases/draft*): the app's own
 * body field, then its locale header (X-App-Locale, else Accept-Language —
 * only the app calls these endpoints, so the header is the device/app
 * locale, not a browser default), then the account's chosen language, then 'ar'.
 */
function resolveAppCaseLanguage(req, account) {
  const body = (req && req.body) || {};
  const fromBody = _norm(body.language) || _norm(body.lang);
  if (fromBody) return { lang: fromBody, source: 'body' };
  const fromHeader = _norm(_header(req, 'x-app-locale')) ||
    _norm(String(_header(req, 'accept-language') || '').split(',')[0]);
  if (fromHeader) return { lang: fromHeader, source: 'header' };
  const fromAccount = accountLangIfChosen(account);
  if (fromAccount) return { lang: fromAccount, source: 'account' };
  return { lang: 'ar', source: 'default' };
}

/**
 * The WEB wizard (routes/patient.js): the explicit ?lang= / lang cookie (what
 * the EN/عربي toggle writes), then the account's chosen language, then 'ar'.
 * Deliberately NOT res.locals.lang, which falls back to 'en'.
 */
function resolveWebCaseLanguage(req, account) {
  const fromQuery = _norm(req && req.query && req.query.lang);
  if (fromQuery) return { lang: fromQuery, source: 'query' };
  const fromCookie = _norm(req && req.cookies && req.cookies.lang);
  if (fromCookie) return { lang: fromCookie, source: 'cookie' };
  const fromAccount = accountLangIfChosen(account);
  if (fromAccount) return { lang: fromAccount, source: 'account' };
  return { lang: 'ar', source: 'default' };
}

/** Read the users row the resolvers need. Never throws (null on failure). */
async function loadAccountLang(userId, queryOneFn) {
  if (!userId) return null;
  try {
    const q = queryOneFn || require('../pg').queryOne;
    return await q('SELECT lang, lang_chosen_at FROM users WHERE id = $1', [userId]);
  } catch (_) {
    return null;
  }
}

module.exports = { resolveIntakeLanguage, resolveAppCaseLanguage, resolveWebCaseLanguage, accountLangIfChosen, loadAccountLang };
