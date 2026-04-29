// tests/notifications/emailService.guard.test.js
// Integration test for the recipientGuard wiring in emailService.js.
// Verifies that all three send paths (sendEmail, sendRawEmail, sendMail) route
// through the guard before reaching the underlying transporter, log blocked
// recipients to blocked_send_attempts, and skip blocked recipients in batches.

var path = require('path');
var t = global._testRunner || {
  pass: function(n) { console.log('  PASS ' + n); },
  fail: function(n, e) { console.error('  FAIL ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function(n, r) { console.log('  SKIP ' + n + ' (' + r + ')'); }
};
var fileTag = path.basename(__filename, '.test.js');

console.log('\nemailService recipient-guard integration tests\n');

(async function () {
  // Required env state. Email must be enabled (otherwise sendEmail
  // short-circuits before reaching the transporter), and SMTP_PASS must
  // be set (otherwise sendMail() stubs out at the top).
  process.env.EMAIL_ENABLED = 'true';
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.SMTP_USER = 'test-user';
  process.env.SMTP_PASS = 'test-pass';
  process.env.EMAIL_GUARD_STRICT = 'true';

  // Force a fresh require so env reads at module-load time are clean.
  delete require.cache[require.resolve('../../src/services/recipientGuard')];
  delete require.cache[require.resolve('../../src/services/emailService')];

  var guard = require('../../src/services/recipientGuard');
  var emailService = require('../../src/services/emailService');

  // Mock MX resolver: only tashkheesa.com resolves.
  guard._setMxResolver(async function (domain) {
    if (domain === 'tashkheesa.com') {
      return [{ exchange: 'mx.tashkheesa.com', priority: 10 }];
    }
    var err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
  });
  guard._clearMxCache();

  // Build a fake transporter and a fake pg pool to capture all I/O.
  var sendCalls = [];
  var fakeTransporter = {
    sendMail: async function (opts) {
      sendCalls.push(opts);
      return { messageId: 'fake-' + sendCalls.length, accepted: [opts.to], rejected: [] };
    },
    verify: async function () { return true; }
  };
  var poolInserts = [];
  var fakePool = {
    query: async function (sql, params) {
      poolInserts.push({ sql: sql, params: params });
      return { rows: [] };
    }
  };

  function reset() {
    sendCalls.length = 0;
    poolInserts.length = 0;
    emailService._setTestPool(fakePool);
    emailService._setTestTransporter(fakeTransporter);
    guard._clearMxCache();
  }

  function assert(cond, label, detail) {
    if (cond) {
      t.pass(fileTag + ': ' + label);
    } else {
      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
    }
  }

  // ── 1. sendEmail blocks demo.local ─────────────────────────────────────
  reset();
  var r1 = await emailService.sendEmail({
    to: 'p.demo-ahmed.tamer@demo.local',
    subject: 'Reassignment notice',
    template: null,
    data: { plainText: 'hello' }
  });
  assert(sendCalls.length === 0, 'sendEmail: transporter NOT called for demo.local',
    'transporter was called ' + sendCalls.length + ' times');
  assert(r1 && r1.ok === false && r1.blocked === true, 'sendEmail: returns { ok:false, blocked:true }',
    JSON.stringify(r1));
  assert(poolInserts.length === 1, 'sendEmail: 1 insert into blocked_send_attempts',
    'got ' + poolInserts.length + ' inserts');
  assert(poolInserts[0] && poolInserts[0].params && poolInserts[0].params[0] === 'p.demo-ahmed.tamer@demo.local',
    'sendEmail: blocked email recorded with full address');

  // ── 2. sendRawEmail blocks example.com ─────────────────────────────────
  reset();
  var r2 = await emailService.sendRawEmail({
    to: 'someone@example.com',
    subject: 'Raw blocked',
    html: '<p>x</p>',
    text: 'x'
  });
  assert(sendCalls.length === 0, 'sendRawEmail: transporter NOT called for example.com',
    'transporter was called ' + sendCalls.length + ' times');
  assert(r2 && r2.ok === false && r2.blocked === true, 'sendRawEmail: returns { ok:false, blocked:true }',
    JSON.stringify(r2));
  assert(poolInserts.length === 1, 'sendRawEmail: 1 insert into blocked_send_attempts',
    'got ' + poolInserts.length + ' inserts');

  // ── 3. sendMail (lifecycle low-level) blocks test.com ──────────────────
  reset();
  var r3 = await emailService.sendMail({
    to: 'qa.user@test.com',
    subject: 'Lifecycle',
    text: 'hi',
    html: '<p>hi</p>'
  });
  assert(sendCalls.length === 0, 'sendMail: transporter NOT called for test.com',
    'transporter was called ' + sendCalls.length + ' times');
  assert(r3 && r3.ok === false && r3.blocked === true, 'sendMail: returns { ok:false, blocked:true }',
    JSON.stringify(r3));
  assert(poolInserts.length === 1, 'sendMail: 1 insert into blocked_send_attempts',
    'got ' + poolInserts.length + ' inserts');

  // ── 4. notifyCaseReassigned (the wrapper that fired the April 28 leak) ─
  // Confirms the lifecycle wrappers inherit the guard for free via sendMail.
  reset();
  var r4 = await emailService.notifyCaseReassigned(
    { email: 'p.demo-ahmed.nour@demo.local', name: 'Demo Patient' },
    'TSH-2026-DEMO-N02'
  );
  assert(sendCalls.length === 0, 'notifyCaseReassigned: transporter NOT called for demo.local',
    'transporter was called ' + sendCalls.length + ' times');
  assert(r4 && r4.ok === false && r4.blocked === true,
    'notifyCaseReassigned: returns { ok:false, blocked:true }', JSON.stringify(r4));

  // ── 5. Real address proceeds to the transporter ────────────────────────
  reset();
  var r5 = await emailService.sendEmail({
    to: 'ziad@tashkheesa.com',
    subject: 'Real send',
    template: null,
    data: { plainText: 'ok' }
  });
  assert(sendCalls.length === 1, 'sendEmail: transporter called for real address',
    'transporter calls = ' + sendCalls.length);
  assert(r5 && r5.ok === true, 'sendEmail: returns { ok:true } for real recipient', JSON.stringify(r5));
  assert(poolInserts.length === 0, 'sendEmail: no blocked_send_attempts insert for real recipient',
    'inserts = ' + poolInserts.length);

  // ── 6. Batch: mixed allowed + blocked → only allowed reaches transporter
  reset();
  var r6 = await emailService.sendRawEmail({
    to: ['ziad@tashkheesa.com', 'fake@demo.local', 'team@tashkheesa.com'],
    subject: 'Batch',
    html: '<p>batch</p>',
    text: 'batch'
  });
  assert(sendCalls.length === 1, 'batch: transporter called once with filtered list',
    'calls = ' + sendCalls.length);
  if (sendCalls.length === 1) {
    var sentTo = sendCalls[0].to;
    var sentList = Array.isArray(sentTo) ? sentTo : [sentTo];
    assert(sentList.indexOf('fake@demo.local') === -1,
      'batch: blocked recipient removed from transporter "to"',
      'sent list: ' + JSON.stringify(sentList));
    assert(sentList.indexOf('ziad@tashkheesa.com') !== -1 && sentList.indexOf('team@tashkheesa.com') !== -1,
      'batch: both allowed recipients survived',
      'sent list: ' + JSON.stringify(sentList));
  }
  assert(poolInserts.length === 1, 'batch: 1 blocked recipient logged',
    'inserts = ' + poolInserts.length);
  assert(r6 && r6.ok === true, 'batch: caller sees ok:true (some succeeded)', JSON.stringify(r6));

  // ── 7. Comma-separated to-string is also parsed ────────────────────────
  reset();
  var r7 = await emailService.sendRawEmail({
    to: 'ziad@tashkheesa.com, demo.user@demo.local',
    subject: 'Comma list',
    html: '<p>x</p>',
    text: 'x'
  });
  assert(sendCalls.length === 1, 'comma-list: transporter called once', 'calls = ' + sendCalls.length);
  assert(poolInserts.length === 1, 'comma-list: blocked recipient logged once',
    'inserts = ' + poolInserts.length);
  assert(r7 && r7.ok === true, 'comma-list: caller sees ok:true', JSON.stringify(r7));

  // ── 8. Empty/missing to short-circuits at the public API, not the guard ─
  reset();
  var r8 = await emailService.sendEmail({
    to: '',
    subject: 'Empty to',
    template: null
  });
  assert(sendCalls.length === 0, 'empty to: transporter not called', 'calls = ' + sendCalls.length);
  assert(r8 && r8.ok === false && r8.error === 'missing_to_or_subject',
    'empty to: rejected with missing_to_or_subject', JSON.stringify(r8));

  // Reset so we don't leave state for adjacent tests.
  emailService._setTestTransporter(null);
  emailService._setTestPool(null);
  emailService._resetTransporter();
})().catch(function (err) {
  t.fail(fileTag + ': test harness crashed', err);
});
