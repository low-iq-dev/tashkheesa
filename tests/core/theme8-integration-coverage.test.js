// tests/core/theme8-integration-coverage.test.js
//
// Theme 8 Phase 6 regression guard — third-party integration error paths
// must write to error_logs (or _logEmailError → email_send category)
// AND must not log raw secrets (OTP codes, tokens, API keys, passwords).
//
// Files audited:
//   src/services/emailService.js   (sendMail lifecycle path)
//   src/services/twilio_verify.js  (OTP send + verify check)
//   src/services/whatsapp_otp.js   (unexpected WA OTP send failure)
//   src/storage.js                 (R2 bucket HeadBucket boot check)
//
// Assertions:
//   1. Each file has at least 1 logErrorToDb / _logEmailError call.
//   2. The 4 Phase 6 categories are present:
//        email_send (already existed via _logEmailError),
//        twilio_verify_otp, whatsapp_otp, r2_bucket.
//   3. Every console.error in those 4 files is paired (radius 500)
//      with either logErrorToDb or _logEmailError.
//   4. PII safety: no logErrorToDb / _logEmailError call site has the
//      raw `code` / `otp` / `token` / `secret` / `password` /
//      `api_key` variable name in its context object (lint catches
//      future regressions where someone forgets to mask).

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔌 Theme 8 Phase 6 — third-party integration error coverage\n');

const SRC = path.join(__dirname, '..', '..', 'src');
const FILES = [
  { path: path.join(SRC, 'services', 'emailService.js'),  rel: 'src/services/emailService.js',  category: 'email_send' },
  { path: path.join(SRC, 'services', 'twilio_verify.js'), rel: 'src/services/twilio_verify.js', category: 'twilio_verify_otp' },
  { path: path.join(SRC, 'services', 'whatsapp_otp.js'),  rel: 'src/services/whatsapp_otp.js',  category: 'whatsapp_otp' },
  { path: path.join(SRC, 'storage.js'),                   rel: 'src/storage.js',                category: 'r2_bucket' },
];

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }
function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

const RADIUS = 500;

// ── Assertion 1 + 2: each file routes errors via logErrorToDb/_logEmailError
//    AND declares the expected category. ────────────────────────────────
for (const f of FILES) {
  const src = read(f.path);
  // emailService uses the existing _logEmailError helper (which writes
  // category='email_send' directly to error_logs).
  const writesToDb = /\blogErrorToDb\s*\(/.test(src) || /_logEmailError\s*\(/.test(src);
  assert(writesToDb,
    f.rel + ' routes errors via logErrorToDb or _logEmailError',
    'no logErrorToDb / _logEmailError call found in ' + f.rel);
  // Category presence: category=<value> as a quoted string literal.
  const catRe = new RegExp("['\"]" + f.category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]");
  assert(catRe.test(src),
    f.rel + " mentions category='" + f.category + "'",
    'category literal not found in source');
}

// ── Assertion 3: every console.error in the 4 files is paired (radius 500)
//    with logErrorToDb or _logEmailError. Phase 6 brief: no sentinel
//    allowance for these integration sites — every console.error MUST
//    be backed by a DB write. ───────────────────────────────────────────
const offenders = [];
for (const f of FILES) {
  const src = read(f.path);
  const re = /\bconsole\.error\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = Math.max(0, m.index - RADIUS);
    const end = Math.min(src.length, m.index + RADIUS);
    const slice = src.slice(start, end);
    const paired = slice.indexOf('logErrorToDb(') !== -1 || slice.indexOf('_logEmailError(') !== -1;
    if (!paired) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      offenders.push({ file: f.rel, line: lineNo });
    }
  }
}
try {
  if (offenders.length) {
    const detail = offenders.map(function (o) { return '    ' + o.file + ':' + o.line; }).join('\n');
    throw new Error(offenders.length + ' unpaired console.error site(s):\n' + detail);
  }
  t.pass(fileTag + ': every console.error in the 4 integration files is paired with logErrorToDb/_logEmailError');
} catch (e) { t.fail(fileTag + ': every console.error in the 4 integration files is paired', e); }

// ── Assertion 4: PII safety — no raw OTP/token/secret/password variable
//    appears as a key in logErrorToDb/_logEmailError context. Walk each
//    call's argument body and look for forbidden bare identifiers used
//    as object-literal SHORTHAND or as the RHS of a key:value pair. ────
//
// Forbidden keys (lowercased exact match): otp, code, token, secret,
// password, api_key, apikey. We allow them to APPEAR in surrounding
// text (e.g. comments explaining why they're NOT logged) — only the
// inside of the context-object argument is checked.
const FORBIDDEN_KEYS = ['otp', 'code', 'token', 'secret', 'password', 'api_key', 'apikey'];

function findCalls(src, fnName) {
  const re = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
  const calls = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const argStart = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"' || ch === "'") {
        const q = ch; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      } else if (ch === '`') {
        i++;
        while (i < src.length && src[i] !== '`') { if (src[i] === '\\') i++; i++; }
      }
      i++;
    }
    calls.push({ args: src.slice(argStart, i - 1), line: src.slice(0, m.index).split('\n').length });
  }
  return calls;
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const piiOffenders = [];
for (const f of FILES) {
  const src = read(f.path);
  const calls = findCalls(src, 'logErrorToDb').concat(findCalls(src, '_logEmailError'));
  for (const c of calls) {
    const argsStripped = stripComments(c.args);
    for (const key of FORBIDDEN_KEYS) {
      // Match either object-literal SHORTHAND `{ otp, ... }` / `{ otp }` or
      // key:value `otp: foo`. We require the key to appear as an identifier
      // boundary on the LEFT side of `:` or immediately followed by `,` or
      // `}` (shorthand). Strings like `'no_phone_for_user'` won't match
      // because the surrounding quotes break the identifier boundary.
      const shorthand = new RegExp('[{,\\s]' + key + '\\s*[,}]');
      const keyValue = new RegExp('[{,\\s]' + key + '\\s*:');
      if (shorthand.test(argsStripped) || keyValue.test(argsStripped)) {
        piiOffenders.push({ file: f.rel, line: c.line, key: key });
      }
    }
  }
}
try {
  if (piiOffenders.length) {
    const detail = piiOffenders.map(function (o) {
      return "    " + o.file + ":" + o.line + " — context contains forbidden key '" + o.key + "'";
    }).join('\n');
    throw new Error(piiOffenders.length + " PII offender(s):\n" + detail +
      "\n    → fix: mask the value (e.g. last 4 chars) or omit. Never log raw OTP/token/secret/password.");
  }
  t.pass(fileTag + ': no logErrorToDb/_logEmailError site contains raw OTP/token/secret/password keys');
} catch (e) { t.fail(fileTag + ': no PII-bearing keys in error_logs context', e); }
