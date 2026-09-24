'use strict';
// tests/core/launch-eve-case-language.test.js
//
// 2026-09-24 (launch eve, T2).
//   A. Website intake no longer stamps every case 'en': orders.language and
//      cases.language = form field → request language (?lang / cookie / an
//      /ar/ Referer) → users.lang → 'ar'. Drives the REAL POST /intake handler
//      with a recording fake pg client (same harness as
//      cases-intake-oncology-vip.test.js). Hermetic — no DATABASE_URL.
//   B. The doctor's report: on an 'ar' case a Recommendation that is not
//      Arabic (< 30% Arabic-script letters) is refused; Findings/Impression
//      only warn.

const path = require('path');
const fs = require('fs');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🗣️  case language: intake never defaults to English; Arabic cases get an Arabic recommendation\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const R = (p) => require.resolve(path.join(SRC, p));
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  // ── A1. the pure resolver ─────────────────────────────────────────────
  const { resolveIntakeLanguage } = require('../../src/services/intake_language');
  const req = (o) => Object.assign({ body: {}, query: {}, cookies: {}, get: () => null }, o);

  await check('A1 form field wins (language or lang)', () => {
    if (resolveIntakeLanguage(req({ body: { language: 'en' }, cookies: { lang: 'ar' } }), 'ar').lang !== 'en') throw new Error('language=en ignored');
    if (resolveIntakeLanguage(req({ body: { lang: 'ar' } }), 'en').lang !== 'ar') throw new Error('lang=ar ignored');
  });
  await check('A1 then ?lang, then the lang cookie', () => {
    if (resolveIntakeLanguage(req({ query: { lang: 'en' }, cookies: { lang: 'ar' } })).lang !== 'en') throw new Error('query');
    if (resolveIntakeLanguage(req({ cookies: { lang: 'en' } }), 'ar').lang !== 'en') throw new Error('cookie');
  });
  await check('A1 then an /ar/ page in the Referer (cross-origin form)', () => {
    const r = resolveIntakeLanguage(req({ get: (h) => (/refer/.test(h) ? 'https://tashkheesa.com/ar/services' : null) }), 'en');
    if (r.lang !== 'ar' || r.source !== 'referer') throw new Error(JSON.stringify(r));
  });
  await check('A1 then the account language, then Arabic — never a bare English default', () => {
    if (resolveIntakeLanguage(req({}), 'en').lang !== 'en') throw new Error('account en ignored');
    const d = resolveIntakeLanguage(req({ get: () => 'https://tashkheesa.com/services' }), null);
    if (d.lang !== 'ar' || d.source !== 'default') throw new Error('default is ' + JSON.stringify(d));
  });
  await check('A1 Accept-Language is NOT evidence (it defaults to English for every non-Arabic browser)', () => {
    const r = resolveIntakeLanguage(req({ get: (h) => (/accept-language/i.test(h) ? 'en-GB,en;q=0.9' : null) }), null);
    if (r.lang !== 'ar') throw new Error('Accept-Language drove the language');
  });

  // ── A2. the real handler writes it to orders + cases (+ a new user) ────
  const DB = R('db.js'), LOGGER = R('logger.js'), EMAIL = R('services/emailService.js');
  const ANALYTICS = R('services/analytics.js'), INTAKE = R('routes/api/cases_intake.js');
  const swapped = [DB, LOGGER, EMAIL, ANALYTICS, INTAKE];
  const saved = {};
  for (const p of swapped) saved[p] = require.cache[p];
  const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };
  const fakeModule = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  let existingUser = null; // null → new-account path
  const rec = { queries: [] };
  const client = {
    query: async (sql, params) => {
      const s = norm(sql);
      rec.queries.push({ sql: s, params: params || [] });
      if (/^SELECT id, lang FROM users WHERE LOWER\(email\)/.test(s)) return { rows: existingUser ? [existingUser] : [] };
      if (/^INSERT INTO users/.test(s)) return { rows: [{ id: params[0] }] };
      if (/^SELECT nextval/.test(s)) return { rows: [{ n: 9 }] };
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  fakeModule(DB, { pool: { connect: async () => client } });
  fakeModule(LOGGER, { logErrorToDb: () => {} });
  fakeModule(EMAIL, { notifyCaseReceived: async () => {} });
  fakeModule(ANALYTICS, { captureSignup: () => {} });

  try {
    delete require.cache[INTAKE];
    const router = require(INTAKE);
    const layer = router.stack.find((l) => l.route && l.route.path === '/intake' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    async function intake({ body, cookies, referer, user }) {
      existingUser = user || null;
      rec.queries = [];
      let status = 200;
      await handler({
        body: Object.assign({ full_name: 'Lead', email: 'lead@example.com', test_type: 'ct_mri' }, body || {}),
        query: {}, cookies: cookies || {},
        get: (h) => (/refer/i.test(h) ? (referer || null) : null),
        originalUrl: '/api/cases/intake', method: 'POST'
      }, { status(c) { status = c; return this; }, json() { return this; } });
      const q = (re) => rec.queries.find((x) => re.test(x.sql));
      return { status, orders: q(/^INSERT INTO orders/), cases: q(/^INSERT INTO cases/), users: q(/^INSERT INTO users/) };
    }
    const langs = (r) => [r.orders && r.orders.params[7], r.cases && r.cases.params[4]];

    await check('A2 no signal at all → orders.language and cases.language are ar (was a hardcoded en)', async () => {
      const r = await intake({});
      if (r.status !== 200) throw new Error('status ' + r.status);
      const [o, c] = langs(r);
      if (o !== 'ar' || c !== 'ar') throw new Error('orders=' + o + ' cases=' + c);
      if (!r.users || r.users.params[7] !== 'ar') throw new Error('new account users.lang is ' + (r.users && r.users.params[7]));
      if (/'en'/.test(r.orders.sql) || /'en'/.test(r.cases.sql)) throw new Error("a literal 'en' is still in the INSERT SQL");
    });
    await check('A2 the form field is honoured (language=en → en)', async () => {
      const [o, c] = langs(await intake({ body: { language: 'en' } }));
      if (o !== 'en' || c !== 'en') throw new Error('orders=' + o + ' cases=' + c);
    });
    await check('A2 an /ar/ Referer → ar even for an account whose users.lang is en', async () => {
      const [o] = langs(await intake({ referer: 'https://tashkheesa.com/ar/', user: { id: 'u1', lang: 'en' } }));
      if (o !== 'ar') throw new Error('orders=' + o);
    });
    await check('A2 existing patient with no request signal → their users.lang', async () => {
      const [o, c] = langs(await intake({ user: { id: 'u1', lang: 'en' } }));
      if (o !== 'en' || c !== 'en') throw new Error('orders=' + o + ' cases=' + c);
    });
  } catch (e) {
    t.fail('A2 intake harness', e);
  } finally {
    restore();
  }

  // ── B. the report guard ────────────────────────────────────────────────
  const { checkReportLanguage, arabicLetterShare } = require('../../src/services/report_submission');
  const EN_REC = 'Please follow up with your cardiologist in six months and repeat the echo.';
  const AR_REC = 'يرجى المتابعة مع طبيب القلب بعد ستة أشهر وإعادة الإيكو.';

  await check('B an English Recommendation on an ar case is refused', () => {
    const r = checkReportLanguage({ orderLanguage: 'ar', findings: 'نتائج', impression: 'انطباع', recommendations: EN_REC });
    if (r.block !== 'recommendation_not_arabic') throw new Error(JSON.stringify(r));
  });
  await check('B an Arabic Recommendation with English underneath passes', () => {
    const r = checkReportLanguage({ orderLanguage: 'ar', findings: 'x', impression: 'y', recommendations: AR_REC + '\nFollow up in 6 months.' });
    if (r.block) throw new Error(JSON.stringify(r));
  });
  await check('B English Findings/Impression on an ar case only warn', () => {
    const r = checkReportLanguage({ orderLanguage: 'ar', findings: 'Normal study.', impression: 'No acute findings.', recommendations: AR_REC });
    if (r.block) throw new Error('blocked on findings/impression');
    if (r.warnings.join() !== 'findings_not_arabic,impression_not_arabic') throw new Error(JSON.stringify(r.warnings));
  });
  await check('B an empty Recommendation is not judged (it may legitimately be empty)', () => {
    if (checkReportLanguage({ orderLanguage: 'ar', findings: 'نتائج', impression: 'انطباع', recommendations: '' }).block) throw new Error('blocked empty');
  });
  await check('B an en case is never checked', () => {
    const r = checkReportLanguage({ orderLanguage: 'en', findings: 'a', impression: 'b', recommendations: EN_REC });
    if (r.block || r.warnings.length) throw new Error(JSON.stringify(r));
  });
  await check('B digits, units and punctuation do not count against Arabic', () => {
    const share = arabicLetterShare('الضغط 120/80 مم زئبق، LDL 3.1');
    if (!(share >= 0.3)) throw new Error('share ' + share);
    if (arabicLetterShare('120/80 — 3.1') !== null) throw new Error('no letters should be unjudged');
  });

  await check('B wiring: checked after the draft is saved and the empty check, before the PDF', () => {
    const src = read('src/services/report_submission.js');
    const iPersist = src.indexOf('await persistReportText({');
    const iEmpty = src.indexOf("return { ok: false, code: 'report_empty' }");
    const iLang = src.indexOf("return { ok: false, code: 'report_recommendation_not_arabic' }");
    const iPdf = src.indexOf('generateMedicalReportPdf');
    if (!(iPersist > 0 && iPersist < iEmpty && iEmpty < iLang && iLang < iPdf)) throw new Error('order wrong: ' + [iPersist, iEmpty, iLang, iPdf]);
  });
  await check('B wiring: doctor.js maps the refusal and the heads-up (bilingual), not to a 500', () => {
    const src = read('src/routes/doctor.js');
    if (!/case 'report_recommendation_not_arabic':[\s\S]{0,200}\?error=report_recommendation_not_arabic/.test(src)) throw new Error('switch case missing');
    for (const code of ['report_recommendation_not_arabic', 'report_language_note']) {
      const m = new RegExp(code + ': \\{\\s*en: \'[^\']+\',\\s*ar: \'[^\']+\'').exec(src);
      if (!m) throw new Error(code + ' missing an EN+AR message');
    }
  });
})();
