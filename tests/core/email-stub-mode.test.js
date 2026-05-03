// tests/core/email-stub-mode.test.js
//
// P1-NOTIF-3 Tier 1 tests:
//   1. EMAIL_TEST_STUB=true short-circuits sendEmail before EMAIL_ENABLED
//   2. EMAIL_TEST_STUB=true short-circuits sendRawEmail before EMAIL_ENABLED
//   3. Stub returns { ok:true, stubbed:true, to, template, lang }
//   4. Stub does NOT touch the transporter (transporter sendMail is never called)
//   5. error_logs receives a row when transport throws (category='email_send')
//   6. error_logs receives a row when getTransporter() returns null
//      (email_not_configured operational soft-fail)
//
// Pure-JS test — no server boot, no real DB, no real Resend SDK. Uses
// emailService's _setTestTransporter + _setTestPool seams.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n📨 P1-NOTIF-3 EMAIL_TEST_STUB + error_logs integration\n');

(async function run() {
  // Save env so we can restore at the end (other tests may rely on these).
  const savedStub = process.env.EMAIL_TEST_STUB;
  const savedEnabled = process.env.EMAIL_ENABLED;
  const savedKey = process.env.RESEND_API_KEY;

  // Force a fresh require so module-level reads are clean.
  delete require.cache[require.resolve('../../src/services/recipientGuard')];
  delete require.cache[require.resolve('../../src/services/emailService')];

  const emailService = require('../../src/services/emailService');

  // Capture all transporter calls so we can assert the stub never touches it.
  const sendCalls = [];
  const fakeTransporter = {
    sendMail: async function (opts) {
      sendCalls.push(opts);
      return { messageId: 'fake-' + sendCalls.length, accepted: [opts.to], rejected: [] };
    },
    verify: async function () { return true; }
  };

  // Capture pg writes so we can assert error_logs row format.
  const poolCalls = [];
  const fakePool = {
    query: async function (sql, params) {
      poolCalls.push({ sql, params });
      return { rows: [] };
    }
  };

  function reset() {
    sendCalls.length = 0;
    poolCalls.length = 0;
    emailService._setTestTransporter(fakeTransporter);
    emailService._setTestPool(fakePool);
  }

  function assert(cond, label, detail) {
    if (cond) t.pass(fileTag + ': ' + label);
    else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
  }

  try {
    // ── 1. sendEmail stub short-circuit ─────────────────────────────────
    reset();
    process.env.EMAIL_TEST_STUB = 'true';
    // EMAIL_ENABLED is intentionally NOT set — stub must override the
    // disabled-state gate, otherwise tests can't assert dispatch wiring
    // when the deployment leaves email disabled by default.
    delete process.env.EMAIL_ENABLED;
    const r1 = await emailService.sendEmail({
      to: 'patient@tashkheesa.com',
      subject: 'Test',
      template: 'doctor-welcome',
      lang: 'en',
      data: {}
    });
    assert(r1 && r1.ok === true, 'sendEmail stub: returns ok=true', JSON.stringify(r1));
    assert(r1 && r1.stubbed === true, 'sendEmail stub: stubbed=true flag set', JSON.stringify(r1));
    assert(r1 && r1.to === 'patient@tashkheesa.com', 'sendEmail stub: echoes to', JSON.stringify(r1));
    assert(r1 && r1.template === 'doctor-welcome', 'sendEmail stub: echoes template', JSON.stringify(r1));
    assert(r1 && r1.lang === 'en', 'sendEmail stub: echoes lang', JSON.stringify(r1));
    assert(sendCalls.length === 0, 'sendEmail stub: transporter NEVER called',
      'transporter calls = ' + sendCalls.length);

    // ── 2. sendRawEmail stub short-circuit ──────────────────────────────
    reset();
    process.env.EMAIL_TEST_STUB = 'true';
    const r2 = await emailService.sendRawEmail({
      to: 'patient@tashkheesa.com',
      subject: 'Raw test',
      html: '<p>x</p>',
      text: 'x'
    });
    assert(r2 && r2.ok === true, 'sendRawEmail stub: returns ok=true', JSON.stringify(r2));
    assert(r2 && r2.stubbed === true, 'sendRawEmail stub: stubbed=true flag set', JSON.stringify(r2));
    assert(sendCalls.length === 0, 'sendRawEmail stub: transporter NEVER called',
      'transporter calls = ' + sendCalls.length);

    // ── 3. Stub overrides EMAIL_ENABLED=false ───────────────────────────
    // Critical for test envs where EMAIL_ENABLED is not set in CI but we
    // still want to verify dispatch wiring fires.
    reset();
    process.env.EMAIL_TEST_STUB = 'true';
    process.env.EMAIL_ENABLED = 'false';
    const r3 = await emailService.sendEmail({
      to: 'patient@tashkheesa.com',
      subject: 'Test',
      template: 'doctor-welcome',
      lang: 'ar',
      data: {}
    });
    assert(r3 && r3.ok === true && r3.stubbed === true,
      'stub overrides EMAIL_ENABLED=false (ok+stubbed)', JSON.stringify(r3));

    // ── 4. Gate is strict: EMAIL_TEST_STUB=false (string) must NOT stub ──
    // The gate compares lowercase to literal 'true'. Verify a non-'true'
    // value does not accidentally enable stub mode (catches env typos like
    // `1`, `on`, `yes`, `false`).
    reset();
    process.env.EMAIL_TEST_STUB = 'false';
    const r4a = await emailService.sendEmail({
      to: 'ziad@tashkheesa.com',
      subject: 'Stub off',
      template: null,
      data: { plainText: 'hi' }
    });
    assert(!r4a.stubbed, 'gate strict: EMAIL_TEST_STUB=false does NOT stub', JSON.stringify(r4a));
    assert(sendCalls.length === 1, 'gate strict: real transporter IS called when stub off',
      'transporter calls = ' + sendCalls.length);

    reset();
    process.env.EMAIL_TEST_STUB = '1';
    const r4b = await emailService.sendEmail({
      to: 'ziad@tashkheesa.com',
      subject: 'Stub off (1)',
      template: null,
      data: { plainText: 'hi' }
    });
    assert(!r4b.stubbed, 'gate strict: EMAIL_TEST_STUB=1 does NOT stub', JSON.stringify(r4b));

    // ── 5. error_logs row written when transport throws ─────────────────
    // Inject a transporter that throws, force email enabled, then assert
    // the catch-block writes a row with category='email_send', level='error'.
    reset();
    delete process.env.EMAIL_TEST_STUB;
    process.env.EMAIL_ENABLED = 'true';
    process.env.RESEND_API_KEY = 're_test_key';
    const throwingTransporter = {
      sendMail: async function () { throw new Error('simulated_resend_500'); },
      verify: async function () { return true; }
    };
    emailService._setTestTransporter(throwingTransporter);
    const r5 = await emailService.sendEmail({
      to: 'ziad@tashkheesa.com',
      subject: 'Will throw',
      template: null,
      data: { plainText: 'hi' }
    });
    assert(r5 && r5.ok === false && r5.error === 'simulated_resend_500',
      'transport throw: returns ok=false with error', JSON.stringify(r5));
    // The _logEmailError helper fires-and-catches, so give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const errorLogInsert = poolCalls.find(function (c) {
      return c.sql && c.sql.indexOf('INSERT INTO error_logs') !== -1;
    });
    assert(!!errorLogInsert, 'transport throw: error_logs INSERT issued',
      'pool calls: ' + JSON.stringify(poolCalls.map(function (c) {
        return (c.sql || '').slice(0, 60);
      })));
    if (errorLogInsert) {
      const params = errorLogInsert.params || [];
      // [id, level, message, context]
      assert(params[1] === 'error', 'error_logs row: level=error', 'level=' + params[1]);
      assert(params[2] === 'email_send_failed',
        'error_logs row: message=email_send_failed', 'message=' + params[2]);
      assert(/email_send/.test(errorLogInsert.sql),
        'error_logs row: category=email_send (literal in SQL)', errorLogInsert.sql);
      // Recipient must be masked (utility maskEmail produces "z***@t***").
      const ctx = JSON.parse(params[3] || '{}');
      assert(ctx.to && ctx.to.indexOf('@') !== -1 && ctx.to.indexOf('ziad@tashkheesa.com') === -1,
        'error_logs row: recipient masked in context.to', 'ctx.to=' + ctx.to);
      assert(ctx.error === 'simulated_resend_500',
        'error_logs row: error preserved in context', 'ctx.error=' + ctx.error);
    }

    // ── 6. error_logs row when transport not configured ─────────────────
    // Operational soft-fail — getTransporter() returns null when
    // RESEND_API_KEY is missing AND no test transporter is injected.
    reset();
    delete process.env.EMAIL_TEST_STUB;
    process.env.EMAIL_ENABLED = 'true';
    delete process.env.RESEND_API_KEY;
    emailService._resetTransporter(); // clear cached transporter
    emailService._setTestTransporter(null); // ensure no override
    emailService._setTestPool(fakePool);
    const r6 = await emailService.sendEmail({
      to: 'ziad@tashkheesa.com',
      subject: 'No transport',
      template: null,
      data: { plainText: 'hi' }
    });
    assert(r6 && r6.ok === false && r6.error === 'email_not_configured',
      'no transport: returns email_not_configured', JSON.stringify(r6));
    await new Promise((r) => setTimeout(r, 50));
    const opLogInsert = poolCalls.find(function (c) {
      return c.sql && c.sql.indexOf('INSERT INTO error_logs') !== -1
          && (c.params || [])[2] === 'email_not_configured';
    });
    assert(!!opLogInsert,
      'no transport: error_logs INSERT with message=email_not_configured',
      'no matching insert. saw messages: ' +
        poolCalls.map(function (c) { return (c.params || [])[2]; }).filter(Boolean).join(','));

  } finally {
    // Restore env + clear seams so adjacent tests start clean.
    if (savedStub === undefined) delete process.env.EMAIL_TEST_STUB;
    else                          process.env.EMAIL_TEST_STUB = savedStub;
    if (savedEnabled === undefined) delete process.env.EMAIL_ENABLED;
    else                            process.env.EMAIL_ENABLED = savedEnabled;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else                        process.env.RESEND_API_KEY = savedKey;
    try { emailService._setTestTransporter(null); } catch (_) {}
    try { emailService._setTestPool(null); } catch (_) {}
    try { emailService._resetTransporter(); } catch (_) {}
  }
})().catch(function (err) {
  t.fail(fileTag + ': test harness crashed', err);
});
