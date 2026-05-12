// tests/lint/no-hardcoded-html-lang.test.js
//
// Theme 10b T6 — guard against hardcoded <html lang="..."> attributes.
//
// Theme 10 (commit 82c663c) wired lang + dir through src/utils/lang.js
// and src/middleware.js so every layout renders the active locale's
// attributes (<%= lang %> / <%= dir %>). The pre-Theme-10 bug was
// index.ejs line 13's hardcoded lang="en" — patient_alerts and the
// /ar URL both rendered with the wrong attribute.
//
// Rule: 0 hardcoded `<html lang="en"` or `<html lang="ar"` literals in
// src/views/*.ejs. Use `<html lang="<%= lang %>" dir="<%= dir %>">`
// (the canonical pattern after Theme 10 §4.B).
//
// Exempt: ops-*.ejs surfaces — per Sub-issue E §4 ground rule
// ("ops surface is en-only by ground-rule decision"), these
// dashboards intentionally render in English regardless of user
// lang preference.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🌐 Theme 10b T6 — no hardcoded <html lang="..."> in src/views/\n');

const VIEWS_ROOT = path.join(__dirname, '..', '..', 'src', 'views');

// Allowlist: ops surfaces are en-only per Sub-issue E §4 ground rule.
const EXEMPT_BASENAMES = new Set([
  'ops-dashboard.ejs',
  'ops-error-detail.ejs',
  'ops-errors.ejs',
  'ops-login.ejs',
  'ops-silent-failures.ejs',
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ejs') && !entry.name.endsWith('.bak')) out.push(full);
  }
  return out;
}

// Look for `<html lang="en"` or `<html lang="ar"` (literal locales).
// The canonical pattern is `<html lang="<%= lang %>"...>` which never
// matches.
const HARDCODED_RE = /<html\b[^>]*\blang\s*=\s*["'](en|ar|en-[a-zA-Z-]+|ar-[a-zA-Z-]+)["']/g;

const violations = [];
let scanned = 0;

for (const file of walk(VIEWS_ROOT)) {
  if (EXEMPT_BASENAMES.has(path.basename(file))) continue;
  scanned++;
  const src = fs.readFileSync(file, 'utf8');
  HARDCODED_RE.lastIndex = 0;
  let m;
  while ((m = HARDCODED_RE.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    const rel = path.relative(path.join(__dirname, '..', '..'), file);
    violations.push(rel + ':' + line + ' — ' + m[0].slice(0, 80));
  }
}

try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' hardcoded <html lang="..."> literal(s):\n  ' +
      violations.join('\n  ') +
      '\n\nFix: replace with `<html lang="<%= lang %>" dir="<%= dir %>">`. See Theme 10 §4.B (commit 82c663c) for the canonical pattern.\n' +
      'If a static-export page (no EJS interpolation) intentionally hardcodes a locale, exempt it explicitly in this test.'
    );
  }
  t.pass(fileTag + ': 0 hardcoded <html lang="..."> literals in ' + scanned + ' .ejs files');
} catch (e) {
  t.fail(fileTag + ': hardcoded <html lang> regression', e);
}

// Sanity floor.
try {
  if (scanned < 30) {
    throw new Error('only scanned ' + scanned + ' .ejs files — expected ≥30. Lint may be silently passing on a path bug.');
  }
  t.pass(fileTag + ': scanned ' + scanned + ' .ejs files (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
