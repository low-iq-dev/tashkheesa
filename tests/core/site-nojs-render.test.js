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
//      html.js ancestor, and the homepage carries the inline snippet that
//      sets that class before the animations stylesheet loads.
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

      // 1. Real stat figures as server-side text (helper stubs specialtyCount=7).
      try {
        const stats = [...body.matchAll(/class="stat-number"[^>]*>([^<]*)</g)].map((x) => x[1].trim());
        assert.deepStrictEqual(stats, ['220', '150+', '7', '48h'],
          p + ' stat text must be the real figures with suffixes, got: ' + JSON.stringify(stats));
        t.pass(p + ': stats read 220 / 150+ / 7 / 48h server-side, never 0');
      } catch (e) { t.fail(p + ': stats read 220 / 150+ / 7 / 48h server-side, never 0', e); }

      // 2b. The html.js snippet is inline, nonce-ready, and precedes the
      //     animations stylesheet, so the page can never paint hidden.
      try {
        const snippetAt = body.indexOf("document.documentElement.classList.add('js')");
        const sheetAt = body.indexOf('animations.css');
        assert.ok(snippetAt !== -1, p + ' is missing the inline html.js snippet');
        assert.ok(sheetAt !== -1, p + ' is missing the animations.css link');
        assert.ok(snippetAt < sheetAt, p + ': the html.js snippet must come before animations.css');
        t.pass(p + ': inline html.js snippet precedes animations.css');
      } catch (e) { t.fail(p + ': inline html.js snippet precedes animations.css', e); }

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
