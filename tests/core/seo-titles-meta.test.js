// tests/core/seo-titles-meta.test.js
//
// SEO 2026-09-13 (Part D) — titles and meta descriptions in the page's language.
//
// Before: most Arabic pages had English meta descriptions (services,
// specialties, about, contact, faq, blog, apply, help-me-choose, app), every
// Arabic title ended in "– Tashkheesa", titles that already carried the brand
// got it twice ("… – تشخيصة – Tashkheesa"), specialty snippets were
// description.slice(0,160) cut mid-word, and Arabic /services cards were
// English.
//
// Renders every public route in both languages through the real pipeline with
// a stubbed database (tests/_helpers/public_site_app.js) and asserts, per page:
//   - Arabic page: <title> and description contain Arabic and no "Tashkheesa";
//     English page: no Arabic in either
//   - the brand appears at most once in the title
//   - description length 70–160
//   - canonical + ar-EG/en/x-default alternates present and pointing at this
//     page in both languages (noindex pages excepted)
// plus the specified homepage title/H1, the specialty snippet rule, and the
// Arabic service card copy.

'use strict';

const assert = require('assert');
const path = require('path');
const helper = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🏷️  SEO D — titles and meta in the page\'s language\n');

const SITE = 'https://tashkheesa.com';
const ARABIC = /[؀-ۿ]/;
const BRAND = /Tashkheesa|تشخيصة/g;

const ROUTES = ['/', '/services', '/specialties', '/specialties/cardiology', '/specialties/radiology', '/about',
  '/contact', '/faq', '/blog', '/blog/how-tashkheesa-works', '/blog/when-to-get-medical-second-opinion',
  '/privacy', '/terms', '/refund-policy', '/delivery-policy', '/apply', '/help-me-choose', '/app', '/coming-soon'];

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  let app;
  try { app = await helper.startPublicSiteApp(); } catch (e) { t.fail('seo-titles-meta: start app', e); return; }
  const bodies = {};
  try {
    for (const enPath of ROUTES) {
      for (const lang of ['en', 'ar']) {
        const p = lang === 'ar' ? (enPath === '/' ? '/ar/' : '/ar' + enPath) : enPath;
        await check(p + ' title/description/canonical', async () => {
          const r = await app.get(p);
          assert.strictEqual(r.status, 200, 'status ' + r.status + ': ' + r.body.slice(0, 400));
          bodies[p] = r.body;
          const h = helper.readHead(r.body);
          const noindex = /<meta name="robots" content="[^"]*noindex/.test(r.body);

          assert.ok(h.title, 'no <title>');
          assert.ok(h.description, 'no meta description');
          if (lang === 'ar') {
            assert.ok(ARABIC.test(h.title), 'Arabic page title has no Arabic: ' + h.title);
            assert.ok(!/Tashkheesa/.test(h.title), 'Arabic page title carries the English brand: ' + h.title);
            assert.ok(ARABIC.test(h.description), 'Arabic page description is not Arabic: ' + h.description);
          } else {
            assert.ok(!ARABIC.test(h.title), 'English page title contains Arabic: ' + h.title);
            assert.ok(!ARABIC.test(h.description), 'English page description contains Arabic: ' + h.description);
          }
          const brands = (h.title.match(BRAND) || []).length;
          assert.ok(brands <= 1, 'brand appears ' + brands + ' times in: ' + h.title);
          assert.ok(h.description.length >= 70 && h.description.length <= 160,
            'description length ' + h.description.length + ' (want 70–160): ' + h.description);

          if (!noindex) {
            const en = SITE + enPath;
            const ar = SITE + (enPath === '/' ? '/ar/' : '/ar' + enPath);
            assert.strictEqual(h.canonical, lang === 'ar' ? ar : en, 'canonical');
            assert.deepStrictEqual(h.alternates, { 'ar-EG': ar, en: en, 'x-default': en }, 'alternates');
            assert.strictEqual(h.ogUrl, h.canonical, 'og:url');
          }
        });
      }
    }

    await check('homepage: the specified title and H1 in both languages', async () => {
      const en = bodies['/'] || '';
      const ar = bodies['/ar/'] || '';
      assert.strictEqual(helper.readHead(en).title, 'Medical Second Opinion from Egyptian Consultants in 48h | Tashkheesa');
      assert.strictEqual(helper.readHead(ar).title, 'رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة | تشخيصة');
      const h1 = (b) => helper.decodeEntities(((b.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').trim());
      assert.strictEqual(h1(en), 'A written second opinion from a named Egyptian consultant — within 48 hours');
      assert.strictEqual(h1(ar), 'رأي طبي ثانٍ مكتوب من استشاري باسمه — خلال ٤٨ ساعة');
    });

    await check('specialty snippet: cut at a word boundary + suffix; too short → full sentence', async () => {
      const card = helper.FIXTURE_SPECIALTIES.find((s) => s.id === 'cardiology');
      const enSuffix = ' — second opinion from Egyptian consultants in 48h';
      const arSuffix = ' — رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة';
      for (const [p, source, suffix] of [['/specialties/cardiology', card.description, enSuffix],
        ['/ar/specialties/cardiology', card.description_ar, arSuffix]]) {
        const d = helper.readHead(bodies[p]).description;
        assert.ok(d.endsWith(suffix), p + ' must end with the suffix: ' + d);
        const bodyPart = d.slice(0, d.length - suffix.length);
        assert.ok(bodyPart.length > 20 && source.startsWith(bodyPart), p + ' body must be a leading cut of the description: ' + bodyPart);
        const next = source.charAt(bodyPart.length);
        assert.ok(next === '' || /[\s.,;:،؛]/.test(next), p + ' cut mid-word before "' + source.slice(bodyPart.length, bodyPart.length + 10) + '"');
        assert.ok(d.length <= 155, p + ' snippet ' + d.length + ' > 155');
      }
      // 'Short.' + suffix is under 70 → the full sentence instead.
      assert.ok(/^Radiology second opinion from board-certified Egyptian consultants/.test(helper.readHead(bodies['/specialties/radiology']).description));
      assert.ok(/^رأي طبي ثانٍ في الأشعة/.test(helper.readHead(bodies['/ar/specialties/radiology']).description));
      // Title is the name in the page's language.
      assert.strictEqual(helper.readHead(bodies['/ar/specialties/cardiology']).title, 'أمراض القلب – تشخيصة');
      assert.strictEqual(helper.readHead(bodies['/specialties/cardiology']).title, 'Cardiology – Tashkheesa');
    });

    await check('Arabic /services cards are Arabic (with the Arabic generic line for an unmapped service)', async () => {
      const ar = bodies['/ar/services'] || '';
      const en = bodies['/services'] || '';
      assert.ok(ar.includes('استشاري قلب بيراجع الإيكو'), 'Echocardiogram card not in Arabic');
      assert.ok(ar.includes('استشاري أشعة متخصص بيحلل الرنين'), 'MRI card not in Arabic');
      assert.ok(ar.includes('مراجعة من دكتور متخصص بتقرير مكتوب مفصل فيه النتائج والتوصيات الطبية.'), 'unmapped service lacks the Arabic generic line');
      assert.ok(!ar.includes('A cardiologist reviews your echocardiogram'), 'English card copy on the Arabic page');
      assert.ok(en.includes('A cardiologist reviews your echocardiogram'), 'English page lost its card copy');
    });
  } finally {
    await app.close();
  }
})();
