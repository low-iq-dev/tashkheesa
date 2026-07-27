'use strict';
// tests/core/legal-pages-bilingual.test.js
//
// Renders the three legal pages (refund, terms, delivery) in BOTH language
// modes and asserts each renders without error and shows the right-language
// copy — plus the prevailing-language clause in both, and that dynamic values
// (specialtyCount, BUSINESS_INFO) interpolate rather than being hardcoded.
//
// Partials (header→layout, footer) are stubbed via ejs.cache so the test
// targets each page's own bilingual body.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📜 legal pages are bilingual (refund / terms / delivery)\n');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');

// Stub the chrome partials so we render only each page's own body.
['partials/header', 'partials/footer'].forEach(function (p) {
  ejs.cache.set(path.join(VIEWS, p + '.ejs'), function () { return ''; });
});

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

const BUSINESS_INFO = {
  email: 'legal-probe@tashkheesa.com',          // distinctive so we can prove it interpolates
  phone: '+20 110 200 9886',
  address: 'Cairo, Egypt',
  address_ar: 'القاهرة، مصر',
  businessHours: 'Sunday – Thursday: 9:00 AM – 5:00 PM (Cairo Time)',
  businessHours_ar: 'الأحد – الخميس: 9:00 صباحاً – 5:00 مساءً (بتوقيت القاهرة)'
};
const SPECIALTY_COUNT = 23; // distinctive number to prove specialtyCount interpolates

let __rc = 0;
function render(view, isAr) {
  const src = fs.readFileSync(path.join(VIEWS, view), 'utf8');
  // Unique filename per render so the main template is not cache-collided
  // (cache:true is needed for the partial stubs to be hit).
  const fname = path.join(VIEWS, '__legaltest_' + (++__rc) + '.ejs');
  return ejs.render(src, {
    isAr: isAr,
    lang: isAr ? 'ar' : 'en',
    title: isAr ? 'AR-TITLE-PLACEHOLDER' : 'EN-TITLE-PLACEHOLDER',
    BUSINESS_INFO: BUSINESS_INFO,
    specialtyCount: SPECIALTY_COUNT,
    cspNonce: 'n'
  }, { filename: fname, cache: true });
}

// enKnown / arKnown are distinctive body phrases present ONLY in that language.
const PAGES = [
  { view: 'refund_policy.ejs',   enKnown: 'Refund & Cancellation Policy', arKnown: 'سياسة الاسترداد والإلغاء' },
  { view: 'terms.ejs',           enKnown: 'Terms of Service',             arKnown: 'شروط الخدمة' },
  { view: 'delivery_policy.ejs', enKnown: 'Delivery & Service Policy',    arKnown: 'سياسة التسليم والخدمة' }
];

// Prevailing-language clause — must appear in BOTH renderings (its OWN language).
const EN_PREVAIL = 'the Arabic text shall prevail';
const AR_PREVAIL = 'يُعتَدّ بالنص العربي';

PAGES.forEach(function (p) {
  // ── English mode ──
  let en = null, enErr = null;
  try { en = render(p.view, false); } catch (e) { enErr = e; }
  assert(!enErr, p.view + ' [en] renders without error', enErr && enErr.message);
  if (en) {
    assert(en.indexOf(p.enKnown) !== -1, p.view + ' [en] shows the English heading', 'missing: ' + p.enKnown);
    assert(en.indexOf(p.arKnown) === -1, p.view + ' [en] does NOT show the Arabic heading', 'Arabic leaked into EN mode');
    assert(en.indexOf(EN_PREVAIL) !== -1, p.view + ' [en] includes the prevailing-language clause (EN)', 'missing EN prevailing clause');
  }

  // ── Arabic mode ──
  let ar = null, arErr = null;
  try { ar = render(p.view, true); } catch (e) { arErr = e; }
  assert(!arErr, p.view + ' [ar] renders without error', arErr && arErr.message);
  if (ar) {
    assert(ar.indexOf(p.arKnown) !== -1, p.view + ' [ar] shows the Arabic heading', 'missing: ' + p.arKnown);
    assert(ar.indexOf(p.enKnown) === -1, p.view + ' [ar] does NOT show the English heading', 'English leaked into AR mode');
    assert(ar.indexOf(AR_PREVAIL) !== -1, p.view + ' [ar] includes the prevailing-language clause (AR)', 'missing AR prevailing clause');
    // BUSINESS_INFO must interpolate in Arabic too (never hardcoded).
    assert(ar.indexOf(BUSINESS_INFO.email) !== -1, p.view + ' [ar] interpolates BUSINESS_INFO.email', 'biz.email not dynamic in AR');
  }
});

// ── Dynamic specialtyCount in terms.ejs (both languages) ──
{
  const termsEn = render('terms.ejs', false);
  const termsAr = render('terms.ejs', true);
  assert(termsEn.indexOf(String(SPECIALTY_COUNT)) !== -1, 'terms [en] interpolates specialtyCount (not hardcoded)', 'specialtyCount missing in EN');
  assert(termsAr.indexOf(String(SPECIALTY_COUNT)) !== -1, 'terms [ar] interpolates specialtyCount (not hardcoded)', 'specialtyCount missing in AR');
}

// ── Dynamic businessHours_ar in delivery.ejs (Arabic uses the AR field) ──
{
  const delAr = render('delivery_policy.ejs', true);
  assert(delAr.indexOf(BUSINESS_INFO.businessHours_ar) !== -1,
    'delivery [ar] interpolates BUSINESS_INFO.businessHours_ar', 'businessHours_ar not used in AR delivery');
}
