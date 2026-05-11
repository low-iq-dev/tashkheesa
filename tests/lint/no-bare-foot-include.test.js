// tests/lint/no-bare-foot-include.test.js
//
// Theme 2 Sub-issue C — CI lint that prevents the leaky-locals class.
//
// Failure mode this catches: a patient view includes
// `partials/patient/foot` or `partials/patient/head` without explicitly
// threading `cspNonce`. Today such views render because EJS's default
// `with: true` leaks `res.locals.cspNonce` into the include's scope. If
// `with: false` is ever flipped (EJS upgrade, render-path refactor, or a
// route that bypasses the CSP middleware), every bare include
// simultaneously loses its nonce attribute, CSP blocks the inline
// scripts in foot.ejs, and primary navigation (mobile More-tab drawer,
// notifications bell) dies silently across every affected view.
//
// The fix (commit e0f0183 for patient_new_case.ejs, Theme 2 Sub-issue C
// commit for the remaining views): every include block must contain a
// `cspNonce:` key. This test makes that the rule going forward.
//
// Rule: for every <%- include('partials/patient/foot', {...}) %> or
// <%- include('partials/patient/head', {...}) %> in any .ejs file under
// src/views/, the include's locals object MUST contain the substring
// `cspNonce:`.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔒 Theme 2 Sub-issue C — patient foot/head includes thread cspNonce\n');

const VIEWS_ROOT = path.join(__dirname, '..', '..', 'src', 'views');
const TARGETS = ['partials/patient/foot', 'partials/patient/head'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push.apply(out, walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

// Match `<%- include('partials/patient/<target>', { ... }) %>` (1-liner or
// multi-line). Captures the locals body between the first `{` and its
// matching `}` (we keep matching shallow because EJS include locals
// objects don't usually nest braces — and if they did, this regex would
// still capture *enough* to grep for `cspNonce:`).
function findIncludes(content, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    "<%-\\s*include\\(['\"]" + escaped + "['\"]\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)\\s*%>",
    'g'
  );
  const matches = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    // line number of this match (1-indexed)
    const upTo = content.slice(0, m.index);
    const line = upTo.split('\n').length;
    matches.push({ line, body: m[1] });
  }
  return matches;
}

const files = walk(VIEWS_ROOT);
const violations = [];
let scanned = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const target of TARGETS) {
    const includes = findIncludes(content, target);
    for (const inc of includes) {
      scanned++;
      if (!/\bcspNonce\s*:/.test(inc.body)) {
        const rel = path.relative(path.join(__dirname, '..', '..'), file);
        violations.push(rel + ':' + inc.line + ' includes ' + target + ' without explicit cspNonce thread');
      }
    }
  }
}

// ── Assertions ──
try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' include(s) without cspNonce thread:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: add `cspNonce: typeof cspNonce !== "undefined" ? cspNonce : ""` to the include locals.' +
      '\nSee commit e0f0183 for the canonical pattern.'
    );
  }
  t.pass(fileTag + ': all ' + scanned + ' patient/foot + patient/head includes thread cspNonce explicitly');
} catch (e) {
  t.fail(fileTag + ': bare foot/head include detected', e);
}

// Sanity: assert the test actually scanned something (catches an empty
// regex returning false-clean).
try {
  if (scanned < 10) {
    throw new Error('only scanned ' + scanned + ' includes — expected ≥10 from the patient view inventory. Test may be silently passing on a regex bug.');
  }
  t.pass(fileTag + ': scanned ' + scanned + ' patient/foot + patient/head include sites (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': scan-count sanity floor', e);
}
