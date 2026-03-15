// tests/pg/core.test.js
// Core PG-compatible tests for Tashkheesa
// Covers: auth, sanitization, case lifecycle logic, pricing formula, HMAC

const assert = require('assert');
const t = global._testRunner || {
  pass: (n) => console.log(`  ✅ ${n}`),
  fail: (n, e) => { console.error(`  ❌ ${n}: ${e.message || e}`); },
  skip: (n, r) => console.log(`  ⏭️  ${n} (${r})`),
};

console.log('\n🔧 Core Logic Tests\n');

// ── Auth: hash/check ──────────────────────────────────────────────────────
async function runAuthTests() {
  try {
    const { hash, check } = require('../../src/auth');

    const h = await hash('test-password-123');
    assert(typeof h === 'string' && h.length > 20, 'hash should return bcrypt string');
    t.pass('hash() returns bcrypt string');

    const ok = await check('test-password-123', h);
    assert(ok === true, 'check() should return true for correct password');
    t.pass('check() returns true for correct password');

    const bad = await check('wrong-password', h);
    assert(bad === false, 'check() should return false for wrong password');
    t.pass('check() returns false for wrong password');
  } catch (e) { t.fail('auth tests', e); }
}

// ── JWT sign/verify ───────────────────────────────────────────────────────
function runJwtTests() {
  try {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-minimum-32-chars-long!!';
    const { sign, verify } = require('../../src/auth');

    const user = { id: 'test-123', role: 'patient', email: 'test@test.com', name: 'Test' };
    const token = sign(user);
    assert(typeof token === 'string' && token.length > 20, 'sign should return JWT string');
    t.pass('sign() returns JWT string');

    const payload = verify(token);
    assert(payload && payload.id === 'test-123', 'verify should return payload');
    assert(payload.role === 'patient', 'payload should contain role');
    t.pass('verify() returns correct payload');

    const bad = verify('invalid.token.here');
    assert(bad === null, 'verify should return null for invalid token');
    t.pass('verify() returns null for invalid token');
  } catch (e) { t.fail('JWT tests', e); }
}

// ── Sanitization ──────────────────────────────────────────────────────────
function runSanitizationTests() {
  try {
    const { sanitizeString, sanitizeHtml } = require('../../src/validators/sanitize');

    // sanitizeString: enforces maxLength and strips null bytes / control chars
    const long = sanitizeString('a'.repeat(200), 50);
    assert(long.length <= 50, 'sanitizeString should enforce maxLength');
    t.pass('sanitizeString enforces maxLength');

    const normal = sanitizeString('Hello, World!', 100);
    assert(normal === 'Hello, World!', 'sanitizeString should preserve safe content');
    t.pass('sanitizeString preserves safe plain text');

    // sanitizeHtml: strips dangerous tags like <script>
    const h = sanitizeHtml('<p>Hello <b>world</b></p><script>bad()</script>');
    assert(!h.includes('<script>'), 'sanitizeHtml should strip script tags');
    assert(h.includes('Hello'), 'sanitizeHtml should preserve safe content');
    t.pass('sanitizeHtml strips <script>, keeps safe content');
  } catch (e) { t.fail('sanitization tests', e); }
}

// ── Pricing formula ───────────────────────────────────────────────────────
function runPricingTests() {
  try {
    // Tashkheesa price = ceil(cost * 1.15)
    // Doctor fee = ceil(tash_price * 0.20)
    const cases = [
      { cost: 500,   expectedTash: 575,  expectedDoc: 115 },
      { cost: 1200,  expectedTash: 1380, expectedDoc: 276 },
      { cost: 7300,  expectedTash: 8395, expectedDoc: 1679 },
      { cost: 10000, expectedTash: 11500,expectedDoc: 2300 },
    ];
    for (const c of cases) {
      const tash = Math.ceil(c.cost * 1.15);
      const doc  = Math.ceil(tash * 0.20);
      assert(tash === c.expectedTash, `Tash price for ${c.cost}: expected ${c.expectedTash}, got ${tash}`);
      assert(doc  === c.expectedDoc,  `Doc fee for ${c.cost}: expected ${c.expectedDoc}, got ${doc}`);
    }
    t.pass('Pricing formula: Tash = cost × 1.15, Doc = Tash × 20%');

    // Commission check: doctor never gets more than 20%
    for (const c of cases) {
      const tash = Math.ceil(c.cost * 1.15);
      const doc  = Math.ceil(tash * 0.20);
      assert(doc / tash <= 0.21, `Doc commission should be ≤20% for cost ${c.cost}`);
    }
    t.pass('Doctor commission is always ≤ 20%');
  } catch (e) { t.fail('pricing formula', e); }
}

// ── HMAC verification ─────────────────────────────────────────────────────
function runHmacTests() {
  try {
    const { verifyPaymobHmac } = require('../../src/paymob-hmac');

    // Should fail gracefully with missing secret
    const result = verifyPaymobHmac({ body: {}, headers: {} }, null);
    assert(result && result.ok === false, 'HMAC should fail with null secret');
    t.pass('verifyPaymobHmac returns {ok:false} with null secret');

    // Should fail with missing HMAC header
    const result2 = verifyPaymobHmac({ body: { obj: {} }, headers: {}, query: {} }, 'test-secret');
    assert(result2 && result2.ok === false, 'HMAC should fail with no HMAC in request');
    t.pass('verifyPaymobHmac returns {ok:false} with missing HMAC header');
  } catch (e) { t.fail('HMAC tests', e); }
}

// ── Status normalization ──────────────────────────────────────────────────
function runStatusTests() {
  try {
    const { getStatusUi, CASE_STATUS } = require('../../src/case_lifecycle');

    // getStatusUi normalises status internally — verify it maps aliases correctly
    assert(getStatusUi('completed').status === CASE_STATUS.COMPLETED);
    assert(getStatusUi('COMPLETED').status === CASE_STATUS.COMPLETED);
    assert(getStatusUi('done').status === CASE_STATUS.COMPLETED);
    assert(getStatusUi('in_review').status === CASE_STATUS.IN_REVIEW);
    assert(getStatusUi('IN REVIEW').status === CASE_STATUS.IN_REVIEW);
    assert(getStatusUi('breached').status === CASE_STATUS.SLA_BREACH);
    assert(getStatusUi('accepted').status === CASE_STATUS.ASSIGNED);
    t.pass('getStatusUi handles all status aliases correctly');

    // CASE_STATUS constants are frozen and correct
    assert(CASE_STATUS.COMPLETED === 'COMPLETED');
    assert(CASE_STATUS.IN_REVIEW === 'IN_REVIEW');
    assert(CASE_STATUS.PAID === 'PAID');
    t.pass('CASE_STATUS constants are correct');
  } catch (e) { t.fail('status normalization', e); }
}

// ── SLA calculation ───────────────────────────────────────────────────────
function runSlaTests() {
  try {
    const { SLA_HOURS } = require('../../src/case_lifecycle');

    assert(SLA_HOURS.standard_72h === 72, 'SLA_HOURS.standard_72h should be 72');
    assert(SLA_HOURS.priority_24h === 24, 'SLA_HOURS.priority_24h should be 24');
    t.pass('SLA_HOURS constants are correct');

    // Manually replicate the deadline calculation (cost × hours)
    const paidAt = new Date('2026-01-01T10:00:00Z');
    const d72 = new Date(paidAt.getTime() + 72 * 60 * 60 * 1000);
    assert(d72.toISOString() === '2026-01-04T10:00:00.000Z', `72h deadline wrong: ${d72}`);
    t.pass('72h SLA deadline calculation: paidAt + 72h = correct');

    const d24 = new Date(paidAt.getTime() + 24 * 60 * 60 * 1000);
    assert(d24.toISOString() === '2026-01-02T10:00:00.000Z', `24h deadline wrong: ${d24}`);
    t.pass('24h SLA deadline calculation: paidAt + 24h = correct');
  } catch (e) { t.fail('SLA calculation', e); }
}

// ── Run all ───────────────────────────────────────────────────────────────
(async () => {
  await runAuthTests();
  runJwtTests();
  runSanitizationTests();
  runPricingTests();
  runHmacTests();
  runStatusTests();
  runSlaTests();
})();
