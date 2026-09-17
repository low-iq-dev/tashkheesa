// src/routes/static-pages.js
// Public static pages, contact form, pre-launch interest, and .html redirects.

var express = require('express');
var { body, validationResult } = require('express-validator');
var crypto = require('crypto');
var { v4: uuidv4 } = require('uuid');
var router = express.Router();

const { serviceBookableClause } = require('../services/service_bookable');
var comingSoonNotify = require('../notify/coming_soon');
// Durable persistence surface for contact-form submissions (see POST /contact).
var { logErrorToDb } = require('../logger');
var { pathFor, isPublicPath, specialtySlug } = require('../utils/public_lang_url');

// SEO 2026-09-13 (A4) — the ONE definition of "a specialty detail page that
// returns 200". /specialties/:slug filters on it and the sitemap lists exactly
// what it matches, so the sitemap can never advertise a 404 or miss a live page.
var LIVE_SPECIALTY_WHERE =
  "COALESCE(s.is_visible, true) = true " +
  "  AND EXISTS ( " +
  "    SELECT 1 FROM services sv " +
  "    WHERE sv.specialty_id = s.id AND COALESCE(sv.is_visible, true) = true) ";

// Sitemap entries that do not come from data. /doctor/signup is not here: it
// is a doctor-onboarding form, not a page to rank.
var SITEMAP_STATIC_PATHS = [
  '/', '/services', '/specialties', '/about', '/contact', '/faq',
  '/privacy', '/terms', '/refund-policy', '/delivery-policy',
  '/blog', '/apply', '/help-me-choose'
];
var SITEMAP_TTL_MS = 60 * 60 * 1000;

function xmlEscape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The contact notification email interpolates visitor-supplied text into an
// HTML body. Unescaped, a submitter could inject arbitrary markup — including
// a link disguised as Tashkheesa copy — into an internal inbox.
function escapeHtmlText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
      : c === '>' ? '&gt;'
      : c === '"' ? '&quot;'
      : '&#039;';
  });
}

// Part C6 (2026-09-13) — the /refund-policy meta description promised refund
// terms "including video consultations" while video is not offered. It names
// video only while the video flag is on, like the page body.
function refundPolicyDescription(isAr, videoOn) {
  if (isAr) {
    return videoOn
      ? 'متى وكيف يُرَدّ المبلغ في تشخيصة: عبر إنستاباي، ويشمل الاسترداد الجزئي واستشارات الفيديو.'
      : 'متى وكيف يُرَدّ المبلغ في تشخيصة: عبر إنستاباي، ويشمل الاسترداد الجزئي وطلب المتبقي.';
  }
  return videoOn
    ? 'When and how Tashkheesa refunds you: by InstaPay, including partial refunds and video consultations.'
    : 'When and how Tashkheesa refunds you: by InstaPay, including partial refunds and asking for the rest.';
}

function setupStaticPages(opts) {
  var execute = opts.execute;
  var safeAll = opts.safeAll;
  // Injectable so the SEO guards can render every public route without a
  // database; server.js passes nothing and gets the real module.
  var siteStats = opts.siteStats || require('../services/site_stats');

  // EN strings are the canonical fields. *_ar fields are the Egyptian-Arabic
  // counterparts consumed by about.ejs / contact.ejs via canonical tt() with
  // biz.<field>_ar as the AR fallback. See Theme 10 Phase 2C / OQ-1 follow-up.
  var BUSINESS_INFO = {
    email: 'info@tashkheesa.com',
    phone: '+20 110 200 9886',
    address: 'Cairo, Egypt',
    address_ar: 'القاهرة، مصر',
    // LAUNCH-2026-09 — the platform accepts and processes cases 24/7. The only
    // time-boxed promise is the Urgent 4-hour tier, which runs 7am–7pm Cairo
    // (see src/services/urgency.js and patient_new_case.ejs §3). The old
    // 'Sunday – Thursday 9–5' string contradicted every SLA we actually sell.
    businessHours: '24/7 — cases accepted any time. Urgent 4-hour reviews run 7:00 AM – 7:00 PM (Cairo Time).',
    businessHours_ar: 'متاح 24/7 — نستقبل الحالات في أي وقت. المراجعات العاجلة خلال 4 ساعات تعمل من 7:00 صباحاً حتى 7:00 مساءً (بتوقيت القاهرة).',
    instagram: 'https://instagram.com/tashkheesa',
  };

  var SERVICE_DESCRIPTIONS = {
    'X-Ray Review': 'A board-certified radiologist reviews your X-ray images and provides a detailed written report with findings and recommendations.',
    'MRI Review': 'Expert analysis of your MRI scan by a specialist radiologist, with a comprehensive written report covering all findings.',
    'CT Scan Review': 'Detailed review of your CT scan images by a specialist, including a written report with diagnosis and recommendations.',
    'Ultrasound Review': 'Professional review of your ultrasound images by an experienced specialist with a written findings report.',
    'Brain MRI Review': 'Neuroimaging specialist reviews your brain MRI and provides detailed findings, differential diagnosis, and recommendations.',
    'Echocardiogram Review': 'A cardiologist reviews your echocardiogram and provides a detailed assessment of cardiac structure and function.',
    'ECG Review': 'Expert interpretation of your 12-lead ECG by a cardiologist, including rhythm analysis and clinical recommendations.',
    'Blood Work Review': 'Comprehensive analysis of your blood test results by an internal medicine specialist with clinical interpretation.',
    'Chest X-Ray Review': 'Specialist radiologist reviews your chest X-ray and provides a written report covering all thoracic findings.',
    'Mammogram Review': 'Expert breast imaging review by a radiologist, including BI-RADS classification and follow-up recommendations.',
    'Biopsy / Histopathology Review': 'A pathologist reviews your biopsy slides and provides a detailed histopathological assessment.',
    'Oncology Case Review': 'Comprehensive cancer case review by an oncologist, including staging assessment and treatment recommendations.',
    'PET Scan Review': 'Nuclear medicine specialist reviews your PET-CT scan with detailed metabolic activity assessment.',
    'Cardiac Catheterization Review': 'Interventional cardiologist reviews your catheterization findings and provides treatment recommendations.',
    'Holter Monitor Review': 'Cardiologist reviews your Holter monitor recording and provides rhythm analysis over the monitoring period.',
    'General Second Opinion': 'A specialist in the relevant field reviews your medical records and provides an independent second opinion.',
  };

  function getServiceDescription(name) {
    if (SERVICE_DESCRIPTIONS[name]) return SERVICE_DESCRIPTIONS[name];
    return 'Expert specialist review with a detailed written report covering findings and clinical recommendations.';
  }

  // SEO 2026-09-13 (D) — Arabic /services was half English: every card's text
  // came from the English map above. Body copy, so Egyptian Arabic like the rest
  // of the page. A service missing here falls back to its English text, never a
  // blank card.
  var SERVICE_DESCRIPTIONS_AR = {
    'X-Ray Review': 'دكتور أشعة معتمد بيراجع صور الأشعة العادية بتاعتك ويكتبلك تقرير مفصل بالنتائج والتوصيات.',
    'MRI Review': 'استشاري أشعة متخصص بيحلل الرنين المغناطيسي بتاعك ويكتب تقرير شامل بكل النتائج.',
    'CT Scan Review': 'مراجعة مفصلة لصور الأشعة المقطعية من دكتور متخصص، مع تقرير مكتوب فيه التشخيص والتوصيات.',
    'Ultrasound Review': 'دكتور متخصص عنده خبرة بيراجع صور السونار بتاعتك ويكتب تقرير بالنتائج.',
    'Brain MRI Review': 'متخصص في أشعة المخ والأعصاب بيراجع رنين المخ ويكتب النتائج والتشخيصات المحتملة والتوصيات.',
    'Echocardiogram Review': 'استشاري قلب بيراجع الإيكو بتاعك ويكتب تقييم مفصل لتركيب القلب ووظيفته.',
    'ECG Review': 'استشاري قلب بيقرأ رسم القلب بتاعك، ويحلل انتظام النبض ويكتب توصيات.',
    'Blood Work Review': 'استشاري باطنة بيحلل نتايج تحاليل الدم بتاعتك ويشرحها في ضوء حالتك.',
    'Chest X-Ray Review': 'دكتور أشعة متخصص بيراجع أشعة الصدر ويكتب تقرير بكل نتائج الصدر.',
    'Mammogram Review': 'دكتور أشعة متخصص في الثدي بيراجع الماموجرام، مع تصنيف BI-RADS وتوصيات المتابعة.',
    'Biopsy / Histopathology Review': 'دكتور باثولوجي بيراجع شرايح العينة بتاعتك ويكتب تقييم نسيجي مفصل.',
    'Oncology Case Review': 'استشاري أورام بيراجع حالتك بالكامل، مع تقييم مرحلة المرض وتوصيات العلاج.',
    'PET Scan Review': 'متخصص طب نووي بيراجع أشعة PET-CT ويكتب تقييم مفصل للنشاط الأيضي.',
    'Cardiac Catheterization Review': 'استشاري قسطرة قلب بيراجع نتايج القسطرة بتاعتك ويكتب توصيات العلاج.',
    'Holter Monitor Review': 'استشاري قلب بيراجع تسجيل الهولتر ويحلل انتظام النبض طول فترة التسجيل.',
    'General Second Opinion': 'دكتور متخصص في المجال المناسب بيراجع ملفك الطبي ويديك رأي طبي تاني مستقل.'
  };

  function getServiceDescriptionAr(name) {
    if (SERVICE_DESCRIPTIONS_AR[name]) return SERVICE_DESCRIPTIONS_AR[name];
    // A service with a specific English description but no Arabic one shows the
    // English (better than a vaguer Arabic line). One with neither gets the
    // Arabic twin of the English generic line, never English on the Arabic page.
    if (SERVICE_DESCRIPTIONS[name]) return null;
    return 'مراجعة من دكتور متخصص بتقرير مكتوب مفصل فيه النتائج والتوصيات الطبية.';
  }

  // In-memory services cache (5-min TTL)
  var _servicesCache = { services: null, specialtyNames: null, specialtyNameArMap: null, ts: 0 };
  var SERVICES_CACHE_TTL_MS = 5 * 60 * 1000;

  // ── SEO: robots.txt + sitemap.xml (public, served at root) ──────────────
  // Origin is env-driven so staging/preview deploys emit their own host.
  var PUBLIC_ORIGIN = String(process.env.BASE_URL || 'https://tashkheesa.com').replace(/\/+$/, '');

  router.get('/robots.txt', function(req, res) {
    res.type('text/plain').send(
      'User-agent: *\n' +
      'Allow: /\n' +
      // Authenticated / non-marketing areas (all behind login or API-only).
      // /portal/ covers patient + doctor + admin portals; /doctor/ is left
      // crawlable so the public /doctor/signup page is indexed.
      'Disallow: /portal/\n' +
      'Disallow: /superadmin/\n' +
      'Disallow: /admin/\n' +
      'Disallow: /ops/\n' +
      'Disallow: /api/\n' +
      'Disallow: /dashboard\n' +
      'Disallow: /patient/\n' +
      'Disallow: /payments/\n' +
      // /help/ hosts the internal operations manuals. /help/admin-guide is now
      // behind requireRole('admin','superadmin') (src/routes/help.js), but a
      // crawler should not be indexing the patient/doctor guides or probing the
      // admin one either — these are support material, not marketing pages, and
      // an indexed admin-guide URL is a map of the privileged surface.
      // Belt-and-braces alongside the auth gate: robots.txt is a request, the
      // middleware is the enforcement.
      'Disallow: /help/\n' +
      'Disallow: /help/admin-guide\n' +
      // SEO 2026-09-13 (A4): the /lang/:code cookie switch is not a page, and the
      // auth pages reached from Arabic pages carry ?lang=ar — one crawlable
      // /login, not one per query string.
      'Disallow: /lang/\n' +
      'Disallow: /login?\n' +
      'Disallow: /register?\n' +
      'Sitemap: ' + PUBLIC_ORIGIN + '/sitemap.xml\n'
    );
  });

  // SEO 2026-09-13 (A4) — generated from data, with both languages.
  //
  // It was a hand-written list of 15 English URLs: no specialty pages at all,
  // no Arabic URL, and /doctor/signup. Now: the static pages, every blog post
  // in BLOG_POST_VIEWS, every specialty page LIVE_SPECIALTY_WHERE returns 200
  // for, and /help-me-choose — each as an English <url> and an /ar/ <url>, both
  // carrying the same ar-EG / en / x-default alternates the pages declare.
  // <lastmod> is the date this build started serving: the pages are templates,
  // so a deploy is when they change. Cached for an hour.
  var _sitemapCache = { xml: null, ts: 0 };
  var SITEMAP_LASTMOD = new Date().toISOString().slice(0, 10);
  router.get('/sitemap.xml', async function(req, res) {
    var now = Date.now();
    if (!_sitemapCache.xml || (now - _sitemapCache.ts) >= SITEMAP_TTL_MS) {
      var rows = await safeAll(
        "SELECT s.id FROM specialties s WHERE " + LIVE_SPECIALTY_WHERE + "ORDER BY s.id ASC",
        [],
        []
      );
      var seen = {};
      var paths = [];
      SITEMAP_STATIC_PATHS
        .concat(Object.keys(BLOG_POST_VIEWS).map(function(k) { return '/blog/' + k; }))
        .concat((rows || []).map(function(r) { return '/specialties/' + specialtySlug(r.id); }))
        .forEach(function(p) {
          // Only URLs the public router actually serves in both languages.
          if (!seen[p] && isPublicPath(p)) { seen[p] = true; paths.push(p); }
        });
      var entries = [];
      paths.forEach(function(p) {
        var en = PUBLIC_ORIGIN + pathFor('en', p);
        var ar = PUBLIC_ORIGIN + pathFor('ar', p);
        var alternates =
          '    <xhtml:link rel="alternate" hreflang="ar-EG" href="' + xmlEscape(ar) + '"/>\n' +
          '    <xhtml:link rel="alternate" hreflang="en" href="' + xmlEscape(en) + '"/>\n' +
          '    <xhtml:link rel="alternate" hreflang="x-default" href="' + xmlEscape(en) + '"/>\n';
        [en, ar].forEach(function(loc) {
          entries.push(
            '  <url>\n' +
            '    <loc>' + xmlEscape(loc) + '</loc>\n' +
            '    <lastmod>' + SITEMAP_LASTMOD + '</lastmod>\n' +
            alternates +
            '  </url>'
          );
        });
      });
      _sitemapCache = {
        xml: '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
          entries.join('\n') + '\n' +
          '</urlset>\n',
        ts: now
      };
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(_sitemapCache.xml);
  });

  router.get('/services', async function(req, res) {
    var now = Date.now();
    if (!_servicesCache.services || (now - _servicesCache.ts) >= SERVICES_CACHE_TTL_MS) {
      // The page now lists the WHOLE catalogue, not just what is orderable.
      //
      // It used to filter on sp.is_visible and sv.is_visible, which meant 128
      // of 183 services simply did not exist as far as a visitor was
      // concerned — the site looked like a six-specialty operation. They are
      // all listed now, and the ones that cannot be bought carry a Coming Soon
      // pill and do not link anywhere.
      //
      // is_bookable comes from serviceBookableClause, the SAME expression the
      // wizard, the mobile catalogue and the pricing endpoint gate on — used
      // here as a SELECTED COLUMN rather than a WHERE filter. That is the
      // whole trick: one definition, two uses. If it ever drifts, the pill and
      // the wizard drift together instead of the page offering something the
      // wizard refuses.
      var services = await safeAll(
        'SELECT DISTINCT ON (sv.id) sv.*, ' +
        '       sp.name AS specialty_name, sp.name_ar AS specialty_name_ar, ' +
        '       COALESCE(sp.is_visible, true) AS specialty_is_live, ' +
        '       (' + serviceBookableClause('sv') + ') AS is_bookable ' +
        '  FROM services sv ' +
        '  JOIN specialties sp ON sv.specialty_id = sp.id ' +
        ' WHERE sv.base_price IS NOT NULL AND sv.base_price > 0 ' +
        ' ORDER BY sv.id, sp.name, sv.base_price ASC',
        [], []);
      services.forEach(function(s) {
        s.description = getServiceDescription(s.name);
        s.description_ar = getServiceDescriptionAr(s.name);
      });
      var specialtyNames = [];
      var specialtyNameArMap = {};
      var specialtyLiveMap = {};
      var seen = {};
      services.forEach(function(s) {
        if (s.specialty_name && !seen[s.specialty_name]) {
          seen[s.specialty_name] = true;
          specialtyNames.push(s.specialty_name);
          if (s.specialty_name_ar) specialtyNameArMap[s.specialty_name] = s.specialty_name_ar;
        }
        // A specialty is LIVE if any of its services is bookable — not merely
        // if specialties.is_visible is true. A visible specialty whose every
        // service is coming_soon has nothing to sell, and heading it without a
        // pill would promise a consultant we cannot route a case to.
        if (s.specialty_name && s.is_bookable) specialtyLiveMap[s.specialty_name] = true;
      });
      specialtyNames.sort();
      _servicesCache = { services: services, specialtyNames: specialtyNames,
        specialtyNameArMap: specialtyNameArMap, specialtyLiveMap: specialtyLiveMap, ts: now };
    }
    var cat = await siteStats.getCatalogueStats();

    // The Google snippet.
    //
    // It named a HARDCODED specialty list — "radiology, cardiology, oncology,
    // gastroenterology and more" — while Oncology had been hidden since
    // migration 066 and Gastroenterology was never visible, so our own search
    // result advertised two specialties nobody could book. It then said
    // "Browse 55 services", which stopped being what the page shows the moment
    // the page started listing the full catalogue.
    //
    // Both numbers now come from the catalogue itself, and the sentence keeps
    // them apart: TOTAL is what you can browse, BOOKABLE is what you can buy
    // today. Naming the coming-soon specialties is deliberate — they are real
    // and they are on the page — but the snippet never implies they are
    // orderable.
    var _specs = _servicesCache.specialtyNames || [];
    var _live = _servicesCache.specialtyLiveMap || {};
    // Lead with specialties that are actually live, so the snippet's examples
    // are things a visitor can buy today.
    var _named = _specs.filter(function (n) { return _live[n]; })
      .concat(_specs.filter(function (n) { return !_live[n]; }))
      .slice(0, 3);
    var _desc = 'Browse ' + cat.total + ' specialist medical review services across ' +
      cat.totalSpecialties + ' specialties. ' + cat.bookable + ' available now from EGP ' +
      Number(cat.minPrice).toLocaleString('en-US') + ' — ' + _named.join(', ') + ' and more.';
    // Google truncates around 160 characters. Specialty names vary in length,
    // so cap it rather than assume: drop named examples until it fits, which
    // keeps the counts and the price (the part that must not be cut) intact.
    while (_desc.length > 158 && _named.length > 1) {
      _named.pop();
      _desc = 'Browse ' + cat.total + ' specialist medical review services across ' +
        cat.totalSpecialties + ' specialties. ' + cat.bookable + ' available now from EGP ' +
        Number(cat.minPrice).toLocaleString('en-US') + ' — ' + _named.join(', ') + ' and more.';
    }

    // SEO 2026-09-13 (D): the same snippet in Arabic (MSA — search vocabulary),
    // with the specialties' Arabic names and the same length cap.
    var isAr = !!(res.locals && res.locals.isAr);
    if (isAr) {
      var _arMap = _servicesCache.specialtyNameArMap || {};
      var _namedAr = _specs.filter(function (n) { return _live[n]; })
        .concat(_specs.filter(function (n) { return !_live[n]; }))
        .slice(0, 3)
        .map(function (n) { return _arMap[n] || n; });
      // Number-safe: Arabic counted nouns change form with the number (3–10,
      // 11–99, 100+), so a noun straight after a live count is wrong for some
      // values. "N من …" / "منها N" reads correctly for any N.
      var _descAr = function () {
        return 'تصفّح ' + cat.total + ' من خدمات المراجعة الطبية المتخصصة في ' + cat.totalSpecialties + ' من التخصصات، منها ' +
          cat.bookable + ' متاحة الآن بدءًا من ' + Number(cat.minPrice).toLocaleString('en-US') + ' جنيه — ' +
          _namedAr.join('، ') + ' وغيرها.';
      };
      _desc = _descAr();
      while (_desc.length > 158 && _namedAr.length > 1) { _namedAr.pop(); _desc = _descAr(); }
    }

    res.render('services', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      services: _servicesCache.services,
      specialtyNames: _servicesCache.specialtyNames,
      specialtyNameArMap: _servicesCache.specialtyNameArMap,
      specialtyLiveMap: _servicesCache.specialtyLiveMap,
      catalogue: cat,
      title: 'Services & Pricing — Tashkheesa',
      BUSINESS_INFO: BUSINESS_INFO,
      description: _desc,
      canonical: '/services'
    });
  });

  var LAUNCH_DATE = process.env.LAUNCH_DATE || '';
  var comingSoonTitle = LAUNCH_DATE ? 'Coming Soon — ' + LAUNCH_DATE : 'Coming Soon';
  // SEO 2026-09-13 (D): 68 characters without a launch date (under the 70 a
  // snippet needs), and English on the Arabic page.
  var comingSoonDesc = (LAUNCH_DATE ? 'Tashkheesa launches ' + LAUNCH_DATE + '. ' : '') + 'Get expert medical second opinions from board-certified Egyptian specialists. Leave your details to hear when we launch.';
  var comingSoonDescAr = (LAUNCH_DATE ? 'تنطلق تشخيصة في ' + LAUNCH_DATE + '. ' : '') + 'احصل على رأي طبي ثانٍ من استشاريين مصريين معتمدين. سجّل بياناتك ليصلك إشعار فور الإطلاق.';
  router.get('/coming-soon', function(req, res) {
    // UTM params are captured from the URL and re-emitted as hidden form
    // inputs so they round-trip into pre_launch_leads on submit. Truncated
    // defensively (paid-traffic campaigns sometimes append tracking blobs).
    var q = req.query || {};
    function utm(name) {
      var v = q[name];
      if (typeof v !== 'string') return '';
      return v.slice(0, 120);
    }
    res.render('coming_soon', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      title: comingSoonTitle,
      BUSINESS_INFO: BUSINESS_INFO,
      description: (res.locals && res.locals.isAr) ? comingSoonDescAr : comingSoonDesc,
      canonical: '/coming-soon',
      // SEO 2026-09-18 — an orphaned pre-launch page must not outrank the live
      // site. noindex, follow (not none): its links onward still pass.
      robots: 'noindex, follow',
      utm_source: utm('utm_source'),
      utm_medium: utm('utm_medium'),
      utm_campaign: utm('utm_campaign'),
      formState: 'idle',
      formErrors: null,
      formValues: null
    });
  });
  router.get('/help-me-choose', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('help_me_choose', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: isAr ? 'اختر الخدمة المناسبة لحالتك' : 'Find Your Service', BUSINESS_INFO: BUSINESS_INFO, description: isAr ? 'لست متأكدًا من خدمة المراجعة الطبية التي تحتاجها؟ يساعدك مساعدنا الذكي على اختيار الخدمة المناسبة لحالتك في ثوانٍ.' : 'Not sure which medical review service you need? Our AI assistant will guide you in seconds.', canonical: '/help-me-choose' }); });
  router.get('/about', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('about', { title: isAr ? 'عن تشخيصة' : 'About Us', BUSINESS_INFO: BUSINESS_INFO, description: isAr ? 'تربط تشخيصة المرضى باستشاريين معتمدين يعملون في المستشفيات للحصول على رأي طبي ثانٍ. تعرّف على رسالتنا ومعاييرنا في مراجعة الحالات.' : 'Tashkheesa connects patients with board-certified hospital-based specialists for medical second opinions. Learn about our mission and standards.', canonical: '/about' }); });
  // Single render path for /contact, shared by the GET and by the POST's
  // error re-render so the two can never drift in their locals.
  //   contactState — 'idle' | 'sent' | 'error'
  //   contactValues — sticky field values on the error re-render
  function renderContact(req, res, status, state) {
    state = state || {};
    var isAr = !!(res.locals && res.locals.isAr);
    return res.status(status).render('contact', {
      title: isAr ? 'تواصل معنا' : 'Contact Us',
      BUSINESS_INFO: BUSINESS_INFO,
      description: isAr
        ? 'تواصل مع فريق تشخيصة عبر البريد الإلكتروني أو واتساب أو نموذج التواصل، ونرد على رسالتك خلال 24 ساعة في أيام العمل.'
        : 'Get in touch with Tashkheesa. We respond within 24 hours during business days.',
      canonical: '/contact',
      contactState: state.contactState || 'idle',
      contactError: state.contactError || null,
      contactValues: state.contactValues || null
    });
  }

  router.get('/contact', function(req, res) {
    var sent = String((req.query && req.query.sent) || '') === '1';
    return renderContact(req, res, 200, { contactState: sent ? 'sent' : 'idle' });
  });
  router.get('/privacy', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('privacy', { title: isAr ? 'سياسة الخصوصية — تشخيصة' : 'Privacy Policy', BUSINESS_INFO: BUSINESS_INFO, description: isAr ? 'كيف تجمع تشخيصة بياناتك الشخصية والطبية وتخزّنها وتحميها وفقًا لقانون حماية البيانات المصري.' : 'How Tashkheesa collects, stores, and protects your personal and medical data.', canonical: '/privacy' }); });
  router.get('/terms', async function(req, res) { var isAr = !!(res.locals && res.locals.isAr); var specialtyCount = await siteStats.getVisibleSpecialtyCount(); res.render('terms', { title: isAr ? 'شروط الخدمة' : 'Terms of Service', BUSINESS_INFO: BUSINESS_INFO, specialtyCount: specialtyCount, description: isAr ? 'الشروط والأحكام الخاصة باستخدام خدمات تشخيصة للرأي الطبي الثاني، وحقوقك والتزاماتك كمريض عند طلب المراجعة.' : 'Terms and conditions for using Tashkheesa medical second opinion services.', canonical: '/terms' }); });
  router.get('/refund-policy', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('refund_policy', { title: isAr ? 'سياسة الاسترداد والإلغاء' : 'Refund & Cancellation Policy', BUSINESS_INFO: BUSINESS_INFO, description: refundPolicyDescription(isAr, res.locals && res.locals.videoComingSoon === false), canonical: '/refund-policy' }); });
  router.get('/delivery-policy', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('delivery_policy', { title: isAr ? 'سياسة التسليم والخدمة' : 'Delivery & Service Policy', BUSINESS_INFO: BUSINESS_INFO, description: isAr ? 'كيف تُسلِّم تشخيصة تقارير الأطباء الاستشاريين. تسليم رقمي خلال 48 ساعة.' : 'How Tashkheesa delivers specialist medical reports. Digital delivery within 48 hours.', canonical: '/delivery-policy' }); });
  router.get('/faq', function(req, res) { var isAr = !!(res.locals && res.locals.isAr); res.render('faq', { cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '', title: isAr ? 'الأسئلة الشائعة' : 'FAQ – Frequently Asked Questions', BUSINESS_INFO: BUSINESS_INFO, description: isAr ? 'إجابات عن أكثر الأسئلة شيوعًا حول تشخيصة: كيف يعمل الرأي الطبي الثاني، ومدة المراجعة، والأسعار، والخصوصية، ووسائل الدفع.' : 'Answers to the most common questions about Tashkheesa: how second opinions work, turnaround times, pricing, privacy, and payment options.', canonical: '/faq' }); });

  // /blog — index + posts (P1-PUB-1 part 3).
  //
  // Two posts at launch, rendered from inline EJS views. Slug → view map below
  // is the source of truth; index page reads its catalog from blog_index.ejs
  // (kept in sync manually for now). When this hits ~5+ posts, migrate to
  // markdown-in-git with a single shared post template.
  var BLOG_POST_VIEWS = {
    'when-to-get-medical-second-opinion': {
      view: 'blog_when_to_get_second_opinion',
      // SEO 2026-09-13 (D): no brand suffix here — the layout adds it once, in
      // the page's language. Titles/meta in MSA (search vocabulary); the post
      // body keeps its Egyptian Arabic.
      title: 'When Should You Get a Medical Second Opinion?',
      title_ar: 'متى تحتاج إلى رأي طبي ثانٍ؟',
      description: 'Five signs you need a second opinion, why diagnostic uncertainty is more common than people realize, and how to get one without leaving home.',
      description_ar: 'خمس علامات تدل على حاجتك إلى رأي طبي ثانٍ، ولماذا يشيع الغموض في التشخيص أكثر مما يُتوقع، وكيف تحصل على رأي ثانٍ دون مغادرة منزلك.'
    },
    'how-tashkheesa-works': {
      view: 'blog_how_tashkheesa_works',
      title: 'How Tashkheesa Works: Get a Second Opinion in 3 Steps',
      title_ar: 'كيف تعمل تشخيصة: رأي طبي ثانٍ في 3 خطوات',
      description: 'Upload your records, get a specialist review, receive a detailed bilingual report in 48 hours. Here is the full process.',
      description_ar: 'ارفع ملفاتك الطبية، واحصل على مراجعة من استشاري متخصص، واستلم تقريرًا مفصلًا بالعربية والإنجليزية خلال 48 ساعة. إليك الخطوات كاملة.'
    }
  };
  router.get('/blog', function(req, res) {
    var isAr = !!(res.locals && res.locals.isAr);
    res.render('blog_index', {
      title: isAr ? 'مدونة تشخيصة' : 'Blog – Tashkheesa',
      BUSINESS_INFO: BUSINESS_INFO,
      description: isAr
        ? 'أدلة يكتبها متخصصون عن الرأي الطبي الثاني والاستشارات الطبية عن بُعد، وكيف تتخذ قرارات أفضل بشأن علاجك. بالعربية والإنجليزية.'
        : 'Expert guides on medical second opinions, telemedicine, and how to make better decisions about your care. Bilingual EN/AR.',
      canonical: '/blog'
    });
  });
  router.get('/blog/:slug', async function(req, res) {
    var slug = String((req.params && req.params.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    var entry = BLOG_POST_VIEWS[slug];
    if (!entry) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/blog' });
    }
    var isAr = !!(res.locals && res.locals.isAr);
    var specialtyCount = await siteStats.getVisibleSpecialtyCount();
    var serviceCount = await siteStats.getVisibleServiceCount();
    res.render(entry.view, {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      specialtyCount: specialtyCount,
      serviceCount: serviceCount,
      title: isAr && entry.title_ar ? entry.title_ar : entry.title,
      BUSINESS_INFO: BUSINESS_INFO,
      description: isAr && entry.description_ar ? entry.description_ar : entry.description,
      canonical: '/blog/' + slug
    });
  });

  // /specialties — index page (P1-PUB-1 part 2).
  //
  // The EXISTS clause hides specialties with zero visible services.
  // 10 of the 22 visible specialties currently have no services
  // (Anesthesiology, Cardiothoracic, Clinical Nutrition, Emergency
  // Medicine, Nephrology, OB/GYN, Pathology, Psychiatry, Rheumatology,
  // Vascular Surgery). They will reappear automatically once services
  // are added — no code change required. This is intentional, not a bug.
  router.get('/specialties', async function(req, res) {
    var rows = await safeAll(
      // Lists ALL specialties that have a service, live or not.
      //
      // It used to require s.is_visible, so 17 of the 23 were invisible to a
      // visitor and the platform read as a six-specialty operation. They are
      // listed now; the ones with nothing orderable get a Coming Soon pill and
      // do not link anywhere (their detail pages deliberately still 404, so
      // there is no dead link and nothing for a crawler to follow).
      //
      // is_live is "has at least one BOOKABLE service", not "is_visible" — a
      // visible specialty whose every service is coming_soon has nothing to
      // sell, and linking it would send a patient to a page they cannot buy
      // from. service_count is the full listed count so the card's number
      // matches what the detail page would show.
      "SELECT s.id, s.name, s.name_ar, s.description, s.description_ar, " +
      "  (SELECT COUNT(*)::int FROM services sv " +
      "   WHERE sv.specialty_id = s.id) AS service_count, " +
      "  EXISTS (SELECT 1 FROM services sv " +
      "           WHERE sv.specialty_id = s.id AND " + serviceBookableClause('sv') + ") AS is_live " +
      "FROM specialties s " +
      "WHERE EXISTS ( " +
      "    SELECT 1 FROM services sv WHERE sv.specialty_id = s.id) " +
      "ORDER BY (EXISTS (SELECT 1 FROM services sv " +
      "                   WHERE sv.specialty_id = s.id AND " + serviceBookableClause('sv') + ")) DESC, " +
      "         s.name ASC",
      [],
      []
    );
    var isAr = !!(res.locals && res.locals.isAr);
    return res.render('specialties_index', {
      title: isAr ? 'التخصصات الطبية' : 'Medical Specialties',
      BUSINESS_INFO: BUSINESS_INFO,
      description: isAr
        ? 'تصفّح كل التخصصات الطبية في تشخيصة للحصول على رأي طبي ثانٍ من استشاريين مصريين معتمدين، المتاحة الآن والقادمة قريبًا.'
        : 'Browse every medical specialty on Tashkheesa for second-opinion reviews by board-certified Egyptian consultants — open now or coming soon.',
      canonical: '/specialties',
      specialties: rows
    });
  });

  // /specialties/:slug — child page. Slug derives from id: cardiology
  // → spec-cardiology. Returns 404 if the specialty is hidden, missing,
  // or has zero visible services (matches index visibility rules).
  router.get('/specialties/:slug', async function(req, res) {
    var slug = String((req.params && req.params.slug) || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/specialties' });
    }
    var id = 'spec-' + slug;
    var specialtyRows = await safeAll(
      "SELECT s.id, s.name, s.name_ar, s.description, s.description_ar " +
      "FROM specialties s " +
      "WHERE s.id = $1 " +
      "  AND " + LIVE_SPECIALTY_WHERE +
      "LIMIT 1",
      [id],
      []
    );
    var specialty = specialtyRows[0] || null;
    if (!specialty) {
      return res.status(404).render('404', { title: 'Not Found', BUSINESS_INFO: BUSINESS_INFO, canonical: '/specialties' });
    }
    var services = await safeAll(
      "SELECT sv.id, sv.name, sv.name_ar, sv.base_price, sv.currency, sv.sla_hours " +
      "FROM services sv " +
      "WHERE sv.specialty_id = $1 " +
      "  AND COALESCE(sv.is_visible, true) = true " +
      "ORDER BY (sv.base_price IS NULL), sv.base_price ASC, sv.name ASC",
      [id],
      []
    );
    var isAr = !!(res.locals && res.locals.isAr);
    var spName = isAr ? (specialty.name_ar || specialty.name) : specialty.name;
    return res.render('specialty_detail', {
      title: spName,
      BUSINESS_INFO: BUSINESS_INFO,
      description: specialtyMetaDescription(specialty, isAr),
      canonical: '/specialties/' + slug,
      specialty: specialty,
      services: services,
      slug: slug
    });
  });

  // SEO 2026-09-13 (D) — the specialty snippet. It was description.slice(0,160),
  // which cut mid-word, and English on the Arabic page. Now: the description in
  // the page's language, cut at the last word boundary so that, with the
  // suffix, the whole snippet stays within 155 characters; a description too
  // short to carry a snippet (under 70 with the suffix) gets a full sentence.
  var SPECIALTY_META_SUFFIX = ' — second opinion from Egyptian consultants in 48h';
  var SPECIALTY_META_SUFFIX_AR = ' — رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة';
  function cutAtWord(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t.replace(/[\s.,;:،؛—–-]+$/, '');
    var cut = t.slice(0, max + 1);
    var sp = cut.lastIndexOf(' ');
    cut = sp > 0 ? cut.slice(0, sp) : t.slice(0, max);
    return cut.replace(/[\s.,;:،؛—–-]+$/, '');
  }
  function specialtyMetaDescription(specialty, isAr) {
    var suffix = isAr ? SPECIALTY_META_SUFFIX_AR : SPECIALTY_META_SUFFIX;
    var body = isAr ? (specialty.description_ar || '') : (specialty.description || '');
    var out = body ? cutAtWord(body, 155 - suffix.length) + suffix : '';
    if (out.length >= 70) return out;
    return isAr
      ? 'رأي طبي ثانٍ في ' + (specialty.name_ar || specialty.name) + ' من استشاريين مصريين معتمدين، مع تقرير مكتوب خلال 48 ساعة.'
      : specialty.name + ' second opinion from board-certified Egyptian consultants, with a written report within 48 hours.';
  }

  router.get('/how-it-works', function(req, res) { res.redirect(302, '/#how-it-works'); });
  router.get('/doctors', function(req, res) { res.redirect(302, '/about'); });

  // POST /contact
  //
  // Three defects fixed here:
  //
  //  1. The handler answered `res.json({ok:true})` to a plain, non-fetch HTML
  //     <form> POST (contact.ejs has no submit handler). The browser therefore
  //     NAVIGATED to /contact and painted the literal text {"ok":true} — the
  //     visitor was thrown out of the site onto a white page of JSON.
  //  2. A sendMail() rejection was console-logged and then fell through to the
  //     SAME `{ok:true}`. With SMTP down every enquiry was answered "sent" and
  //     dropped on the floor.
  //  3. Nothing was persisted at all, so there was no record to recover from.
  //
  // Persistence: this codebase has no contact_messages table and adding a
  // migration is out of scope for this change, so the durable record goes to
  // error_logs via logErrorToDb — which is queryable from /ops/errors, tolerates
  // a missing table, and never throws. It is written BEFORE the mail attempt and
  // independently of its outcome, which is the property that matters: the
  // enquiry survives even if the SMTP call hangs or the process dies mid-send.
  // A dedicated table is the correct long-term home (see the report).
  function contactWantsJson(req) {
    // Deliberately narrow: only callers that can accept JSON and explicitly
    // CANNOT accept HTML get the JSON shape. A browser form post sends
    // `Accept: text/html,...`, so it always takes the redirect/render path.
    return !!(req.accepts('json') && !req.accepts('html'));
  }

  router.post('/contact', async function(req, res) {
    var body = req.body || {};
    var name = String(body.name || '').trim();
    var email = String(body.email || '').trim();
    var subject = String(body.subject || '').trim();
    var message = String(body.message || '').trim();
    var asJson = contactWantsJson(req);
    var values = { name: name, email: email, subject: subject, message: message };

    if (!name || !email || !message) {
      if (asJson) return res.status(400).json({ ok: false, error: 'Missing required fields' });
      return renderContact(req, res, 400, {
        contactState: 'error',
        contactError: 'missing_fields',
        contactValues: values
      });
    }

    console.log('[CONTACT] New message from %s <%s> — subject: %s', name, email, subject || 'none');

    // Durable record FIRST, independent of the mail attempt.
    var recordId = null;
    try {
      recordId = await logErrorToDb(new Error('contact form submission'), {
        level: 'info',
        category: 'contact_form',
        requestId: req.requestId,
        url: req.originalUrl,
        method: req.method,
        contactName: name,
        contactEmail: email,
        contactSubject: subject || 'none',
        contactMessage: message.slice(0, 4000)
      });
    } catch (e) {
      // logErrorToDb already swallows its own DB errors; this only catches a
      // require/programming fault. Never block the enquiry on the audit write.
      console.error('[CONTACT] Failed to persist submission:', e && e.message);
    }

    var mailed = false;
    try {
      var { sendMail } = require('../services/emailService');
      await sendMail({
        to: process.env.SMTP_FROM_EMAIL || 'info@tashkheesa.com',
        replyTo: email,
        subject: 'New contact form submission from ' + name + (subject ? ' — ' + subject : ''),
        text: 'Name: ' + name + '\nEmail: ' + email + '\nSubject: ' + (subject || 'none') + '\nMessage: ' + message,
        html: '<p><b>Name:</b> ' + escapeHtmlText(name) + '</p><p><b>Email:</b> ' + escapeHtmlText(email) + '</p>' +
              (subject ? '<p><b>Subject:</b> ' + escapeHtmlText(subject) + '</p>' : '') +
              '<p><b>Message:</b> ' + escapeHtmlText(message) + '</p>'
      });
      mailed = true;
    } catch (err) {
      console.error('[CONTACT] Email send failed:', err && err.message);
      // Second record, at error level, so an SMTP outage is visible in the
      // ops error feed rather than only in stdout.
      try {
        await logErrorToDb(err, {
          level: 'error',
          category: 'contact_form',
          requestId: req.requestId,
          url: req.originalUrl,
          method: req.method,
          note: 'contact form email delivery failed; submission persisted',
          submissionRecordId: recordId,
          contactEmail: email
        });
      } catch (e) {}
    }

    if (!mailed) {
      // Non-200 and an honest banner. The enquiry IS stored, so the copy tells
      // the visitor to use email/WhatsApp rather than claiming total loss.
      if (asJson) {
        return res.status(502).json({ ok: false, error: 'delivery_failed', persisted: !!recordId });
      }
      return renderContact(req, res, 502, {
        contactState: 'error',
        contactError: 'delivery_failed',
        contactValues: values
      });
    }

    if (asJson) return res.json({ ok: true });
    // POST → 303 → GET so a refresh on the success page does not resubmit.
    // SEO 2026-09-13 (A1): back to the contact page in the language it was sent from.
    return res.redirect(303, ((res.locals && res.locals.langPrefix) || '') + '/contact?sent=1');
  });

  // ─── Pre-launch lead capture ────────────────────────────────────────
  // Single source of truth for the /coming-soon form. Handles JSON
  // (fetch-driven) AND form-encoded (no-JS fallback) callers; the
  // response shape and the re-render path are chosen from the Accept
  // header.
  //
  // Storage: existing `pre_launch_leads` table, extended by migration
  // 068. UPSERT-on-LOWER(email) via SELECT-then-UPDATE/INSERT inside a
  // transaction (the unique index in migration 068 only lands when the
  // legacy table has no duplicates; the app-level path is the
  // authoritative dedupe surface either way).
  //
  // Dispatch: fire-and-forget AFTER the response is sent. pg-boss is
  // wired in this codebase (src/job_queue.js) but adding a new queue
  // would mean editing a high-risk file; the brief explicitly permits
  // inline fire-and-forget when traffic is low (an Instagram landing
  // page is). Marked as a follow-up.
  var pgHelpers = require('../pg');

  var leadValidators = [
    body('name').trim().notEmpty().withMessage('name_required').isLength({ max: 120 }),
    body('email').trim().isEmail().withMessage('email_invalid').isLength({ max: 254 }),
    body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 32 }),
    body('language').optional({ checkFalsy: true }).isIn(['en', 'ar', 'both']),
    body('service_interest').optional({ checkFalsy: true }).isLength({ max: 32 }),
    body('case_description').optional({ checkFalsy: true }).trim().isLength({ max: 2000 })
  ];

  function isTruthy(v) {
    if (v === true) return true;
    if (typeof v !== 'string') return false;
    var s = v.toLowerCase().trim();
    return s === 'on' || s === 'true' || s === '1' || s === 'yes';
  }

  function wantsJson(req) {
    var accept = String(req.get('accept') || '').toLowerCase();
    if (accept.includes('application/json')) return true;
    if (String(req.get('content-type') || '').toLowerCase().includes('application/json')) return true;
    if (String(req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest') return true;
    return false;
  }

  function renderComingSoon(req, res, state) {
    var q = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
    function utmFromBody(name) {
      var v = q[name];
      if (typeof v !== 'string') return '';
      return v.slice(0, 120);
    }
    res.render('coming_soon', {
      cspNonce: req.cspNonce || (res.locals && res.locals.cspNonce) || '',
      title: comingSoonTitle,
      BUSINESS_INFO: BUSINESS_INFO,
      description: (res.locals && res.locals.isAr) ? comingSoonDescAr : comingSoonDesc,
      canonical: '/coming-soon',
      robots: 'noindex, follow',
      utm_source: utmFromBody('utm_source'),
      utm_medium: utmFromBody('utm_medium'),
      utm_campaign: utmFromBody('utm_campaign'),
      formState: state.formState || 'idle',
      formErrors: state.formErrors || null,
      formValues: state.formValues || null
    });
  }

  function dispatchConfirmations(leadRow) {
    // Fire-and-forget. The response has already been flushed; this
    // updates pre_launch_leads asynchronously and never re-enters the
    // response cycle. Failures are logged + persisted as 'failed' on the
    // row so the admin view + future retries can see what happened.
    setImmediate(async function() {
      try {
        var emailResult = await comingSoonNotify.sendConfirmationEmail(leadRow);
        var smsResult = await comingSoonNotify.sendConfirmationSms(leadRow);
        try {
          await execute(
            'UPDATE pre_launch_leads SET confirm_email_status = $1, confirm_sms_status = $2, updated_at = NOW() WHERE id = $3',
            [emailResult.status, smsResult.status, leadRow.id]
          );
        } catch (e) {
          console.error('[PRE-LAUNCH] failed to update confirm statuses for ' + leadRow.id + ':', e.message);
        }
        if (emailResult.status === 'failed') {
          console.warn('[PRE-LAUNCH] email failed for ' + leadRow.id + ': ' + (emailResult.reason || ''));
        }
        if (smsResult.status === 'failed') {
          console.warn('[PRE-LAUNCH] sms failed for ' + leadRow.id + ': ' + (smsResult.reason || ''));
        }
      } catch (err) {
        console.error('[PRE-LAUNCH] dispatch threw for ' + leadRow.id + ':', err && err.message);
      }
    });
  }

  router.post('/api/pre-launch-interest', leadValidators, async function(req, res) {
    var body = req.body || {};
    var asJson = wantsJson(req);

    // ── Honeypot: silent 200. A real user never fills `website`. We do
    // NOT tell the bot it failed — that turns into a signal. We also
    // never dispatch (no leak of email transport behavior).
    if (body.website && String(body.website).trim() !== '') {
      if (asJson) return res.json({ success: true, message: 'ok' });
      return renderComingSoon(req, res, { formState: 'success' });
    }

    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      var mapped = errors.mapped();
      if (asJson) {
        return res.status(400).json({ success: false, error: 'invalid_input', fields: mapped });
      }
      return renderComingSoon(req, res, {
        formState: 'error',
        formErrors: mapped,
        formValues: body
      });
    }

    var name = String(body.name || '').trim();
    var email = String(body.email || '').trim();
    var phoneRaw = String(body.phone || '').trim();
    var phoneE164 = comingSoonNotify.normalizePhoneE164(phoneRaw);
    var language = String(body.language || '').trim().toLowerCase();
    if (['en', 'ar', 'both'].indexOf(language) === -1) language = 'ar';
    var serviceInterest = String(body.service_interest || 'all').trim().slice(0, 32);
    var caseDescription = String(body.case_description || '').trim();
    if (!caseDescription) caseDescription = null;
    var consent = isTruthy(body.consent);
    var utmSource = String(body.utm_source || '').trim().slice(0, 120) || null;
    var utmMedium = String(body.utm_medium || '').trim().slice(0, 120) || null;
    var utmCampaign = String(body.utm_campaign || '').trim().slice(0, 120) || null;
    var ipAddress = (req.ip || (req.connection && req.connection.remoteAddress) || '').toString();
    var userAgent = String(req.get('user-agent') || '').slice(0, 500);

    var leadRow;
    try {
      leadRow = await pgHelpers.withTransaction(async function(client) {
        var existing = await client.query(
          'SELECT id, name, email, phone, language, consent FROM pre_launch_leads WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [email]
        );
        if (existing.rows.length > 0) {
          var prev = existing.rows[0];
          // UPDATE — preserve consent=true if previously granted, only
          // bump it to true on this submission (never downgrade
          // true→false here; an unsubscribe is the only path to false).
          var nextConsent = prev.consent === true ? true : consent;
          var upd = await client.query(
            "UPDATE pre_launch_leads SET " +
              "name = $1, phone = COALESCE($2, phone), phone_e164 = COALESCE($3, phone_e164), " +
              "language = $4, service_interest = COALESCE($5, service_interest), " +
              "case_description = COALESCE($6, case_description), " +
              "utm_source = COALESCE($7, utm_source), utm_medium = COALESCE($8, utm_medium), utm_campaign = COALESCE($9, utm_campaign), " +
              "consent = $10, ip_address = COALESCE($11, ip_address), user_agent = COALESCE($12, user_agent), " +
              "confirm_email_status = 'pending', confirm_sms_status = CASE WHEN $3 IS NOT NULL AND $10 THEN 'pending' ELSE 'na' END, " +
              "updated_at = NOW() " +
              "WHERE id = $13 RETURNING *",
            [name, phoneRaw || null, phoneE164, language, serviceInterest, caseDescription,
             utmSource, utmMedium, utmCampaign, nextConsent, ipAddress, userAgent, prev.id]
          );
          return upd.rows[0];
        }
        // INSERT
        var id = uuidv4();
        var smsStart = (phoneE164 && consent) ? 'pending' : 'na';
        var ins = await client.query(
          "INSERT INTO pre_launch_leads (" +
            "id, name, email, phone, phone_e164, language, service_interest, case_description, " +
            "source, utm_source, utm_medium, utm_campaign, " +
            "ip_address, user_agent, consent, " +
            "confirm_email_status, confirm_sms_status, updated_at" +
          ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'coming_soon',$9,$10,$11,$12,$13,$14,'pending',$15,NOW()) RETURNING *",
          [id, name, email, phoneRaw || null, phoneE164, language, serviceInterest, caseDescription,
           utmSource, utmMedium, utmCampaign, ipAddress, userAgent, consent, smsStart]
        );
        return ins.rows[0];
      });
    } catch (err) {
      console.error('[PRE-LAUNCH] upsert failed:', err && err.message);
      if (asJson) {
        return res.status(500).json({ success: false, error: 'save_failed' });
      }
      return renderComingSoon(req, res, {
        formState: 'error',
        formErrors: { _global: { msg: 'save_failed' } },
        formValues: body
      });
    }

    console.log('[PRE-LAUNCH] lead upserted id=%s email=%s lang=%s consent=%s utm=%s',
      leadRow.id, email, language, String(consent), utmSource || '-');

    // Fire-and-forget dispatch. Response goes out first.
    if (asJson) {
      res.json({ success: true, message: 'Thank you for your interest! We will notify you when we launch.' });
    } else {
      renderComingSoon(req, res, { formState: 'success' });
    }
    dispatchConfirmations(leadRow);
  });

  // ─── /unsubscribe ─────────────────────────────────────────────────────
  // Flips pre_launch_leads.consent=false for the matching email if the
  // HMAC token is valid. The token is HMAC-SHA256(lower(email), JWT_SECRET)
  // truncated to 32 hex chars — matches the link the email footer renders
  // via comingSoonNotify.unsubscribeUrl. We do NOT 404 on bad tokens or
  // missing emails — that would enumerate which addresses are in the list.
  // Always returns the same shaped page; the only thing that varies is the
  // success/already-unsubscribed copy.
  router.get('/unsubscribe', async function(req, res) {
    var email = String((req.query && req.query.email) || '').toLowerCase().trim();
    var token = String((req.query && req.query.token) || '').trim();
    var ok = false;

    if (email && token) {
      var secret = process.env.JWT_SECRET || '';
      var expected = crypto.createHmac('sha256', secret).update(email).digest('hex').slice(0, 32);
      var validToken = false;
      try {
        if (token.length === expected.length) {
          validToken = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
        }
      } catch (_) { validToken = false; }

      if (validToken) {
        try {
          var r = await execute(
            'UPDATE pre_launch_leads SET consent = false, updated_at = NOW() WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          ok = r && (r.rowCount || 0) > 0;
        } catch (e) {
          console.error('[UNSUBSCRIBE] update failed:', e && e.message);
        }
      }
    }

    res.type('html').send(
      '<!doctype html><html lang="en"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Unsubscribed — Tashkheesa</title>' +
      '<link rel="stylesheet" href="/styles.css">' +
      '</head><body style="background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;">' +
      '<div style="max-width:560px;margin:80px auto;padding:32px 24px;background:white;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">' +
      '<h1 style="margin:0 0 12px;font-size:22px;color:#0066CC;">Tashkheesa</h1>' +
      '<h2 style="margin:0 0 16px;font-size:18px;">' +
      (ok ? 'You have been unsubscribed.' : 'Unsubscribe link is invalid or already used.') +
      '</h2>' +
      '<p style="margin:0;font-size:14px;color:#6B7280;line-height:1.6;">' +
      (ok
        ? "We won't email you about the launch again. If this was a mistake, you can re-submit the form on our site."
        : "If you believe this is a mistake, please email <a href=\"mailto:info@tashkheesa.com\" style=\"color:#0066CC;\">info@tashkheesa.com</a> and we'll handle it manually.") +
      '</p>' +
      '<p style="margin:24px 0 0;font-size:13px;"><a href="/" style="color:#0066CC;">Back to site</a></p>' +
      '</div></body></html>'
    );
  });

  // Legacy .html redirects. SEO 2026-09-13 (A1): an /ar/<old>.html address
  // redirects to the Arabic page, not the English one.
  function langPrefixOf(res) { return (res.locals && res.locals.langPrefix) || ''; }
  router.get('/services.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/services'); });
  router.get('/privacy.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/privacy'); });
  router.get('/terms.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/terms'); });
  router.get('/about.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/about'); });
  router.get('/contact.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/contact'); });
  router.get('/doctors.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/about'); });
  router.get('/site/services.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/services'); });
  router.get('/site/about.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/about'); });
  router.get('/site/contact.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/contact'); });
  router.get('/site/doctors.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/about'); });
  router.get('/site/privacy.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/privacy'); });
  router.get('/site/terms.html', function(req, res) { res.redirect(301, langPrefixOf(res) + '/terms'); });

  return router;
}

module.exports = {
  setupStaticPages: setupStaticPages,
  refundPolicyDescription: refundPolicyDescription,
  LIVE_SPECIALTY_WHERE: LIVE_SPECIALTY_WHERE,
  SITEMAP_STATIC_PATHS: SITEMAP_STATIC_PATHS
};
