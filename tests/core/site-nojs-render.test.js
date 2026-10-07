// tests/core/site-nojs-render.test.js
//
// No-JS fallback guards (2026-09-17). With JavaScript disabled the homepage
// used to render blank feature cards (animations.css shipped `.reveal
// { opacity: 0 }` unconditionally, un-hidden only by scroll JS) and advertise
// "0 Beds · 0 Consultants · 0 Specialties" (the stat text was a literal 0,
// with the real figure stuck in data-count-to for the count-up script).
//
// Guards, in both languages, through the real request pipeline
// (tests/_helpers/public_site_app.js):
//   1. The server-rendered stat text is the real figure, suffix included —
//      never a bare 0.
//   2. animations.css hides .reveal/.reveal-left/.reveal-right ONLY under an
//      html.js ancestor. Since 7 Oct 2026 the homepage (the laptop reveal)
//      loads marketing.css instead: that sheet must never hide a section with
//      a plain rule, and the page must carry the <noscript> rule that shows
//      the opening when neither CSS scroll-driven animations nor JS can.
//   3. The footer links Instagram (the live channel) and no longer links
//      Twitter or LinkedIn (no accounts exist behind them).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startPublicSiteApp } = require(path.join(__dirname, '..', '_helpers', 'public_site_app'));

const ROOT = path.join(__dirname, '..', '..');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; }
};

console.log('\n🚫🟨 No-JS fallback — stats, reveal scoping, footer socials\n');

module.exports = (async function run() {
  // ── 2a. CSS: the hidden state must not exist outside html.js ─────────────
  try {
    const css = fs.readFileSync(path.join(ROOT, 'public/css/animations.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Every flat `selector { body }` pair — rules inside @media blocks match
    // too, since each inner rule is itself brace-free on both sides.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    let hiddenRules = 0;
    while ((m = ruleRe.exec(css))) {
      const body = m[2];
      if (!/opacity\s*:\s*0\s*[;}]?\s*$|opacity\s*:\s*0\s*;/m.test(body)) continue;
      for (const sel of m[1].split(',')) {
        if (!/\.reveal(-left|-right)?\s*$/.test(sel.trim())) continue;
        hiddenRules++;
        assert.ok(/html\.js/.test(sel),
          'animations.css hides "' + sel.trim() + '" without an html.js ancestor — ' +
          'with JS off that content renders blank. Scope it under html.js.');
      }
    }
    assert.ok(hiddenRules >= 3,
      'expected the three js-scoped hidden rules (.reveal/.reveal-left/.reveal-right); found ' + hiddenRules);
    t.pass('animations.css: .reveal hidden only under html.js (' + hiddenRules + ' rules checked)');
  } catch (e) { t.fail('animations.css: .reveal hidden only under html.js', e); }

  // ── 2c. marketing.css never hides a section on its own ───────────────────
  // .reveal sections enter via a CSS view() animation where supported and are
  // hidden-then-shown by home-motion.js where not. A flat `.reveal{opacity:0}`
  // in the sheet would blank every section for a visitor with JS off.
  try {
    const css = fs.readFileSync(path.join(ROOT, 'public/styles/marketing.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(css))) {
      if (!/(^|,)\s*\.reveal\s*$/.test(m[1]) && !/(^|,)\s*\.reveal\s*,/.test(m[1])) continue;
      assert.ok(!/opacity\s*:\s*0(?![.\d])/.test(m[2]),
        'marketing.css hides .reveal outside an animation — with JS off the sections render blank');
    }
    t.pass('marketing.css: .reveal is never hidden by a plain rule');
  } catch (e) { t.fail('marketing.css: .reveal is never hidden by a plain rule', e); }

  // ── Rendered pages ────────────────────────────────────────────────────────
  let app;
  try { app = await startPublicSiteApp(); } catch (e) { t.fail('site-nojs-render: start app', e); return; }
  try {
    for (const p of ['/', '/ar/']) {
      let body;
      try {
        const r = await app.get(p);
        assert.strictEqual(r.status, 200, 'GET ' + p + ' → ' + r.status);
        body = r.body;
        t.pass(p + ': renders 200');
      } catch (e) { t.fail(p + ': renders 200', e); continue; }

      // 1. Real stat figures as server-side text. 7 Oct 2026 (laptop-reveal
      //    home): the tiles are <dl class="stats"> and there is no count-up
      //    script at all. The specialty tile is the live open count — the
      //    helper's fixture catalogue has two open specialties.
      try {
        const dl = (body.match(/<dl class="stats">([\s\S]*?)<\/dl>/) || [])[1] || '';
        const stats = [...dl.matchAll(/<dt>([^<]*)<\/dt>/g)].map((x) => x[1].trim());
        assert.deepStrictEqual(stats, ['280', '2', '48h', '4h'],
          p + ' stat text must be the real figures with suffixes, got: ' + JSON.stringify(stats));
        t.pass(p + ': stats read 280 / 2 / 48h / 4h server-side, never 0');
      } catch (e) { t.fail(p + ': stats read 280 / 2 / 48h / 4h server-side, never 0', e); }

      // 2b. With JS off the page must not be left hidden. The home page no
      //     longer loads animations.css; its motion is marketing.css, whose
      //     opening starts transparent and is faded in by CSS scroll-driven
      //     animations or, failing those, by /js/home-motion.js. With neither,
      //     the <noscript> rule must show the opening's final state.
      try {
        assert.ok(body.indexOf('animations.css') === -1, p + ' still loads animations.css next to marketing.css');
        const ns = (body.match(/<noscript><style>([\s\S]*?)<\/style><\/noscript>/) || [])[1] || '';
        assert.ok(/@supports not \(animation-timeline: scroll\(\)\)/.test(ns),
          p + ' has no <noscript> rule for browsers without CSS scroll-driven animations');
        assert.ok(/\.rv-head[^{}]*\{opacity:1\}/.test(ns), p + ': the no-JS rule does not un-hide the headline block');
        assert.ok(body.indexOf('marketing.css') < body.indexOf('<noscript><style>'),
          p + ': the no-JS rule must come after marketing.css or the sheet overrides it');
        t.pass(p + ': a <noscript> rule shows the opening when nothing can animate it');
      } catch (e) { t.fail(p + ': a <noscript> rule shows the opening when nothing can animate it', e); }

      // 3. Footer socials: Instagram in, Twitter/LinkedIn out.
      try {
        assert.ok(/instagram\.com\/tashkheesaa/.test(body), p + ' footer must link Instagram');
        assert.ok(!/twitter\.com|aria-label="Twitter"/i.test(body), p + ' must not link Twitter');
        assert.ok(!/linkedin\.com|aria-label="LinkedIn"/i.test(body), p + ' must not link LinkedIn');
        t.pass(p + ': footer links Instagram; Twitter/LinkedIn gone');
      } catch (e) { t.fail(p + ': footer links Instagram; Twitter/LinkedIn gone', e); }
    }
  } finally {
    await app.close();
  }
})();
