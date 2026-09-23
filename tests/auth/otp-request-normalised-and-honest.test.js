// tests/auth/otp-request-normalised-and-honest.test.js
//
// AUDIT-AUTH-3 / NEW-AUTH-1 (2026-09-23) — POST /api/v1/auth/otp/request.
//
// Two defects, one route:
//   1. The code was sent to a raw `countryCode + phone` concatenation. The
//      ordinary Egyptian '01012345678' became '+2001012345678'; the app's
//      delete-account screen (stored '+2010…' plus countryCode '+20') became
//      '+20+2010…'. Twilio refused both.
//   2. The route answered 200 "OTP sent" whatever Twilio said.
//
// Drives the REAL router with an in-memory fake of the SQL it issues and a
// recording sendOtpViaTwilio. Pins: every accepted spelling is delivered to
// the same E.164 string; a refused send is 502 OTP_SEND_FAILED; /otp/verify
// checks the code under that same string.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'otp-honest-test-secret';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'),
};

console.log('\n📲 AUTH-3 — /otp/request normalises the number and reports send failures\n');

if (process.env.TWILIO_VERIFY_SERVICE_SID) {
  t.skip('otp-request tests', 'TWILIO_VERIFY_SERVICE_SID is set — the otp_codes fallback path is unavailable');
  return;
}

const assert = require('assert');
const http = require('http');
const express = require('express');

const otps = [];
const sends = [];
let nextSend = { ok: true, status: 'pending' };

function norm(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }
async function fakeQuery(sql, params = []) {
  const q = norm(sql);
  if (q.startsWith('INSERT INTO otp_codes')) {
    for (let i = otps.length - 1; i >= 0; i--) if (otps[i].phone === params[0]) otps.splice(i, 1);
    otps.push({ phone: params[0], code: params[1], expires_at: params[2] });
    return { rowCount: 1, rows: [] };
  }
  if (q.startsWith('SELECT * FROM otp_codes WHERE phone = $1 AND code = $2')) {
    return otps.filter((o) => o.phone === params[0] && o.code === params[1]);
  }
  if (q.startsWith('DELETE FROM otp_codes WHERE phone = $1')) {
    for (let i = otps.length - 1; i >= 0; i--) if (otps[i].phone === params[0]) otps.splice(i, 1);
    return { rowCount: 1, rows: [] };
  }
  // Anything past the code check (identity resolution) is out of scope here:
  // answering "no rows" makes a successful check fall through harmlessly.
  return [];
}
const helpers = {
  safeGet: async (s, p) => { const r = await fakeQuery(s, p); return Array.isArray(r) ? (r[0] || null) : null; },
  safeAll: async (s, p) => { const r = await fakeQuery(s, p); return Array.isArray(r) ? r : []; },
  safeRun: async (s, p) => { const r = await fakeQuery(s, p); return Array.isArray(r) ? { rowCount: r.length, rows: r } : r; },
  sendOtpViaTwilio: async (phone) => {
    sends.push(phone);
    if (nextSend === 'throw') throw new Error('network down');
    return nextSend;
  },
};

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use(express.json());
app.use('/auth', require('../../src/routes/api/auth')({}, helpers));
app.use((err, req, res, _next) => res.fail(err.message || 'boom', 500, 'TEST_UNCAUGHT'));

let server;
let base;
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  try {
    // Distinct numbers per case: the per-phone send cooldown is real here.
    const spellings = [
      ['local with trunk 0', '01012345601', '+201012345601'],
      ['local without trunk 0', '1012345602', '+201012345602'],
      ['full E.164 plus countryCode (the delete-account shape)', '+201012345603', '+201012345603'],
      ['dial code glued to the trunk 0', '201012345604', '+201012345604'],
    ];
    for (const [label, typed, want] of spellings) {
      await check('otp/request: ' + label + ' is delivered to ' + want, async () => {
        nextSend = { ok: true, status: 'pending' };
        const before = sends.length;
        const r = await post('/auth/otp/request', { phone: typed, countryCode: '+20' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(sends.length, before + 1, 'exactly one send');
        assert.strictEqual(sends[sends.length - 1], want);
        assert.ok(otps.some((o) => o.phone === want), 'local code stored under the normalised number');
      });
    }

    await check('otp/request: a Twilio refusal is 502 OTP_SEND_FAILED, not a fake 200', async () => {
      nextSend = { ok: false, error: 'Invalid parameter `To`' };
      const r = await post('/auth/otp/request', { phone: '01012345605', countryCode: '+20' });
      assert.strictEqual(r.status, 502, JSON.stringify(r.body));
      assert.strictEqual(r.body && r.body.code, 'OTP_SEND_FAILED');
      assert.strictEqual(r.body.success, false);
    });

    await check('otp/request: a sender that throws is 502 OTP_SEND_FAILED', async () => {
      nextSend = 'throw';
      const r = await post('/auth/otp/request', { phone: '01012345606', countryCode: '+20' });
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.body.code, 'OTP_SEND_FAILED');
    });

    await check('otp/request: an unparseable number is 422 PHONE_INVALID and nothing is sent', async () => {
      nextSend = { ok: true };
      const before = sends.length;
      const r = await post('/auth/otp/request', { phone: '12', countryCode: '+20' });
      assert.strictEqual(r.status, 422, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'PHONE_INVALID');
      assert.strictEqual(sends.length, before);
    });

    await check('otp/verify: the code is checked under the SAME normalised number the request used', async () => {
      const code = (otps.find((o) => o.phone === '+201012345601') || {}).code;
      assert.ok(code, 'request stored a code');
      // Typed differently from the request (no trunk 0) — still the same number.
      const r = await post('/auth/otp/verify', { phone: '1012345601', countryCode: '+20', otp: code });
      assert.notStrictEqual(r.body && r.body.code, 'INVALID_OTP', 'code rejected: ' + JSON.stringify(r.body));
      assert.ok(!otps.some((o) => o.phone === '+201012345601'), 'used code deleted');
    });
  } finally {
    server.close();
  }
})();
