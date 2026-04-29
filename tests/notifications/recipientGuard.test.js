// tests/notifications/recipientGuard.test.js
// Tests for the email recipient guard. Mocks the MX resolver so no real DNS
// lookups happen during testing.

const path = require('path');
const t = global._testRunner || {
  pass: (n) => console.log('  PASS ' + n),
  fail: (n, e) => { console.error('  FAIL ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  SKIP ' + n + ' (' + r + ')'),
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\nRecipient guard tests\n');

(async () => {
  process.env.EMAIL_GUARD_STRICT = 'true';
  // Force a fresh require so STRICT is read clean
  delete require.cache[require.resolve('../../src/services/recipientGuard')];
  const guard = require('../../src/services/recipientGuard');
  const { validateRecipient, BlockedRecipientError, _setMxResolver, _clearMxCache } = guard;

  // Default mock: only tashkheesa.com has MX; everything else fails.
  function installDefaultMx() {
    _setMxResolver(async (domain) => {
      if (domain === 'tashkheesa.com') {
        return [{ exchange: 'mx.tashkheesa.com', priority: 10 }];
      }
      const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
    });
    _clearMxCache();
  }
  installDefaultMx();

  async function expectBlock(email, expectedReasonPrefix, label) {
    try {
      await validateRecipient(email);
      t.fail(fileTag + ': ' + label, new Error('expected to block but did not throw'));
    } catch (err) {
      if (!(err instanceof BlockedRecipientError)) {
        t.fail(fileTag + ': ' + label, err);
        return;
      }
      if (expectedReasonPrefix && !err.reason.startsWith(expectedReasonPrefix)) {
        t.fail(fileTag + ': ' + label + ' — expected reason ~ ' + expectedReasonPrefix + ', got ' + err.reason, err);
        return;
      }
      t.pass(fileTag + ': ' + label + ' (' + err.reason + ')');
    }
  }

  async function expectPass(email, label) {
    try {
      await validateRecipient(email);
      t.pass(fileTag + ': ' + label);
    } catch (err) {
      t.fail(fileTag + ': ' + label, err);
    }
  }

  // ── Required scenarios from the bug report ───────────────────────────────
  await expectBlock('p.demo-ahmed.tamer-abdelaziz@demo.local', 'blocked_domain',
    'p.demo-...@demo.local is blocked');
  await expectBlock('test@example.com', 'blocked_domain',
    'test@example.com is blocked');
  await expectPass('ziad@tashkheesa.com',
    'real address ziad@tashkheesa.com passes');
  await expectBlock(null, 'missing_or_empty', 'null is blocked');
  await expectBlock(undefined, 'missing_or_empty', 'undefined is blocked');
  await expectBlock('', 'missing_or_empty', 'empty string is blocked');

  // ── Additional rule coverage ─────────────────────────────────────────────
  await expectBlock('not-an-email', 'malformed', 'malformed (no @)');
  await expectBlock('foo@bar', 'malformed', 'malformed (no TLD)');
  await expectBlock('user@example.org', 'blocked_domain', 'example.org domain');
  await expectBlock('user@example.net', 'blocked_domain', 'example.net domain');
  await expectBlock('user@test.com', 'blocked_domain', 'test.com domain');
  // 'user@localhost' has no dot in the domain → caught by malformed regex
  // before the blocklist, but still blocked. 'foo@localhost.example' would
  // hit the literal 'localhost' branch only if it were a full domain; the
  // bare 'localhost' is exercised here to confirm the *outcome* is a block.
  await expectBlock('user@localhost', 'malformed', 'bare localhost is blocked (as malformed)');
  await expectBlock('user@anything.local', 'blocked_tld', '.local TLD');
  await expectBlock('user@anything.test', 'blocked_tld', '.test TLD');
  await expectBlock('user@anything.invalid', 'blocked_tld', '.invalid TLD');

  // Demo patient pattern even on a real domain
  await expectBlock('p.demo-ahmed@gmail.com', 'demo_patient_pattern',
    'p.demo- pattern blocked even on gmail');
  await expectBlock('P.Demo-XYZ@gmail.com', 'demo_patient_pattern',
    'p.demo- pattern is case-insensitive');

  // Test prefix rules
  await expectBlock('test@gmail.com', 'test_local_prefix:test', 'exact "test" local-part');
  await expectBlock('test.user@gmail.com', 'test_local_prefix:test', 'test. prefix');
  await expectBlock('demo-account@gmail.com', 'test_local_prefix:demo', 'demo- prefix');
  await expectBlock('fake_user@gmail.com', 'test_local_prefix:fake', 'fake_ prefix');
  await expectBlock('dummy.tester@gmail.com', 'test_local_prefix:dummy', 'dummy. prefix');
  await expectBlock('noreply-test@gmail.com', 'test_local_prefix:noreply-test', 'noreply-test exact');

  // Stricter prefix rule must NOT block real names that merely start with letters
  // matching a prefix (Egyptian/Arabic names, demolisher, tester, demos, etc.)
  // tashkheesa.com is the only domain in the mock with valid MX.
  await expectPass('tester@tashkheesa.com', 'real word "tester" not blocked');
  await expectPass('demolisher@tashkheesa.com', 'real word "demolisher" not blocked');
  await expectPass('demos@tashkheesa.com', 'real word "demos" not blocked');
  await expectPass('dummies@tashkheesa.com', 'real word "dummies" not blocked');

  // ── MX failure path (strict mode) ────────────────────────────────────────
  await expectBlock('user@nonexistent-zzz-xyz.com', 'no_mx_record',
    'no MX record blocks in strict mode');

  // ── Non-strict mode skips MX, still blocks hardcoded ─────────────────────
  process.env.EMAIL_GUARD_STRICT = 'false';
  _clearMxCache();
  await expectPass('user@nonexistent-zzz-xyz.com',
    'non-strict mode skips MX lookup');
  await expectBlock('user@demo.local', 'blocked_domain',
    'non-strict mode still blocks hardcoded domain');
  await expectBlock('p.demo-x@gmail.com', 'demo_patient_pattern',
    'non-strict mode still blocks demo patient pattern');
  process.env.EMAIL_GUARD_STRICT = 'true';

  // ── MX cache: same domain should not re-resolve ──────────────────────────
  _clearMxCache();
  let resolveCount = 0;
  _setMxResolver(async (domain) => {
    resolveCount++;
    if (domain === 'cached-ok.example-real.com') {
      return [{ exchange: 'mx.cached-ok.example-real.com', priority: 10 }];
    }
    const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
  });
  await validateRecipient('a@cached-ok.example-real.com');
  await validateRecipient('b@cached-ok.example-real.com');
  await validateRecipient('c@cached-ok.example-real.com');
  if (resolveCount === 1) {
    t.pass(fileTag + ': MX resolver called once across 3 sends to same domain');
  } else {
    t.fail(fileTag + ': MX cache (expected 1 call, got ' + resolveCount + ')', new Error('cache miss'));
  }

  installDefaultMx();
})().catch((err) => {
  t.fail(fileTag + ': test harness crashed', err);
});
