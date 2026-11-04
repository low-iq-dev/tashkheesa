// tests/auth/otp-phone-guard.test.js
//
// Part D (patient recovery, 2 Nov 2026) — a phone is validated BEFORE any
// Twilio call, so an OTP send is never spent on a number that cannot get one.
// validators/otp_phone_guard.js holds the rule; this file pins:
//   A. the rule on the inputs that reached Twilio (16 Oct, 28 Oct, 11 Oct,
//      25 Sep), valid 010/011/012/015 numbers with and without the trunk zero,
//      a UK, a UAE and a Saudi number, a 9-digit stub;
//   B. the log line carries the shape, never the number;
//   C. the REAL patient-app and doctor-app routers: an unsendable number is a
//      422 PHONE_INVALID and Twilio is never called; a good one is sent as
//      E.164; the store-review number still never gets an SMS;
//   D. wiring: the web door refuses before the per-phone limiters, and the
//      delete-account sends are gated.
// No database: the routers get in-memory helpers, as in
// tests/auth/batch-c-sessions-and-doctor-door.test.js.

'use strict';

// The API routers load requireJWT, which refuses to start without a secret.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'otp-phone-guard-test-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Capture the error_logs writes instead of touching a database.
const logger = require('../../src/logger');
const logged = [];
logger.logErrorToDb = async function (err, ctx) { logged.push({ message: err && err.message, ctx }); return 'x'; };

const { checkOtpPhone, refuseUnsendableApiOtpPhone } = require('../../src/validators/otp_phone_guard');

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── in-memory helpers for the routers ────────────────────────────────────
const otps = [];
async function fakeQuery(sql) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (q.startsWith('INSERT INTO otp_codes')) return { rowCount: 1, rows: [] };
  throw new Error('fakeQuery: unexpected SQL: ' + q.slice(0, 120));
}
const sends = [];
const helpers = {
  safeGet: async (s, p) => { const r = await fakeQuery(s, p); return Array.isArray(r) ? r[0] || null : null; },
  safeAll: async (s, p) => { const r = await fakeQuery(s, p); return Array.isArray(r) ? r : []; },
  safeRun: async (s, p) => fakeQuery(s, p),
  sendOtpViaTwilio: async (phone) => { sends.push(phone); return { ok: true, status: 'pending' }; },
};

console.log('\n📵  OTP phone guard (Part D)\n');

(async () => {
  // ════ A. the rule ════
  await check('A1: the 16 Oct input (+20 + 10000000930129, 16 digits) is refused', () => {
    const r = checkOtpPhone('10000000930129', '+20', 'en');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(checkOtpPhone('010000000930129', '+20', 'en').ok, false, 'with the trunk zero');
    assert.strictEqual(checkOtpPhone('+2010000000930129', null, 'en').ok, false, 'as the E.164 string Twilio got');
  });

  await check('A2: the 28 Oct input (+20 + 1550000000930129, 18 digits) is refused', () => {
    assert.strictEqual(checkOtpPhone('1550000000930129', '+20', 'en').ok, false);
    assert.strictEqual(checkOtpPhone('+201550000000930129', null, 'en').ok, false);
  });

  await check('A3: E.164-shaped +20 numbers that are not Egyptian mobiles are refused (11 Oct, 25 Sep)', () => {
    const a = checkOtpPhone('1990000177', '+20', 'en');
    assert.strictEqual(a.ok, false); assert.strictEqual(a.reason, 'eg_mobile_shape');
    const b = checkOtpPhone('+206504992804', null, 'en');
    assert.strictEqual(b.ok, false); assert.strictEqual(b.reason, 'eg_mobile_shape');
  });

  await check('A4: 010/011/012/015, with and without the trunk zero, all pass as +201…', () => {
    for (const lead of ['10', '11', '12', '15']) {
      const national = lead + '12345678';
      for (const typed of [national, '0' + national]) {
        const r = checkOtpPhone(typed, '+20', 'en');
        assert.ok(r.ok, typed + ': ' + JSON.stringify(r));
        assert.strictEqual(r.normalized, '+20' + national);
      }
      assert.ok(checkOtpPhone('0' + national, 'EG', 'en').ok, 'ISO hint');
    }
  });

  await check('A5: the trunk-zero repair is exactly as before (0100… with +20 → +20100…)', () => {
    const { normalizePhone } = require('../../src/validators/phone_identity');
    const before = normalizePhone('01003225382', '+20', 'en');
    const after = checkOtpPhone('01003225382', '+20', 'en');
    assert.deepStrictEqual(after, before);
    assert.strictEqual(after.normalized, '+201003225382');
  });

  await check('A6: a UK, a UAE and a Saudi number pass on E.164 shape alone', () => {
    assert.strictEqual(checkOtpPhone('07911123456', 'GB', 'en').normalized, '+447911123456');
    assert.strictEqual(checkOtpPhone('501234567', 'AE', 'en').normalized, '+971501234567');
    assert.strictEqual(checkOtpPhone('0501234567', 'SA', 'en').normalized, '+966501234567');
    assert.ok(checkOtpPhone('+971501234567', null, 'en').ok, 'already international');
  });

  await check('A7: a 9-digit stub on +20 is refused', () => {
    const r = checkOtpPhone('101234567', '+20', 'en');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'eg_mobile_shape');
  });

  await check('A8: the field error is bilingual', () => {
    const en = checkOtpPhone('1990000177', '+20', 'en');
    const ar = checkOtpPhone('1990000177', '+20', 'ar');
    assert.ok(/Egyptian mobile/.test(en.error), en.error);
    assert.ok(/موبايل مصري/.test(ar.error), ar.error);
    assert.ok(/[؀-ۿ]/.test(checkOtpPhone('123', '+20', 'ar').error), 'the E.164 messages are Arabic too');
  });

  // ════ B. the log carries the shape only ════
  await check('B1: a refused number is logged at warn with its shape — and never the number', () => {
    logged.length = 0;
    const mw = refuseUnsendableApiOtpPhone('app_patient');
    let failed = null;
    const req = { body: { phone: '1550000000930129', countryCode: '+20' }, get: () => '' };
    const res = { fail: (msg, status, code) => { failed = { msg, status, code }; return res; } };
    mw(req, res, () => { throw new Error('next() must not run'); });
    assert.deepStrictEqual(failed && [failed.status, failed.code], [422, 'PHONE_INVALID']);
    assert.strictEqual(logged.length, 1);
    const entry = logged[0];
    assert.strictEqual(entry.ctx.level, 'warn');
    assert.strictEqual(entry.ctx.category, 'otp_phone_rejected');
    const text = JSON.stringify(entry);
    assert.ok(!/1550000000930129|930129/.test(text), 'the number leaked into the log: ' + text);
    assert.strictEqual(entry.ctx.shape.typed_digits, 16);
  });

  await check('B2: middleware lets an empty field through to the route\'s own validator, and exempts the review number', () => {
    const mw = refuseUnsendableApiOtpPhone('app_doctor', (p) => p === '9999');
    let nexts = 0;
    const res = { fail: () => { throw new Error('must not fail'); } };
    mw({ body: { phone: '', countryCode: '+20' }, get: () => '' }, res, () => { nexts++; });
    mw({ body: { phone: '9999', countryCode: '+20' }, get: () => '' }, res, () => { nexts++; });
    const req = { body: { phone: '01012345678', countryCode: '+20' }, get: () => '' };
    mw(req, res, () => { nexts++; });
    assert.strictEqual(nexts, 3);
    assert.strictEqual(req.otpSendPhone, '+201012345678');
  });

  // ════ C. the real routers ════
  const apiResponse = require('../../src/middleware/apiResponse');
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/auth', require('../../src/routes/api/auth')({}, helpers));
  app.use('/doctor/auth', require('../../src/routes/api/doctor_auth')({}, helpers));
  app.use((err, req, res, _next) => res.fail(err.message || 'boom', 500, 'TEST_UNCAUGHT'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Each case uses its own number: the per-phone limiters are shared module
  // state and must not carry one case into the next.
  async function post(p, body, headers) {
    const res = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body: json };
  }

  try {
    await check('C1: doctor door — the 16 Oct input is a 422 PHONE_INVALID and Twilio is never called', async () => {
      sends.length = 0;
      const r = await post('/doctor/auth/otp/request', { phone: '10000000930129', countryCode: '+20' });
      assert.strictEqual(r.status, 422, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'PHONE_INVALID');
      assert.strictEqual(sends.length, 0);
    });

    await check('C2: doctor door — the 28 Oct input likewise', async () => {
      sends.length = 0;
      const r = await post('/doctor/auth/otp/request', { phone: '1550000000930129', countryCode: '+20' });
      assert.strictEqual(r.status, 422);
      assert.strictEqual(sends.length, 0);
    });

    await check('C3: doctor door — a good number is sent as E.164, trunk zero or not', async () => {
      sends.length = 0;
      const a = await post('/doctor/auth/otp/request', { phone: '1007801201', countryCode: '+20' });
      const b = await post('/doctor/auth/otp/request', { phone: '01007801202', countryCode: '+20' });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
      assert.strictEqual(b.status, 200, JSON.stringify(b.body));
      assert.deepStrictEqual(sends, ['+201007801201', '+201007801202']);
    });

    await check('C4: patient-app door — an E.164-shaped non-mobile is refused before Twilio, in Arabic when asked', async () => {
      sends.length = 0;
      const r = await post('/auth/otp/request', { phone: '1990000177', countryCode: '+20' }, { 'Accept-Language': 'ar' });
      assert.strictEqual(r.status, 422);
      assert.strictEqual(r.body.code, 'PHONE_INVALID');
      assert.ok(/موبايل مصري/.test(r.body.error), r.body.error);
      assert.strictEqual(sends.length, 0);
    });

    await check('C5: patient-app door — a good number still goes out', async () => {
      sends.length = 0;
      const r = await post('/auth/otp/request', { phone: '01112345601', countryCode: '+20' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(sends, ['+201112345601']);
    });

    await check('C6: an empty field keeps its old VALIDATION_ERROR answer on both doors', async () => {
      // Different dial codes: an empty phone keys the shared per-phone limiter
      // on the dial code alone, so a second '+20' would meet the cooldown.
      const a = await post('/auth/otp/request', { phone: '', countryCode: '+20' });
      const b = await post('/doctor/auth/otp/request', { phone: '', countryCode: '+44' });
      assert.strictEqual(a.body.code, 'VALIDATION_ERROR');
      assert.strictEqual(b.body.code, 'VALIDATION_ERROR');
    });
  } finally {
    server.close();
  }

  // ════ D. wiring ════
  await check('D1: the web door refuses after the per-IP limiter and before the per-phone limiters', () => {
    const src = read('src/routes/auth.js');
    assert.ok(/router\.post\('\/login\/otp\/request', parseOtpPhone, otpIpLimiter, refuseUnsendableOtpPhone, otpSendCooldown, otpSendCap,/.test(src));
    assert.ok(/res\.status\(422\)\.json\(\{ ok: false, error: 'phone_invalid', message: chk\.error \}\)/.test(src));
    const js = read('public/js/login-phone.js');
    assert.ok(/r\.status === 422/.test(js), 'the login page shows the field error');
  });

  await check('D2: both app doors mount the guard ahead of otpPhoneScope; the doctor door exempts the review number', () => {
    assert.ok(/refuseUnsendableApiOtpPhone\('app_patient'\), otpPhoneScope, otpSendCooldown, otpSendCap/.test(read('src/routes/api/auth.js')));
    const doc = read('src/routes/api/doctor_auth.js');
    assert.ok(/refuseUnsendableApiOtpPhone\('app_doctor', storeReview\.isReviewPhone\), otpPhoneScope/.test(doc));
    assert.strictEqual((doc.match(/const fullPhone = doctorOtpPhone\(phone, countryCode\);/g) || []).length, 2, 'send and verify share one derivation');
  });

  await check('D3: the delete-account sends (web and app) are gated on the stored number', () => {
    assert.ok(/sendable\.ok \? await sendOtpViaTwilio\(phone\) : null/.test(read('src/routes/patient.js')));
    assert.ok(/if \(!sendable\.ok\) logRejectedOtpPhone\('app_delete_account', sendable\);/.test(read('src/routes/api/profile.js')));
  });

  await check('D4: the save paths (register, onboarding, profile, app register, app profile) add the Egyptian-mobile check', () => {
    for (const f of ['src/routes/auth.js', 'src/routes/onboarding.js', 'src/routes/patient.js', 'src/routes/api/auth.js', 'src/routes/api/profile.js']) {
      assert.ok(/if \(phoneCheck\.ok\) phoneCheck = (require\([^)]*otp_phone_guard'\)\.)?checkOtpPhone\(phoneCheck\.normalized, null,/.test(read(f)), f);
    }
  });
})();
