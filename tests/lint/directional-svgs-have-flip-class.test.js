// tests/lint/directional-svgs-have-flip-class.test.js
//
// Theme 10b Sub-issue B / T2 — guard against directional SVGs added
// without the p-icon--flip class.
//
// Post-Phase-4 (commit 8feef60), every directional SVG (chevron,
// arrow, log-out icon) in src/views/ carries class="p-icon--flip" so
// the global rule `html[dir="rtl"] .p-icon--flip { transform:
// scaleX(-1); }` (portal-global.css) mirrors it under RTL. A new
// directional SVG added without the class would render LTR-only.
//
// Directional polyline patterns we recognise (each is a Lucide-style
// shape that points in a specific horizontal direction):
//   - "9 18 15 12 9 6"          — chevron-right
//   - "15 18 9 12 15 6"         — chevron-left
//   - "12 5 19 12 12 19"        — arrow-right
//   - "12 19 5 12 12 5"         — arrow-left
//   - "16 17 21 12 16 7"        — log-out (arrow exits door to right)
//   - "8 7 3 12 8 17"           — chevron-left (alt)
//
// NON-directional polylines we explicitly do NOT flag (they point
// vertically or have no direction):
//   - "12 6 12 12 16 14"        — clock-face
//   - "14 2 14 8 20 8"          — document-corner
//   - "20 6 9 17 4 12"          — checkmark (no obvious direction)
//   - "22 12 18 12 15 21 9 3 6 12 2 12" — activity/pulse line
//   - "7 10 12 15 17 10"        — chevron-down (vertical)
//   - "14 6 10 2 6 6"           — chevron-up (vertical)
//   - "17 8 12 3 7 8"           — chevron-up (vertical, alt)
//   - "10 9 9 9 8 9"            — dots (no direction)
//   - "12 2 12 7 17 7"          — bookmark
//   - "13 2 13 9 20 9"          — flag
//   - "21 15 16 10 5 21"        — image-mountain
//
// Rule: every <svg> tag containing one of the DIRECTIONAL polyline
// patterns must carry class="p-icon--flip" (anywhere in the class
// attribute).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔁 Theme 10b Sub-issue B — directional SVGs carry p-icon--flip\n');

const VIEWS_ROOT = path.join(__dirname, '..', '..', 'src', 'views');

const DIRECTIONAL_POLYLINES = [
  '9 18 15 12 9 6',
  '15 18 9 12 15 6',
  '12 5 19 12 12 19',
  '12 19 5 12 12 5',
  '16 17 21 12 16 7',
  '8 7 3 12 8 17'
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ejs') && !entry.name.endsWith('.bak')) out.push(full);
  }
  return out;
}

// Walk EJS-aware: skip <% ... %> blocks when scanning for <svg ... </svg>
// boundaries (avoids matching `>` inside EJS expressions as the closing
// of the SVG tag).
function findSvgs(src) {
  const svgs = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<%', i)) {
      const e = src.indexOf('%>', i);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    if (src.startsWith('<svg', i) && /[\s>]/.test(src[i + 4])) {
      // Find matching </svg>
      const close = src.indexOf('</svg>', i);
      if (close === -1) { i++; continue; }
      const blockStart = i;
      const blockEnd = close + '</svg>'.length;
      // line number
      const line = src.slice(0, i).split('\n').length;
      svgs.push({ start: blockStart, end: blockEnd, line: line, body: src.slice(blockStart, blockEnd) });
      i = blockEnd;
      continue;
    }
    i++;
  }
  return svgs;
}

let scannedFiles = 0;
let directionalSvgsScanned = 0;
const violations = [];

for (const file of walk(VIEWS_ROOT)) {
  scannedFiles++;
  const src = fs.readFileSync(file, 'utf8');
  if (!DIRECTIONAL_POLYLINES.some(p => src.indexOf('points="' + p + '"') !== -1)) continue;
  for (const svg of findSvgs(src)) {
    const containsDirectional = DIRECTIONAL_POLYLINES.some(p =>
      svg.body.indexOf('points="' + p + '"') !== -1
    );
    if (!containsDirectional) continue;
    directionalSvgsScanned++;
    // Extract the opening tag class attribute (or absence of it).
    const openTagMatch = svg.body.match(/^<svg\b[^>]*>/);
    const openTag = openTagMatch ? openTagMatch[0] : '';
    const classMatch = openTag.match(/class="([^"]*)"/);
    const classes = classMatch ? classMatch[1] : '';
    if (!/\bp-icon--flip\b/.test(classes)) {
      const rel = path.relative(path.join(__dirname, '..', '..'), file);
      violations.push(rel + ':' + svg.line + ' — directional SVG without p-icon--flip class');
    }
  }
}

try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' directional SVG(s) without p-icon--flip class:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: add class="p-icon--flip" to the <svg> tag. See commit 8feef60 (Theme 10b Sub-issue B) for the canonical pattern.' +
      '\nIf the SVG is intentionally non-mirrored under RTL (e.g. a brand logo with directional intent), exempt by tagging the polyline pattern as non-directional in this test\'s NON-DIRECTIONAL list above.'
    );
  }
  t.pass(fileTag + ': all ' + directionalSvgsScanned + ' directional SVG(s) carry p-icon--flip (scanned ' + scannedFiles + ' .ejs files)');
} catch (e) {
  t.fail(fileTag + ': directional SVG missing p-icon--flip', e);
}

// Sanity floor — make sure we actually scanned something.
try {
  if (directionalSvgsScanned < 6) {
    throw new Error('only scanned ' + directionalSvgsScanned + ' directional SVGs — expected ≥6 (3 admin_analytics chevrons + 2 doctor_prescriptions_list + 1 portal_doctor_case at minimum). Lint may be silently passing on a regex bug.');
  }
  t.pass(fileTag + ': scanned ' + directionalSvgsScanned + ' directional SVG site(s) (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
