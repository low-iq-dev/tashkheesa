// tests/core/theme6-queueNotification-uses-toUserId.test.js
//
// Theme 6 sub-issue D regression guard — broader-scope lint.
//
// Sweeps every src/ file for `queueNotification(...)` call sites and
// asserts the field shape matches the canonical signature at
// notify.js:218-228:
//
//   queueNotification({ id, orderId, toUserId, channel, template,
//                       status, response, dedupe_key, dedupeKey })
//
// Three field-name typos are caught:
//
//   - `userId:` instead of `toUserId:` (silently drops at
//     notify.js:233 because normalizeToUserId(undefined) → null).
//   - `type:` instead of `channel:` (the value is silently
//     destructured into nothing; `channel` defaults to 'internal').
//   - `data:` instead of `response:` (payload is dropped).
//
// At Phase 4 commit time, the only sites with these typos were three
// calls in src/video_scheduler.js (Theme 6 sub-D, P3-WORKER-N2 and
// P3-WORKER-N6). This lint prevents a future drift back into the
// same shape — including from new files anywhere in src/.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📤 Theme 6 sub-D — every queueNotification call uses canonical field names\n');

const SRC = path.join(__dirname, '..', '..', 'src');

// Strip JS comments so audit-narrative comments quoting the OLD shape
// don't trigger false positives.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function findCallBodies(text, fnName) {
  const re = new RegExp('\\b' + fnName + '\\s*\\(\\s*\\{', 'g');
  const bodies = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 0;
    let close = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    bodies.push({ start: m.index, body: text.slice(m.index, close + 1) });
  }
  return bodies;
}

let files = [];
try {
  files = execSync(
    "find " + SRC + " -type f -name '*.js' " +
    "-not -path '*/node_modules/*' " +
    "-not -path '*/__tests__/*' " +
    "-not -path '*/test/*' " +
    "-not -path '*/tests/*'",
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);
} catch (e) {
  t.fail('discover source files', e);
}

// notify.js itself defines queueNotification — its signature line
// includes `toUserId,` as a destructured parameter. Don't lint
// the definition file's call body (the destructure pattern looks
// like a call to the regex).
const SKIP = new Set([
  path.join(SRC, 'notify.js'),
]);

const offenders = { userIdField: [], typeField: [], dataField: [], missingToUserId: [] };

for (const file of files) {
  if (SKIP.has(file)) continue;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  const code = stripComments(raw);
  const bodies = findCallBodies(code, 'queueNotification');
  for (const b of bodies) {
    const lineNo = code.slice(0, b.start).split('\n').length;
    const ref = file.replace(SRC + '/', 'src/') + ':' + lineNo;
    if (/\n\s*userId\s*:/.test(b.body)) offenders.userIdField.push(ref);
    if (/\n\s*type\s*:\s*['"]/.test(b.body)) offenders.typeField.push(ref);
    if (/\n\s*data\s*:/.test(b.body)) offenders.dataField.push(ref);
    if (!/\btoUserId\s*:/.test(b.body)) offenders.missingToUserId.push(ref);
  }
}

// Report each issue class as its own assertion.
function assertEmpty(name, list, hint) {
  try {
    if (list.length) {
      throw new Error(list.length + ' offender(s):\n  ' + list.join('\n  ') + '\n  → fix: ' + hint);
    }
    t.pass(name);
  } catch (e) { t.fail(name, e); }
}

assertEmpty(
  'no queueNotification call uses `userId:` (canonical is toUserId:)',
  offenders.userIdField,
  "rename `userId:` → `toUserId:` (silently drops at notify.js:233)"
);

assertEmpty(
  "no queueNotification call uses `type: '...'` (canonical is channel:)",
  offenders.typeField,
  "rename `type:` → `channel:` (queueNotification has no `type` parameter)"
);

assertEmpty(
  'no queueNotification call uses `data:` (canonical is response:)',
  offenders.dataField,
  "rename `data:` → `response: JSON.stringify(...)` (queueNotification has no `data` parameter)"
);

assertEmpty(
  'every queueNotification call carries a `toUserId:` field',
  offenders.missingToUserId,
  "add `toUserId:` (without it the call returns { ok:false, reason:'invalid_to_user_id' } — silent drop)"
);
