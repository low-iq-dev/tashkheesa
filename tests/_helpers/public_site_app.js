// tests/_helpers/public_site_app.js
//
// SEO 2026-09-13 — an in-process copy of the public site's request pipeline,
// for the SEO guards. It mounts the REAL publicLangPrefix, the REAL
// baseMiddlewares, the global locals server.js sets for every render, the
// homepage handler's locals, and the REAL setupStaticPages / apply /
// app-landing routers, with the database stubbed out. No server.js boot, no
// Postgres needed: `safeAll` and `siteStats` are fakes the caller can shape.

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const src = (p) => path.join(ROOT, 'src', p);

// Load the REAL module file, whatever another test left in require.cache.
// Several tests/auth/* files replace src/middleware (and src/pg) with stubs via
// require.cache and never restore them. The previous entry is put back so this
// helper does not change what later tests see.
function loadReal(p) {
  const id = require.resolve(p);
  const saved = require.cache[id];
  delete require.cache[id];
  try { return require(id); } finally {
    if (saved) require.cache[id] = saved; else delete require.cache[id];
  }
}

// Rows the public routes read. Shapes follow the SELECTs in static-pages.js.
const FIXTURE_SPECIALTIES = [
  { id: 'cardiology', name: 'Cardiology', name_ar: 'أمراض القلب',
    description: 'Cardiology covers the heart and blood vessels: chest pain, rhythm problems, heart failure, valve disease and the scans and tests that diagnose them.',
    description_ar: 'يختص طب القلب بأمراض القلب والأوعية الدموية: ألم الصدر واضطرابات النظم وفشل القلب وأمراض الصمامات والفحوص التي تشخّصها.',
    service_count: 2, is_live: true },
  { id: 'spec-radiology', name: 'Radiology', name_ar: 'الأشعة',
    description: 'Short.', description_ar: 'قصير.', service_count: 1, is_live: true },
  { id: 'dermatology', name: 'Dermatology', name_ar: 'الأمراض الجلدية',
    description: null, description_ar: null, service_count: 1, is_live: false }
];

const FIXTURE_SERVICES = [
  { id: 'card_echo', name: 'Echocardiogram Review', name_ar: 'مراجعة إيكو القلب', base_price: 2400, currency: 'EGP',
    sla_hours: 48, specialty_id: 'cardiology', specialty_name: 'Cardiology', specialty_name_ar: 'أمراض القلب',
    specialty_is_live: true, is_bookable: true, is_visible: true },
  { id: 'rad_mri', name: 'MRI Review', name_ar: 'مراجعة رنين مغناطيسي', base_price: 1600, currency: 'EGP',
    sla_hours: 24, specialty_id: 'spec-radiology', specialty_name: 'Radiology', specialty_name_ar: 'الأشعة',
    specialty_is_live: true, is_bookable: true, is_visible: true },
  { id: 'derm_x', name: 'Skin Lesion Photo Review', name_ar: null, base_price: 1800, currency: 'EGP',
    sla_hours: 48, specialty_id: 'dermatology', specialty_name: 'Dermatology', specialty_name_ar: 'الأمراض الجلدية',
    specialty_is_live: false, is_bookable: false, is_visible: true }
];

function fakeSafeAll(sql, params) {
  const q = String(sql);
  if (/FROM services sv\s+JOIN specialties sp/i.test(q)) return Promise.resolve(FIXTURE_SERVICES.slice());
  if (/FROM specialties s\s+WHERE s\.id = \$1/i.test(q)) {
    const id = params && params[0];
    return Promise.resolve(FIXTURE_SPECIALTIES.filter((s) => s.id === id || 'spec-' + s.id === id).slice(0, 1));
  }
  if (/FROM services sv\s+WHERE sv\.specialty_id = \$1/i.test(q)) {
    const id = params && params[0];
    return Promise.resolve(FIXTURE_SERVICES.filter((s) => s.specialty_id === id || 'spec-' + s.specialty_id === id));
  }
  if (/FROM specialties s/i.test(q)) return Promise.resolve(FIXTURE_SPECIALTIES.slice());
  return Promise.resolve([]);
}

const fakeSiteStats = {
  getVisibleSpecialtyCount: async () => 7,
  getVisibleServiceCount: async () => 70,
  getCatalogueStats: async () => ({ total: 183, totalSpecialties: 23, bookable: 70, minPrice: 1600, maxPrice: 5500 })
};

function buildPublicSiteApp(opts) {
  opts = opts || {};
  const app = express();
  app.set('views', src('views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));

  app.use(loadReal(src('utils/public_lang_url')).publicLangPrefix());
  loadReal(src('middleware')).baseMiddlewares(app);

  // What server.js guarantees on every render (fallback lang/dir/isAr,
  // currentUrl, feature flags, user, booking CTA, csrfField).
  app.use((req, res, next) => {
    if (!res.locals.lang) res.locals.lang = 'en';
    if (!res.locals.dir) res.locals.dir = res.locals.lang === 'ar' ? 'rtl' : 'ltr';
    if (typeof res.locals.isAr !== 'boolean') res.locals.isAr = res.locals.lang === 'ar';
    res.locals.currentUrl = req.originalUrl || req.url || '/';
    res.locals.prescriptionsComingSoon = true;
    res.locals.videoComingSoon = true;
    res.locals.user = null;
    res.locals.bookingCtaEnabled = false;
    if (typeof res.locals.csrfField !== 'function') res.locals.csrfField = () => '';
    next();
  });

  // server.js renderHomepage, minus the database.
  app.get('/', async (req, res) => res.render('index', {
    businessEmail: 'info@tashkheesa.com', businessPhone: '+20 110 200 9886', businessAddress: 'Cairo, Egypt',
    currency: 'EGP', specialtyCount: 7, priceRangeMin: '1,600', priceRangeMax: '5,500'
  }));

  const staticOpts = {
    execute: async () => ({ rowCount: 0, rows: [] }),
    safeAll: opts.safeAll || fakeSafeAll,
    siteStats: opts.siteStats || fakeSiteStats
  };
  app.use('/', loadReal(src('routes/static-pages')).setupStaticPages(staticOpts));
  app.use('/', loadReal(src('routes/app_landing')));
  app.use('/', loadReal(src('routes/apply'))({ pool: { query: async () => ({ rows: [] }) }, sendMail: async () => {} }));
  app.use((req, res) => res.status(404).type('text/plain').send('not found: ' + req.originalUrl));
  // Surface render errors to the test instead of Express's HTML page.
  app.use((err, req, res, next) => { void next; res.status(500).type('text/plain').send('RENDER ERROR: ' + (err && err.stack || err)); });
  return app;
}

async function startPublicSiteApp(opts) {
  const server = http.createServer(buildPublicSiteApp(opts));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function get(p, headers) {
    const r = await fetch(base + p, { redirect: 'manual', headers: headers || {} });
    return { status: r.status, body: await r.text(), headers: r.headers, location: r.headers.get('location') };
  }
  return { base, get, close: () => new Promise((res) => server.close(res)) };
}

// Small HTML readers shared by the SEO guards.
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function readHead(body) {
  const title = (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
  const description = (body.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  const canonical = (body.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  const ogUrl = (body.match(/<meta property="og:url" content="([^"]*)"/) || [])[1];
  const html = (body.match(/<html\b[^>]*>/) || [])[0] || '';
  const alternates = {};
  const re = /<link rel="alternate" hreflang="([^"]+)" href="([^"]*)"/g;
  let m;
  while ((m = re.exec(body))) alternates[m[1]] = m[2];
  return {
    title: title === undefined ? undefined : decodeEntities(title.trim()),
    description: description === undefined ? undefined : decodeEntities(description),
    canonical, ogUrl, alternates,
    htmlLang: (html.match(/\blang="([^"]*)"/) || [])[1],
    htmlDir: (html.match(/\bdir="([^"]*)"/) || [])[1]
  };
}

module.exports = {
  loadReal, buildPublicSiteApp, startPublicSiteApp, readHead, decodeEntities,
  fakeSafeAll, fakeSiteStats, FIXTURE_SPECIALTIES, FIXTURE_SERVICES
};
