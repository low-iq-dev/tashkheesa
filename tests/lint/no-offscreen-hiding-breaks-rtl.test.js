'use strict';
// Guard: never hide an element by pushing it off-screen with a large negative
// physical offset. It works in English and silently breaks Arabic.
//
// WHY THIS FILE EXISTS
//
// 2026-08-29, visual audit. /apply?lang=ar rendered as a completely blank white
// page in a headless screenshot. The HTML was fine — 81 text nodes, correct
// Arabic, h1 visible with a computed rect. The cause was one line of CSS:
//
//   .apply-page .hp-field { position: absolute; left: -9999px; ... }
//
// the spam honeypot. In LTR, -9999px is off the inline START, which the browser
// clips and does not make scrollable. The Arabic page is dir="rtl", where the
// inline start is the RIGHT — so the same offset lands off the inline END and
// becomes real scrollable overflow. The document measured 11,142px wide against
// a 1,440px viewport, and because RTL documents open scrolled to their right
// edge, the page opened on ~9,700px of empty background.
//
// A visitor could still see the form (it was painted, just beside a huge void),
// but the page had ~9,700px of horizontal scroll — on a phone, a sideways swipe
// into nothing on the page we send doctors to.
//
// This is invisible to every test that renders HTML, because the HTML is
// correct. Only laying it out in RTL reveals it. So: a source-text check on the
// CSS, which is where the mistake actually lives.
//
// The fix is the standard visually-hidden clip pattern, which takes zero space
// in either direction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', '..', 'public', 'css');

// `left`/`right`/`margin-left`/`margin-right`/`text-indent` set to a large
// negative pixel or em value. `top` is fine — vertical overflow behaves the
// same in both directions, and RTL does not mirror it.
const OFFSCREEN = /(^|[^-\w])(left|right|margin-left|margin-right|text-indent)\s*:\s*-\s*(\d{3,}px|\d{2,}(\.\d+)?em|\d{2,}(\.\d+)?rem)/i;

// Same exemptions as no-physical-margin-padding-in-css.test.js, so the two
// guards agree on what counts as production CSS.
const EXEMPT = new Set(['responsive.css', 'annotator.css']);

function cssFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.css') && !EXEMPT.has(f))
    .map((f) => path.join(dir, f));
}

// Blank out /* ... */ comments across the WHOLE file while preserving newlines,
// so line numbers stay right and a comment that DESCRIBES the pattern (this
// file's own fix is documented in apply.css) is not reported as the pattern.
// A per-line strip cannot do this: the comment spans lines.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

test('no stylesheet hides content with a large negative physical offset', () => {
  const hits = [];
  for (const file of cssFiles(CSS_DIR)) {
    stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (OFFSCREEN.test(line)) {
        hits.push(path.basename(file) + ':' + (i + 1) + '  ' + line.trim().slice(0, 110));
      }
    });
  }
  assert.deepStrictEqual(hits, [],
    'Off-screen hiding via a negative physical offset breaks RTL — it becomes ' +
    'scrollable overflow on the Arabic pages. Use the visually-hidden clip ' +
    'pattern instead:\n' +
    '  position:absolute; width:1px; height:1px; margin:-1px; padding:0;\n' +
    '  border:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap;\n' +
    'Offenders:\n  ' + hits.join('\n  '));
});

test('the apply honeypot still hides itself', () => {
  // Deleting the rule would also pass the check above. It must still be hidden,
  // or the spam trap becomes a visible field on the doctor application form.
  const css = fs.readFileSync(path.join(CSS_DIR, 'apply.css'), 'utf8');
  const m = css.match(/\.hp-field\s*\{[^}]*\}/);
  assert.ok(m, '.hp-field rule is gone from apply.css — the honeypot would render as a real field');
  assert.ok(/clip-path\s*:\s*inset\(50%\)/.test(m[0]) || /clip\s*:\s*rect/.test(m[0]),
    '.hp-field no longer uses the clip pattern to hide itself: ' + m[0].slice(0, 160));
});
