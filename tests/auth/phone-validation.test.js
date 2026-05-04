// tests/auth/phone-validation.test.js
//
// P0-FORM-1: validatePhoneE164 unit tests + signup-path integration
// (source-grep) tests that confirm every patient-creating route uses
// the shared validator.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const assert = require('assert');
const fs = require('fs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📞 P0-FORM-1 phone validation\n');

const { validatePhoneE164, E164_RE } = require('../../src/validators/phone');

// ── 1. Valid E.164 inputs ──────────────────────────────────────────
[
  ['+201012345678', '+201012345678'],     // EG mobile
  ['+447911123456', '+447911123456'],     // UK mobile
  ['+13105551234',  '+13105551234'],      // US
  ['+971501234567', '+971501234567'],     // AE
  ['+966501234567', '+966501234567'],     // SA
  ['+20 100 123 4567', '+201001234567'],  // EG with spaces
  ['+20-100-123-4567', '+201001234567'],  // EG with dashes
  ['+20 (100) 123-4567', '+201001234567'],// EG with parens
  ['201012345678', '+201012345678'],      // missing +, accepted (>= 8 digits)
].forEach(function ([input, expected]) {
  try {
    var r = validatePhoneE164(input, 'en');
    assert.strictEqual(r.ok, true, 'expected ok=true for ' + JSON.stringify(input) + ' got ' + JSON.stringify(r));
    assert.strictEqual(r.normalized, expected, 'normalize mismatch for ' + JSON.stringify(input));
    t.pass('valid: ' + input + ' → ' + expected);
  } catch (e) { t.fail('valid: ' + input, e); }
});

// ── 2. Invalid inputs ──────────────────────────────────────────────
[
  ['',             'required'],
  [null,           'required'],
  [undefined,      'required'],
  ['   ',          'required'],
  ['+2010',        'too_short'],          // truncation case from production
  ['12345',        'too_short'],
  ['+',            'invalid'],            // plus only (no digits)
  ['+0123456789',  'invalid'],            // leading 0 after + (E.164 country digit must be 1-9)
  ['+'+'9'.repeat(16), 'too_long'],       // 16 digits
  ['abc',          'invalid'],
].forEach(function ([input, expectedKind]) {
  try {
    var r = validatePhoneE164(input, 'en');
    assert.strictEqual(r.ok, false, 'expected ok=false for ' + JSON.stringify(input) + ' got ' + JSON.stringify(r));
    assert.ok(r.error && typeof r.error === 'string' && r.error.length > 0, 'error string present');
    t.pass('invalid: ' + JSON.stringify(input) + ' rejected (' + expectedKind + ')');
  } catch (e) { t.fail('invalid: ' + JSON.stringify(input), e); }
});

// ── 3. Localization ────────────────────────────────────────────────
try {
  var rEn = validatePhoneE164('', 'en');
  var rAr = validatePhoneE164('', 'ar');
  assert.ok(/required/i.test(rEn.error), 'EN error mentions required');
  assert.ok(/مطلوب/.test(rAr.error), 'AR error includes Arabic');
  assert.notStrictEqual(rEn.error, rAr.error, 'EN/AR errors differ');
  t.pass('localization: EN + AR error messages distinct');
} catch (e) { t.fail('localization', e); }

// ── 4. Regex export sanity ─────────────────────────────────────────
try {
  assert.ok(E164_RE.test('+201012345678'), 'regex matches valid E.164');
  assert.ok(!E164_RE.test('+2010'),         'regex rejects truncated');
  assert.ok(!E164_RE.test('201012345678'),  'regex requires leading +');
  t.pass('E164_RE exported and matches spec');
} catch (e) { t.fail('regex export', e); }

// ── 5. Source-grep: every signup path uses the shared validator ───
try {
  var sites = [
    ['src/routes/auth.js',           "POST /register (web)"],
    ['src/routes/api/auth.js',       "POST /api/v1/auth/register + /otp/verify (mobile)"],
    ['src/routes/onboarding.js',     "POST /portal/patient/onboarding/profile"],
    ['src/validators/doctor_signup.js', "doctor signup validator"],
    ['src/routes/patient.js',        "POST /patient/profile"]
  ];
  sites.forEach(function (pair) {
    var src = fs.readFileSync(require.resolve('../../' + pair[0]), 'utf8');
    assert.ok(/validatePhoneE164/.test(src),
      pair[0] + ' references validatePhoneE164 (' + pair[1] + ')');
  });
  t.pass('source-grep: all 5 signup-path files reference validatePhoneE164');
} catch (e) { t.fail('source-grep validator wiring', e); }

// ── 6. Source-grep: web register form has required attr ───────────
try {
  var src = fs.readFileSync(require.resolve('../../src/views/register.ejs'), 'utf8');
  // The phone input tag spans multiple "logical" >'s because EJS <%= %>
  // contains a > character. Walk char-by-char from `name="phone"` looking
  // for the closing /> or > that is NOT inside %>.
  var nameIdx = src.indexOf('name="phone"');
  assert.ok(nameIdx > -1, 'name="phone" present');
  // Find the start of the input tag (search backwards for "<input")
  var tagStart = src.lastIndexOf('<input', nameIdx);
  assert.ok(tagStart > -1, '<input tag start found');
  // Walk forward to find the tag's closing > (skipping any %> inside EJS)
  var i = tagStart;
  while (i < src.length) {
    if (src[i] === '%' && src[i + 1] === '>') { i += 2; continue; }
    if (src[i] === '>') break;
    i++;
  }
  var inputTag = src.substring(tagStart, i + 1);
  assert.ok(/\brequired\b/.test(inputTag),
    'phone input has required attr — got: ' + inputTag.replace(/\s+/g, ' '));
  // The "optional" label string should be GONE.
  assert.ok(!/WhatsApp Number \(optional\)/.test(src),
    'EN label no longer says "WhatsApp Number (optional)"');
  t.pass('register.ejs: phone is required + label updated');
} catch (e) { t.fail('register.ejs check', e); }

// ── 7. OTP-verify uses normalizedPhone (not bare phone) — bug fix ──
try {
  var src = fs.readFileSync(require.resolve('../../src/routes/api/auth.js'), 'utf8');
  // Locate the route handler block. Find the literal route reg line, take
  // the next ~3000 chars as "the OTP-verify region" (handler is < 100 lines).
  var routeIdx = src.indexOf("'/otp/verify'");
  assert.ok(routeIdx > -1, "'/otp/verify' route registered");
  var otpRegion = src.substring(routeIdx, Math.min(routeIdx + 3000, src.length));
  assert.ok(/normalizedPhone/.test(otpRegion),
    'OTP-verify region references normalizedPhone (post-validator)');
  // Strip line comments — the buggy pattern shouldn't survive in code.
  var nonComment = otpRegion.split('\n').filter(function (l) {
    return !/^\s*\/\//.test(l);
  }).join('\n');
  var insertMatch = nonComment.match(/INSERT INTO users[\s\S]*?\[([^\]]+)\]/);
  assert.ok(insertMatch, 'INSERT INTO users statement found in OTP region');
  assert.ok(/normalizedPhone/.test(insertMatch[1]),
    'OTP-verify INSERT INTO users uses normalizedPhone — got: ' + insertMatch[1]);
  // The lookup SELECT FROM users WHERE phone = $1 must also use normalizedPhone.
  var lookupMatch = nonComment.match(/SELECT \* FROM users WHERE phone = \$1[\s\S]*?\[([^\]]+)\]/);
  assert.ok(lookupMatch, 'lookup SELECT found');
  assert.ok(/normalizedPhone/.test(lookupMatch[1]),
    'OTP-verify lookup uses normalizedPhone — got: ' + lookupMatch[1]);
  t.pass('OTP-verify: normalizedPhone wired through lookup + INSERT (bug fix)');
} catch (e) { t.fail('OTP-verify normalizedPhone wiring', e); }
