// tests/lint/ltr-input-fields.test.js
//
// Theme 10b Sub-issue D / T4 — guard against LTR-leaning inputs added
// without dir="ltr".
//
// LTR-leaning input types (tel, email, url, number, date, time,
// datetime-local) carry LTR content even when the UI is dir=rtl —
// phone numbers "+201234567890" and emails "user@example.com" are
// LTR-by-design. Phase 3 (commit e93924b) added dir="ltr" to all 56
// such inputs across 33 views and added a safety-net CSS rule in
// public/css/portal-global.css.
//
// Per OQ-4 (approved), we ship BOTH layers of defence. This test
// enforces the per-input attribute even on views that load
// portal-global.css — neither layer should rot.
//
// Rule: every <input> with type in {tel, email, url, number, date,
// time, datetime-local} in src/views/*.ejs must carry dir="ltr".

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🧭 Theme 10b Sub-issue D — LTR-leaning <input> elements carry dir="ltr"\n');

const VIEWS_ROOT = path.join(__dirname, '..', '..', 'src', 'views');
const LTR_TYPES = ['tel', 'email', 'url', 'number', 'date', 'time', 'datetime-local'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ejs') && !entry.name.endsWith('.bak')) out.push(full);
  }
  return out;
}

// EJS-aware walk: tracks <% %> blocks so '>' inside them doesn't
// prematurely terminate the input-tag scan. Same parser shape as the
// Phase 3 transformer.
function findInputs(src) {
  const inputs = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<%', i)) {
      const e = src.indexOf('%>', i);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    if (src.startsWith('<input', i) && /[\s>]/.test(src[i + 6])) {
      let j = i + 6;
      while (j < src.length) {
        if (src.startsWith('<%', j)) {
          const e = src.indexOf('%>', j);
          j = e === -1 ? src.length : e + 2;
          continue;
        }
        if (src[j] === '>') break;
        j++;
      }
      const tag = src.slice(i, j + 1);
      const line = src.slice(0, i).split('\n').length;
      inputs.push({ tag, line });
      i = j + 1;
      continue;
    }
    i++;
  }
  return inputs;
}

const violations = [];
let scannedLtrInputs = 0;

for (const file of walk(VIEWS_ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const inp of findInputs(src)) {
    const typeMatch = inp.tag.match(/type="([^"]+)"/);
    if (!typeMatch || !LTR_TYPES.includes(typeMatch[1])) continue;
    scannedLtrInputs++;
    if (!/\bdir="ltr"/.test(inp.tag)) {
      const rel = path.relative(path.join(__dirname, '..', '..'), file);
      violations.push(rel + ':' + inp.line + ' — type="' + typeMatch[1] + '" missing dir="ltr"');
    }
  }
}

try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' LTR-leaning <input> without dir="ltr":\n  ' +
      violations.join('\n  ') +
      '\n\nFix: add dir="ltr" to the <input> tag. The safety-net CSS rule in public/css/portal-global.css covers anything missed at runtime, but the per-input attr is self-documenting and survives selector regressions. See commit e93924b (Theme 10b Sub-issue D / OQ-4) for the canonical pattern.'
    );
  }
  t.pass(fileTag + ': all ' + scannedLtrInputs + ' LTR-leaning <input> elements carry dir="ltr"');
} catch (e) {
  t.fail(fileTag + ': LTR <input> missing dir="ltr"', e);
}

// Sanity floor.
try {
  if (scannedLtrInputs < 50) {
    throw new Error('only scanned ' + scannedLtrInputs + ' LTR-leaning inputs — expected ≥50 across the form surface. Lint may be silently passing on a parser bug.');
  }
  t.pass(fileTag + ': scanned ' + scannedLtrInputs + ' LTR-leaning <input> sites (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}

// Safety-net CSS rule must also be present (OQ-4 ships both layers of defence).
try {
  const globalCss = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'portal-global.css'), 'utf8');
  if (!/input\[type="tel"\][\s\S]{0,400}direction:\s*ltr/.test(globalCss)) {
    throw new Error('public/css/portal-global.css is missing the LTR-input safety-net CSS rule (Phase 3 / commit e93924b). OQ-4 requires both per-input attr AND CSS rule.');
  }
  t.pass(fileTag + ': portal-global.css contains the LTR-input safety-net CSS rule');
} catch (e) {
  t.fail(fileTag + ': safety-net CSS rule missing', e);
}
