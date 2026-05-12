// tests/lint/no-physical-margin-padding-in-css.test.js
//
// Theme 10b Sub-issue A / T1 — guard against physical margin/padding-l/r
// regressions in production CSS.
//
// Post-Phase-5 (commit 7d9de1c), the count of physical
// margin-left/right + padding-left/right decls in public/css/*.css
// outside [dir="rtl"] blocks is 0. Logicalised counterparts
// (margin-inline-start/end, padding-inline-start/end) handle both
// directions natively. New physical decls would re-introduce the
// RTL-fragility class.
//
// Exempt files:
//   - responsive.css   — mobile media-query overrides may legitimately
//                        be physical (audit §6 T1 exemption)
//   - annotator.css    — third-party-adjacent surface (audit exemption)
//   - *.bak            — backup snapshots
//
// Rule: 0 physical margin-l/r + padding-l/r decls outside [dir=rtl]
// blocks in production CSS (excluding exempt files above).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📐 Theme 10b Sub-issue A — no physical margin/padding-l/r in production CSS\n');

const CSS_ROOT = path.join(__dirname, '..', '..', 'public', 'css');
const EXEMPT = new Set(['responsive.css', 'annotator.css']);

// Strip [dir="rtl"] ... {} blocks (single-level brace match — CSS
// doesn't nest selectors, so this is safe).
function stripRtlBlocks(src) {
  return src.replace(
    /\[dir\s*=\s*["']rtl["']\][^{]*\{[\s\S]*?\}/g,
    ''
  );
}

const physicalRe = /\b(margin-left|margin-right|padding-left|padding-right)\b/g;

let scanned = 0;
const violations = [];

for (const name of fs.readdirSync(CSS_ROOT)) {
  if (!name.endsWith('.css')) continue;
  if (name.endsWith('.bak')) continue;
  if (EXEMPT.has(name)) continue;
  scanned++;
  const src = fs.readFileSync(path.join(CSS_ROOT, name), 'utf8');
  const stripped = stripRtlBlocks(src);
  // Locate each match against the *original* file so the line number
  // is meaningful.
  const matches = src.match(physicalRe) || [];
  if (matches.length === 0) continue;
  // For each match, check if it's inside an [dir=rtl] block by
  // comparing the stripped count.
  const strippedCount = (stripped.match(physicalRe) || []).length;
  if (strippedCount > 0) {
    // Walk the original to find line numbers of the violations.
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (physicalRe.test(lines[i])) {
        physicalRe.lastIndex = 0;
        // Check if this line is inside an [dir=rtl] block by checking
        // its position relative to skip-regions.
        const upTo = lines.slice(0, i + 1).join('\n');
        const stripUpTo = stripRtlBlocks(upTo);
        if (physicalRe.test(stripUpTo)) {
          physicalRe.lastIndex = 0;
          violations.push('public/css/' + name + ':' + (i + 1) + ' — ' + lines[i].trim());
        }
        physicalRe.lastIndex = 0;
      }
    }
  }
}

try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' physical margin/padding-l/r decl(s) outside [dir=rtl] blocks:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: replace margin-left → margin-inline-start, etc. See commit 7d9de1c (Theme 10b Sub-issue A) for the canonical sweep.' +
      '\nException: if the decl is genuinely direction-specific (e.g. the styles.css marketing-nav region), keep physical and wrap in an [dir="rtl"] override per OQ-1.'
    );
  }
  t.pass(fileTag + ': 0 physical margin/padding-l/r decls outside [dir=rtl] in production CSS (scanned ' + scanned + ' files, excluding ' + Array.from(EXEMPT).join(' + ') + ')');
} catch (e) {
  t.fail(fileTag + ': physical margin/padding-l/r regression', e);
}

// Sanity floor — make sure we actually scanned files.
try {
  if (scanned < 8) {
    throw new Error('only scanned ' + scanned + ' CSS files — expected ≥8 in public/css/. Lint may be silently passing on a path bug.');
  }
  t.pass(fileTag + ': scanned ' + scanned + ' CSS files (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
