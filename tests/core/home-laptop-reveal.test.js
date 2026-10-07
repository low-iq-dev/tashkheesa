// tests/core/home-laptop-reveal.test.js
//
// 7 Oct 2026 — the home page opens with the laptop reveal (ported from the
// approved reference, docs/redesign/home-laptop-reveal.html). Rendered through
// the real request pipeline (tests/_helpers/public_site_app.js), no database.
//
// What must not drift:
//   1. `/` renders, its <h1> is the approved headline, and the opening is the
//      hero-reveal partial — with the headline, lede and CTAs server-rendered
//      inside it (never lazy-rendered or injected by script).
//   2. THE CHOREOGRAPHY. Each animated element carries data-rv="A,B" and an
//      inline animation-range:Apx Bpx; the CSS reads one and the JS fallback
//      the other. All 13 pairs are pinned here, and the stylesheet keeps the
//      stage height and keyframes they are tuned against.
//   3. Booking stays behind the gate, in the header, the opening and the
//      closing CTA, and goes to /start in the page's language (the landing
//      page the inner-page header uses). The opening's buttons are not
//      reachable while they are still transparent.
//   4. Nothing about the catalogue is typed in: the specialty grid is the
//      open specialties, each with its bookable count, each linking to a
//      section that really exists on /services.
//   5. /ar/ is Arabic throughout: every string has its Arabic, counted nouns
//      agree with the live numbers, specialties use their Arabic names.
//   6. Phones and tablets get a menu that works without script.
//   7. The page is self-contained: marketing.css only (never beside the old
//      sheets), scripts external + deferred (CSP), Pixel wiring untouched.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const helper = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n💻 Home — the laptop-reveal opening\n');

// class → [data-rv, inline style], in document order, exactly as approved.
const CHOREOGRAPHY = [
  ['rv-bg', '0,700', 'animation-range:0px 700px'],
  ['rv-lock', '120,420', 'animation-range:120px 420px'],
  ['rv-cue', '200,500', 'animation-range:200px 500px'],
  ['rv-head', '380,820', 'animation-range:380px 820px'],
  ['rv-laptop', '300,900', 'animation-range:300px 900px'],
  ['rv-lid', '520,1600', 'animation-range:520px 1600px'],
  ['rv-screen', '1150,1650', 'animation-range:1150px 1650px'],
  ['rv-ui', '1100,1600', 'animation-range:1100px 1600px'],
  ['rv-deckglow', '1150,1650', 'animation-range:1150px 1650px'],
  ['rv-card rv-c1', '1500,2000', '--dx:-140px;--dy:80px;animation-range:1500px 2000px'],
  ['rv-card rv-c2', '1650,2150', '--dx:140px;--dy:60px;animation-range:1650px 2150px'],
  ['rv-card rv-c3', '1800,2300', '--dx:-120px;--dy:-60px;animation-range:1800px 2300px'],
  ['rv-card rv-c4', '1950,2450', '--dx:120px;--dy:-70px;animation-range:1950px 2450px']
];

const text = (html) => helper.decodeEntities(String(html || '')
  .replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
const h1 = (body) => text((body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
const opening = (body) => (body.match(/<section class="rv"[\s\S]*?<\/section>/) || [''])[0];
const hrefs = (html) => (html.match(/<a\b[^>]*\bhref="[^"]*"/g) || [])
  .map((a) => helper.decodeEntities(a.match(/href="([^"]*)"/)[1]));

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

module.exports = (async function run() {
  let shut, open;
  try {
    shut = await helper.startPublicSiteApp();
    open = await helper.startPublicSiteApp({ bookingCtaEnabled: true });
  } catch (e) { t.fail('home-laptop-reveal: start app', e); return; }

  try {
    const en = await shut.get('/');
    const ar = await shut.get('/ar/');
    const enOpen = await open.get('/');
    const arOpen = await open.get('/ar/');

    // ── 1. The page, its H1, the partial ───────────────────────────────────
    await check('/ renders and its <h1> is the approved headline', async () => {
      assert.strictEqual(en.status, 200, 'GET / → ' + en.status + ' ' + en.body.slice(0, 300));
      assert.strictEqual(h1(en.body), 'A second opinion with a name on it.');
      assert.strictEqual((en.body.match(/<h1\b/g) || []).length, 1, 'exactly one <h1>');
    });

    await check('the opening is the hero-reveal partial, with H1, lede and CTAs server-rendered in it', async () => {
      assert.ok(/<%-\s*include\('partials\/hero-reveal'/.test(read('src/views/index.ejs')),
        'index.ejs does not include partials/hero-reveal');
      assert.ok(/<section class="rv"/.test(read('src/views/partials/hero-reveal.ejs')),
        'partials/hero-reveal.ejs is not the <section class="rv"> stage');
      const stage = opening(en.body);
      assert.ok(stage, 'the rendered page has no <section class="rv">');
      assert.strictEqual((en.body.match(/<section class="rv"/g) || []).length, 1, 'the opening renders once');
      const head = (stage.match(/<div class="rv-head"[\s\S]*?<div class="rv-laptop"/) || [''])[0];
      assert.ok(/<h1 class="display">A second opinion<br>with a <em>name<\/em> on it\.<\/h1>/.test(head), 'H1 markup');
      assert.ok(/<p class="lede">Upload your scans, lab results or reports\./.test(head), 'lede is not in the opening');
      assert.ok(/class="btn btn-brass[^"]*"[^>]*>Start your case</.test(head), 'primary CTA is not in the opening');
      assert.ok(/class="btn btn-ghost-dark" href="\/services">See services &amp; prices</.test(head), 'secondary CTA is not in the opening');
      // The safety line sits under the Start button here and under the closing CTA.
      assert.ok(/<p class="not-emergency">Not for emergencies\./.test(head), 'the not-for-emergencies line is not under the hero CTAs');
      assert.strictEqual((en.body.match(/class="not-emergency"/g) || []).length, 2, 'the line belongs under both Start buttons');
      // Present in the HTML the server sends — not built by script.
      assert.ok(!/<template\b|data-lazy|loading="lazy"/.test(stage), 'nothing in the opening may be lazy-rendered');
    });

    // ── 2. The choreography ────────────────────────────────────────────────
    await check('all 13 data-rv / animation-range pairs are the approved ones', async () => {
      const got = [...opening(en.body).matchAll(/class="(rv-[^"]*)" data-rv="([^"]*)" style="([^"]*)"/g)]
        .map((m) => [m[1], m[2], m[3]]);
      assert.deepStrictEqual(got, CHOREOGRAPHY);
      // The pair is one number written twice: they must agree element by element.
      for (const [cls, rv, style] of got) {
        const [a, b] = rv.split(',');
        assert.ok(style.endsWith('animation-range:' + a + 'px ' + b + 'px'), cls + ': data-rv and animation-range disagree');
      }
      const arGot = [...opening(ar.body).matchAll(/class="(rv-[^"]*)" data-rv="([^"]*)" style="([^"]*)"/g)]
        .map((m) => [m[1], m[2], m[3]]);
      assert.deepStrictEqual(arGot, CHOREOGRAPHY, '/ar/ must run the same choreography');
    });

    await check('marketing.css keeps the stage and keyframes the ranges are tuned against', async () => {
      const css = read('public/styles/marketing.css');
      assert.ok(css.includes('.rv{height:calc(2700px + 100vh);'), 'the stage is no longer pinned for 2700px');
      assert.ok(css.includes('@supports (animation-timeline: scroll()){\n  [data-rv]{animation-timeline:scroll(root);animation-timing-function:linear;animation-fill-mode:both}'),
        'the scroll-driven @supports block changed');
      assert.ok(css.includes('@keyframes rv-lid{from{transform:rotateX(-102deg)}to{transform:rotateX(14deg)}}'), 'the lid keyframes changed');
      assert.ok(css.includes('@media (prefers-reduced-motion: reduce){\n  [data-rv]{animation:none !important}'), 'the reduced-motion block changed');
      const names = (css.match(/@keyframes ([\w-]+)/g) || []).map((k) => k.slice(11)).sort();
      // The reference's fourteen, plus rv-ctas (a port addition — see the gate check below).
      assert.deepStrictEqual(names, ['idle', 'rise', 'rv-bar', 'rv-bg', 'rv-card', 'rv-ctas', 'rv-cue', 'rv-glow', 'rv-head',
        'rv-laptop', 'rv-lid', 'rv-lock', 'rv-ui', 'vt-in', 'vt-out']);
      // The JS fallback animates the same names off the same data-rv attribute.
      const js = read('public/js/home-motion.js');
      assert.ok(js.includes("document.querySelectorAll('[data-rv]')") && js.includes("'rv-lid':      [{transform:'rotateX(-102deg)'},{transform:'rotateX(14deg)'}]"),
        'home-motion.js no longer mirrors the CSS keyframes');
    });

    // ── 3. The booking gate ────────────────────────────────────────────────
    await check('booking shut: three locked CTAs, no link to /start or the wizard', async () => {
      for (const r of [en, ar]) {
        assert.strictEqual((r.body.match(/class="btn btn-brass is-cta-locked"/g) || []).length, 3, 'header + opening + closing CTA');
        assert.ok(!hrefs(r.body).some((h) => /\/start\b|register|new-case/.test(h)), 'a booking link rendered while the gate is shut');
      }
    });

    await check('booking open: all three go to /start in the page language, like the inner-page header', async () => {
      for (const [r, want] of [[enOpen, '/start'], [arOpen, '/ar/start']]) {
        const links = [...r.body.matchAll(/<a class="btn btn-brass" href="([^"]*)"([^>]*)>/g)].map((m) => ({ href: m[1], rest: m[2] }));
        assert.deepStrictEqual(links.map((l) => l.href), [want, want, want], 'header + opening + closing CTA');
        assert.ok(/data-nav-start/.test(links[0].rest), 'the header Start carries data-nav-start, as layouts/public.ejs does');
        assert.ok(!hrefs(r.body).some((h) => /register|new-case/.test(h)), 'the home page no longer links to register or the wizard');
        assert.ok(!/is-cta-locked/.test(r.body), 'a locked CTA rendered while the gate is open');
      }
      // Source: the links are built from one variable the booking-gate lint watches.
      const src = read('src/views/index.ejs');
      assert.ok(src.includes("var __startHref = (locals.publicLinkPrefix || '') + '/start';"), '__startHref is not /start with the language prefix');
      assert.strictEqual((src.match(/<% if \(__ctaOn\) \{ %><a class="btn btn-brass" href="<%= __startHref %>"/g) || []).length, 2, 'index.ejs: header and closing CTA behind __ctaOn');
      assert.ok(/<% if \(__ctaOn\) \{ %><a class="btn btn-brass" href="<%= __startHref %>"/.test(read('src/views/partials/hero-reveal.ejs')), 'hero-reveal.ejs: CTA behind __ctaOn');
    });

    await check('the opening\'s buttons are unreachable until the headline block is half faded in', async () => {
      const css = read('public/styles/marketing.css');
      // Only the buttons are hidden — never the block that holds the <h1>.
      assert.ok(css.includes('@keyframes rv-ctas{0%,50%{visibility:hidden}50.01%,100%{visibility:visible}}'), 'rv-ctas keyframes');
      const rule = (css.match(/\.rv-head \.ctas\{animation-name:rv-ctas;[^}]*\}/) || [''])[0];
      assert.ok(/animation-timeline:scroll\(root\)/.test(rule) && /animation-fill-mode:both/.test(rule), 'the CTAs follow the scroll timeline: ' + rule);
      assert.ok(!/\.rv-head\{[^}]*visibility/.test(css) && !/\.rv-head\[data-rv\]\{[^}]*visibility/.test(css), '.rv-head itself must stay visible to assistive tech');
      // Its range is .rv-head's own, written once more in CSS: the two must agree.
      const headRange = CHOREOGRAPHY.find((c) => c[0] === 'rv-head')[1].split(',');
      assert.ok(rule.includes('animation-range:' + headRange[0] + 'px ' + headRange[1] + 'px'), 'rv-ctas range must be .rv-head\'s (' + headRange.join('–') + '): ' + rule);
      assert.ok(/@media \(prefers-reduced-motion: reduce\)\{\.rv-head \.ctas\{animation:none !important\}\}/.test(css), 'reduced motion shows the opening whole, buttons included');
      // No scroll timelines → the same switch in script, read off the same data-rv.
      const js = read('public/js/home-motion.js');
      assert.ok(js.includes("var head = document.querySelector('.rv-head[data-rv]');") && js.includes("var showAt = r[0] + (r[1] - r[0]) / 2;") &&
        js.includes("ctas.style.visibility = y > showAt ? 'visible' : 'hidden';"), 'home-motion.js fallback for the CTAs');
      // Nothing ships hidden in the markup: with no CSS support and no script the buttons stay reachable.
      assert.ok(!/class="ctas"[^>]*(hidden|inert|style=)/.test(opening(en.body)), 'the CTA row must not be hidden in the HTML itself');
    });

    // ── 4. The live catalogue ──────────────────────────────────────────────
    await check('the specialty grid is the open specialties, with live counts, linking to real /services sections', async () => {
      const list = helper.fixtureSpecialtyList();
      assert.deepStrictEqual(list.open.map((s) => s.name), ['Cardiology', 'Radiology'], 'fixture sanity');
      const cards = [...en.body.matchAll(/<a class="spec" href="([^"]*)"><b>([^<]*)<\/b><span>([^<]*)<\/span><\/a>/g)]
        .map((m) => ({ href: m[1], name: m[2], count: m[3] }));
      assert.deepStrictEqual(cards, list.open.map((s) => ({
        href: '/services#' + s.anchor, name: s.name, count: s.services + (s.services === 1 ? ' service' : ' services')
      })));
      const services = await shut.get('/services');
      for (const c of cards) {
        assert.ok(services.body.includes('id="' + c.href.split('#')[1] + '"'), c.href + ' points at no section on /services');
      }
      // A specialty with nothing bookable is named once, as coming soon — never a card.
      assert.ok(/<p class="soon">Coming soon: Dermatology<\/p>/.test(en.body), 'coming-soon line');
      assert.ok(!cards.some((c) => c.name === 'Dermatology'), 'an unbookable specialty got a card');
      // The headline figure is the number of cards, in both places it is printed.
      assert.ok(/<span>2 specialties open<\/span>/.test(en.body), 'trust strip count');
      assert.ok(/<dt>2<\/dt><dd>specialties open today<\/dd>/.test(en.body), 'stat tile count');
      // The price floor is the catalogue's, not the reference's.
      assert.ok(/<span>From EGP 1,600<\/span>/.test(en.body) && /<span class="price">From EGP 1,600<\/span>/.test(en.body), 'starting price');
      // On /ar/ the cards stay inside the Arabic site.
      assert.ok(ar.body.includes('<a class="spec" href="/ar/services#cardiology">'), '/ar/ card must link to /ar/services');
    });

    await check('no catalogue read → no cards and no invented list', async () => {
      const blank = await helper.startPublicSiteApp({
        siteStats: Object.assign({}, helper.fakeSiteStats, { getSpecialtyList: async () => ({ open: [], soon: [] }) })
      });
      try {
        const r = await blank.get('/');
        assert.strictEqual(r.status, 200);
        assert.ok(!/class="specs"|class="spec"|class="soon"/.test(r.body), 'cards or a coming-soon line rendered with no data');
        assert.ok(/<dt>7<\/dt><dd>specialties open today<\/dd>/.test(r.body), 'the count falls back to specialtyCount');
      } finally { await blank.close(); }
      // A list that DID arrive with nothing bookable is not a failed read: the page must not
      // claim the fallback count as "open" above a coming-soon line (seen on a local catalogue).
      const none = await helper.startPublicSiteApp({
        siteStats: Object.assign({}, helper.fakeSiteStats, { getSpecialtyList: async () => ({ open: [], soon: [{ name: 'Dermatology', nameAr: null }] }) })
      });
      try {
        const r = await none.get('/');
        assert.ok(!/specialt(y|ies) open<\/span>/.test(r.body), 'the trust strip claimed open specialties when none are');
        assert.ok(/<dt>0<\/dt><dd>specialties open today<\/dd>/.test(r.body), 'the stat tile must read 0, not the fallback');
        assert.ok(/<p class="soon">Coming soon: Dermatology<\/p>/.test(r.body) && !/class="spec"/.test(r.body));
      } finally { await none.close(); }
    });

    // ── 5. Arabic ──────────────────────────────────────────────────────────
    await check('/ar/ is RTL and Arabic throughout — no English-only sections left', async () => {
      assert.strictEqual(ar.status, 200);
      const head = helper.readHead(ar.body);
      assert.strictEqual(head.htmlLang, 'ar');
      assert.strictEqual(head.htmlDir, 'rtl');
      // The Arabic H1 is the SEO-specified one (seo-titles-meta pins it too), not a translation of the English.
      assert.strictEqual(h1(ar.body), 'رأي طبي ثانٍ مكتوب من استشاري باسمه — خلال ٤٨ ساعة');
      assert.ok(/<a class="link ar nav-lang" href="\/" rel="alternate" hreflang="en" lang="en">English<\/a>/.test(ar.body), 'language switch on /ar/');
      assert.ok(/<a class="link ar nav-lang" href="\/ar\/" rel="alternate" hreflang="ar-EG" lang="ar">/.test(en.body), 'language switch on /');
      // Sections follow the page direction; the only English island is the laptop-screen mock.
      for (const tag of ar.body.match(/<(section|footer|article|p|span|h2|h3|li|dd|summary)\b[^>]*>/g) || []) {
        assert.ok(!/lang="en"/.test(tag) && !/dir="ltr"/.test(tag), 'an element is still marked English/LTR on /ar/: ' + tag);
      }
      assert.ok(/class="rv-ui"[^>]*role="img" aria-label="معاينة لبوابة المريض" dir="ltr"/.test(ar.body), 'the screen mock stays LTR, labelled in Arabic');
      assert.ok(/<aside lang="en">/.test(ar.body) && /<main lang="en">/.test(ar.body), 'the mock\'s English content is marked as English');
      const bodyText = text(ar.body.slice(ar.body.indexOf('<div class="page">')));
      for (const phrase of ['The moments a second opinion', 'Four steps', 'What you receive', 'Backed by a hospital', 'Open for review today',
        'Choose how fast', 'Good questions', 'Before your next decision', 'Coming soon', 'specialties open', 'services', 'From EGP', 'Reach us']) {
        assert.ok(bodyText.indexOf(phrase) === -1, 'English copy on the Arabic page: "' + phrase + '"');
      }
      for (const phrase of ['اللحظات اللي تستاهل رأي طبي ثانٍ.', '4 خطوات. من غير أوضة انتظار.', 'مستند بيفضل معاك.', 'وراءنا مستشفى حقيقي،',
        'متاحة للمراجعة النهارده.', 'اختار السرعة. التقرير هو هو.', 'قبل قرارك الجاي،', 'من 1,600 جنيه', 'مجموعة مستشفيات شفا']) {
        assert.ok(ar.body.indexOf(phrase) !== -1, 'missing Arabic copy: ' + phrase);
      }
      // Brand rules that a translation can break without anyone noticing.
      assert.ok(!/الشفاء|مستشفيات الشفا/.test(ar.body), 'the hospital is مجموعة مستشفيات شفا — no ال');
      assert.ok(/مش ذكاء اصطناعي/.test(ar.body), 'the AI question must say a consultant writes it, not an AI');
      assert.ok(/<small> ساعة<\/small>/.test(ar.body) && /4<small> ساعات<\/small>/.test(ar.body) && !/\d+h</.test(ar.body.slice(ar.body.indexOf('<div class="page">'))),
        'hours read "48 ساعة" / "4 ساعات" on /ar/, never "48h"');
    });

    await check('every string in the home templates carries its Arabic', async () => {
      // tt('key', 'English') with no third argument is an English-only string on /ar/.
      const str = "'(?:[^'\\\\]|\\\\.)*'";
      const twoArg = new RegExp("tt\\(\\s*" + str + "\\s*,\\s*" + str + "\\s*\\)", 'g');
      for (const rel of ['src/views/index.ejs', 'src/views/partials/hero-reveal.ejs']) {
        assert.deepStrictEqual(read(rel).match(twoArg) || [], [], rel + ' has tt() calls without Arabic');
      }
    });

    await check('Arabic counted nouns agree with the live numbers (1 · 2 · 3–10 · 11+)', async () => {
      const shaped = (counts) => ({ open: counts.map((n, i) => ({ name: 'Spec ' + i, nameAr: i === 0 ? null : 'تخصص ' + i, services: n, anchor: 'spec-' + i })),
        soon: counts.map((n, i) => ({ name: 'Soon ' + i, nameAr: 'قريب ' + i })) });
      const render = async (counts, p) => {
        const app = await helper.startPublicSiteApp({ siteStats: Object.assign({}, helper.fakeSiteStats, { getSpecialtyList: async () => shaped(counts) }) });
        try { return (await app.get(p)).body; } finally { await app.close(); }
      };
      const cardCounts = (b) => [...b.matchAll(/<a class="spec"[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => m[1]);
      const arBody = await render([1, 2, 3, 10, 11, 16], '/ar/');
      assert.deepStrictEqual(cardCounts(arBody), ['خدمة واحدة', 'خدمتين', '3 خدمات', '10 خدمات', '11 خدمة', '16 خدمة']);
      assert.ok(arBody.includes('<span>6 تخصصات متاحة</span>') && arBody.includes('<dt>6</dt><dd>تخصصات متاحة النهارده</dd>'), 'six open specialties');
      assert.ok(arBody.includes('و6 تخصصات كمان في الطريق.'), 'six more on the way');
      // A specialty with no Arabic name falls back to its English one rather than rendering empty.
      assert.ok(arBody.includes('<b>Spec 0</b>') && arBody.includes('<b>تخصص 1</b>') && arBody.includes('قريبًا: قريب 0 · قريب 1'), 'Arabic names, with fallback');
      const one = await render([5], '/ar/');
      assert.ok(one.includes('<span>تخصص واحد متاح</span>') && one.includes('وتخصص واحد كمان في الطريق.'), 'one');
      const two = await render([5, 5], '/ar/');
      assert.ok(two.includes('<span>تخصصين متاحين</span>') && two.includes('وتخصصين كمان في الطريق.'), 'two');
      const eleven = await render(new Array(11).fill(4), '/ar/');
      assert.ok(eleven.includes('<span>11 تخصص متاح</span>') && eleven.includes('<dd>تخصص متاح النهارده</dd>') && eleven.includes('و11 تخصص كمان في الطريق.'), 'eleven');
      // English: two forms.
      const enBody = await render([1, 2], '/');
      assert.deepStrictEqual(cardCounts(enBody), ['1 service', '2 services']);
      assert.ok(enBody.includes('<span>2 specialties open</span>') && enBody.includes('2 more are being onboarded.'));
      const enOne = await render([3], '/');
      assert.ok(enOne.includes('<span>1 specialty open</span>') && enOne.includes('1 more is being onboarded.') && enOne.includes('<dd>specialty open today</dd>'));
    });

    await check('the grid renders the production catalogue as production returned it', async () => {
      // site_stats.getSpecialtyList's SELECT, run read-only against production on 7 Oct 2026.
      const PROD = [['Pulmonology', 'أمراض الصدر', 0], ['Pediatrics', 'طب الأطفال', 16], ['Oncology', 'الأورام', 0], ['Urology', 'المسالك البولية', 10],
        ['Radiology', 'الأشعة', 10], ['Clinical Nutrition', 'التغذية العلاجية', 1], ['Lab & Pathology', 'المختبر وعلم الأمراض', 0],
        ['Vascular Surgery', 'جراحة الأوعية الدموية', 0], ['Ophthalmology', 'طب العيون', 0], ['Gastroenterology', 'الجهاز الهضمي', 1],
        ['Cardiology', 'أمراض القلب', 10], ['Emergency Medicine', 'طب الطوارئ', 0], ['Orthopedics', 'العظام', 12], ['Neurology', 'المخ والأعصاب', 0],
        ['OB/GYN', 'النساء والتوليد', 10], ['Nephrology', 'أمراض الكلى', 8], ['Psychiatry', 'الطب النفسي', 0], ['Internal Medicine', 'الباطنة', 7],
        ['Hematology', 'أمراض الدم', 0], ['Cardiothoracic Surgery', 'جراحة القلب والصدر', 0], ['Dermatology', 'الأمراض الجلدية', 0],
        ['Endocrinology', 'الغدد الصماء', 0], ['Rheumatology', 'أمراض الروماتيزم', 0]].map(([name, name_ar, bookable]) => ({ name, name_ar, bookable }));
      const { shapeSpecialtyList } = helper.loadReal(path.join(ROOT, 'src', 'services', 'site_stats'));
      const list = shapeSpecialtyList(PROD);
      assert.strictEqual(list.open.length, 10); assert.strictEqual(list.soon.length, 13);
      const app = await helper.startPublicSiteApp({ siteStats: Object.assign({}, helper.fakeSiteStats, { getSpecialtyList: async () => list }), homeLocals: { priceRangeMin: '750' } });
      try {
        const cards = (b) => [...b.matchAll(/<a class="spec" href="([^"]*)"><b>([^<]*)<\/b><span>([^<]*)<\/span>/g)].map((m) => m[2] + ' | ' + m[3] + ' | ' + m[1]);
        const enB = (await app.get('/')).body, arB = (await app.get('/ar/')).body;
        assert.deepStrictEqual(cards(enB), ['Pediatrics | 16 services | /services#pediatrics', 'Orthopedics | 12 services | /services#orthopedics',
          'Cardiology | 10 services | /services#cardiology', 'OB/GYN | 10 services | /services#ob-gyn', 'Radiology | 10 services | /services#radiology',
          'Urology | 10 services | /services#urology', 'Nephrology | 8 services | /services#nephrology', 'Internal Medicine | 7 services | /services#internal-medicine',
          'Clinical Nutrition | 1 service | /services#clinical-nutrition', 'Gastroenterology | 1 service | /services#gastroenterology']);
        assert.deepStrictEqual(cards(arB), ['طب الأطفال | 16 خدمة | /ar/services#pediatrics', 'العظام | 12 خدمة | /ar/services#orthopedics',
          'أمراض القلب | 10 خدمات | /ar/services#cardiology', 'النساء والتوليد | 10 خدمات | /ar/services#ob-gyn', 'الأشعة | 10 خدمات | /ar/services#radiology',
          'المسالك البولية | 10 خدمات | /ar/services#urology', 'أمراض الكلى | 8 خدمات | /ar/services#nephrology', 'الباطنة | 7 خدمات | /ar/services#internal-medicine',
          'التغذية العلاجية | خدمة واحدة | /ar/services#clinical-nutrition', 'الجهاز الهضمي | خدمة واحدة | /ar/services#gastroenterology']);
        assert.ok(enB.includes('<span>10 specialties open</span>') && enB.includes('<span>From EGP 750</span>') && enB.includes('13 more are being onboarded.'));
        assert.ok(arB.includes('<span>10 تخصصات متاحة</span>') && arB.includes('<span>من 750 جنيه</span>') && arB.includes('و13 تخصص كمان في الطريق.'));
        assert.ok(arB.includes('قريبًا: جراحة القلب والصدر · الأمراض الجلدية · طب الطوارئ'), 'coming-soon names in Arabic');
      } finally { await app.close(); }
    });

    // ── 6. The phone / tablet menu ─────────────────────────────────────────
    await check('the menu is a native disclosure holding the links, Sign in and the language switch', async () => {
      for (const [r, pre, lang] of [[en, '', 'en'], [ar, '/ar', 'ar']]) {
        const menu = (r.body.match(/<details class="menu" data-home-menu>[\s\S]*?<\/details>/) || [''])[0];
        assert.ok(menu, 'no <details class="menu">');
        assert.ok(new RegExp('<summary aria-label="' + (lang === 'ar' ? 'القائمة' : 'Menu') + '">').test(menu), 'the button needs an accessible name');
        assert.ok(!/\bopen\b(?=[^<]*>)/.test(menu.slice(0, menu.indexOf('>') + 1)), 'the menu must ship closed');
        const links = [...menu.matchAll(/<a\b([^>]*)href="([^"]*)"([^>]*)>/g)].map((m) => ({ href: helper.decodeEntities(m[2]), attrs: m[1] + m[3] }));
        assert.deepStrictEqual(links.map((l) => l.href), [pre + '/services', pre + '/specialties', pre + '/#how-it-works', pre + '/about', pre + '/faq',
          '/login?lang=' + lang, lang === 'ar' ? '/' : '/ar/']);
        // .link / .ar are the classes the reference hides on phones — a panel link carrying one would be invisible.
        for (const l of links) assert.ok(!/class="[^"]*\b(link|ar)\b/.test(l.attrs), 'a panel link carries a class the stylesheet hides: ' + l.attrs);
        const langLink = links[links.length - 1];
        assert.ok(/class="menu-lang nav-lang"/.test(langLink.attrs) && /rel="alternate"/.test(langLink.attrs) && /hreflang=/.test(langLink.attrs), 'the panel language switch: ' + langLink.attrs);
        // Works with no script: nothing in it depends on a handler to be reachable.
        assert.ok(!/\bhidden\b|aria-hidden|tabindex="-1"|onclick/.test(menu.replace(/<svg[\s\S]*?<\/svg>/g, '')), 'the menu must be usable without JavaScript');
        assert.ok(/<script src="\/js\/home-nav\.js" defer><\/script>/.test(r.body), 'home-nav.js must load external + deferred');
      }
      const css = read('public/styles/marketing.css');
      assert.ok(css.includes('\n.menu{display:none}\n'), 'the menu is hidden where the full link row fits');
      assert.ok(/@media \(max-width:1100px\)\{\s*\.nav a\.link,\.nav \.ar\{display:none\}\s*\.menu\{display:block\}/.test(css), 'one or the other is shown, never both');
      assert.ok(/inset-inline:0/.test((css.match(/\.menu-panel\{[^}]*\}/) || [''])[0]), 'the panel is laid out with logical properties (RTL)');
      assert.ok(/\.menu summary:focus-visible[^{]*\{outline:/.test(css), 'the menu button shows keyboard focus');
      const js = read('public/js/home-nav.js');
      assert.ok(/Escape/.test(js) && /button\.focus\(\)/.test(js) && /min-width: 1101px/.test(js), 'home-nav.js: Escape returns focus; closes above the breakpoint');
    });

    // ── 7. Self-contained ──────────────────────────────────────────────────
    await check('one stylesheet, external deferred scripts, the Pixel wiring as it was', async () => {
      for (const r of [en, ar]) {
        assert.ok(/<link rel="stylesheet" href="\/site\/styles\/marketing\.css" \/>/.test(r.body), 'marketing.css link');
        assert.ok(!/href="\/styles\.css"|\/site\/css\/|portal-(variables|components|global)\.css/.test(r.body),
          'marketing.css must not load beside the old sheets — its element rules are unscoped');
        assert.ok(/<script src="\/js\/home-motion\.js" defer><\/script>/.test(r.body), 'home-motion.js must load with defer');
        assert.ok(/<body data-meta-pixel="1">/.test(r.body) && /<script src="\/js\/meta_pixel\.js" defer><\/script>/.test(r.body), 'Meta Pixel wiring');
        // script-src has no 'unsafe-inline': every executable inline script needs the nonce.
        const inline = [...r.body.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
        for (const attrs of inline) {
          assert.ok(/type="application\/ld\+json"/.test(attrs) || /\bnonce="/.test(attrs), 'inline <script> without a nonce: <script' + attrs + '>');
        }
        assert.ok(/id="how-it-works"/.test(r.body), 'the /how-it-works 301 anchor');
      }
      for (const img of ['shifa-night.jpg', 'report.jpg', 'patient.jpg', 'laptop-lid.jpg', 'laptop-deck.jpg']) {
        assert.ok(fs.existsSync(path.join(ROOT, 'public/img/home', img)), 'public/img/home/' + img + ' is missing');
      }
      assert.ok(/url\(\.\.\/img\/home\/laptop-lid\.jpg\)/.test(read('public/styles/marketing.css')) &&
        /url\(\.\.\/img\/home\/laptop-deck\.jpg\)/.test(read('public/styles/marketing.css')), 'laptop plates url()');
    });
  } finally {
    await shut.close();
    await open.close();
  }
})();
