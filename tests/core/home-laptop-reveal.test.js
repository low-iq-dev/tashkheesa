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
//      closing CTA, and goes register → wizard with the page language.
//   4. Nothing about the catalogue is typed in: the specialty grid is the
//      open specialties, each with its bookable count, each linking to a
//      section that really exists on /services.
//   5. /ar/ is RTL with the Arabic headline; copy that has no Arabic yet is
//      marked lang="en" dir="ltr".
//   6. The page is self-contained: marketing.css only (never beside the old
//      sheets), the motion script external + deferred (CSP), Pixel untouched.

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
      assert.deepStrictEqual(names, ['idle', 'rise', 'rv-bar', 'rv-bg', 'rv-card', 'rv-cue', 'rv-glow', 'rv-head',
        'rv-laptop', 'rv-lid', 'rv-lock', 'rv-ui', 'vt-in', 'vt-out']);
      // The JS fallback animates the same names off the same data-rv attribute.
      const js = read('public/js/home-motion.js');
      assert.ok(js.includes("document.querySelectorAll('[data-rv]')") && js.includes("'rv-lid':      [{transform:'rotateX(-102deg)'},{transform:'rotateX(14deg)'}]"),
        'home-motion.js no longer mirrors the CSS keyframes');
    });

    // ── 3. The booking gate ────────────────────────────────────────────────
    await check('booking shut: three locked CTAs, no link into the wizard', async () => {
      for (const r of [en, ar]) {
        assert.strictEqual((r.body.match(/class="btn btn-brass is-cta-locked"/g) || []).length, 3, 'header + opening + closing CTA');
        assert.ok(!hrefs(r.body).some((h) => /register|new-case/.test(h)), 'a booking link rendered while the gate is shut');
      }
    });

    await check('booking open: all three go register → wizard, with the page language top-level', async () => {
      for (const [r, lang] of [[enOpen, 'en'], [arOpen, 'ar']]) {
        const links = hrefs(r.body).filter((h) => /^\/register\b/.test(h));
        assert.strictEqual(links.length, 3, 'header + opening + closing CTA, got ' + JSON.stringify(links));
        for (const h of links) {
          const u = new URL(h, 'https://x.test');
          assert.strictEqual(u.searchParams.get('next'), '/patient/new-case', 'next: ' + h);
          assert.strictEqual(u.searchParams.get('lang'), lang, 'lang must be top-level: ' + h);
        }
        assert.ok(!/is-cta-locked/.test(r.body), 'a locked CTA rendered while the gate is open');
      }
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
    });

    // ── 5. Arabic ──────────────────────────────────────────────────────────
    await check('/ar/ is RTL with the Arabic headline; untranslated copy is marked English LTR', async () => {
      assert.strictEqual(ar.status, 200);
      const head = helper.readHead(ar.body);
      assert.strictEqual(head.htmlLang, 'ar');
      assert.strictEqual(head.htmlDir, 'rtl');
      assert.strictEqual(h1(ar.body), 'رأي طبي ثانٍ مكتوب من استشاري باسمه — خلال ٤٨ ساعة');
      assert.ok(/<a class="link ar nav-lang" href="\/" rel="alternate" hreflang="en" lang="en">English<\/a>/.test(ar.body), 'language switch on /ar/');
      assert.ok(/<a class="link ar nav-lang" href="\/ar\/" rel="alternate" hreflang="ar-EG" lang="ar">/.test(en.body), 'language switch on /');
      for (const cls of ['strip', 'wrap sec reveal', 'receive', 'hospital', 'tiers', 'faq', 'cta-wrap']) {
        const tag = (ar.body.match(new RegExp('<section[^>]*class="' + cls + '"[^>]*>')) || [''])[0];
        assert.ok(/lang="en" dir="ltr"/.test(tag), 'the "' + cls + '" section is English copy and must say so on /ar/: ' + tag);
        const enTag = (en.body.match(new RegExp('<section[^>]*class="' + cls + '"[^>]*>')) || [''])[0];
        assert.ok(enTag && !/\bdir=/.test(enTag), 'the English page needs no dir override on "' + cls + '"');
      }
      // The screen mock is a picture of the English portal on both pages.
      assert.ok(/class="rv-ui"[^>]*role="img"[^>]*lang="en" dir="ltr"/.test(ar.body));
    });

    // ── 6. Self-contained ──────────────────────────────────────────────────
    await check('one stylesheet, an external deferred motion script, the Pixel as it was', async () => {
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
